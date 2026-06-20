// ============================================================
// PLAY16 — Routes Super Admin (v4.1 avec Feature Flags)
// ============================================================
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { query } = require('./pool');
const { authAdmin, authSuperAdmin } = require('./authMiddleware');
const { sendWhatsApp } = require('./NotificationService');
const crypto = require('crypto');

// ── DASHBOARD GLOBAL ────────────────────────────────────────
router.get('/dashboard', authSuperAdmin, async (req, res) => {
  try {
    const storeMode = await query(`SELECT value FROM platform_settings WHERE key = 'play_store_review_mode'`);
    const [users, orders, cashwork, disputes, pendingBoosts] = await Promise.all([
      query(`SELECT COUNT(*) as total, SUM(CASE WHEN created_at > now() - INTERVAL '30 days' THEN 1 ELSE 0 END) as this_month FROM users WHERE deleted_at IS NULL`),
      query(`SELECT COUNT(*) as total, COALESCE(SUM(total_amount),0) as revenue FROM orders`),
      query(`SELECT COUNT(*) as total FROM cash_work_missions WHERE status = 'validated'`),
      query(`SELECT COUNT(*) as open FROM disputes WHERE resolved_at IS NULL`),
      query(`SELECT COUNT(*) as total FROM boost_requests WHERE status = 'pending'`),
    ]);
    res.json({
      play_store_review_mode: storeMode.rows[0]?.value === 'true',
      users: users.rows[0],
      orders: orders.rows[0],
      cashwork: cashwork.rows[0],
      disputes: disputes.rows[0],
      pending_boosts: pendingBoosts.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur dashboard' });
  }
});

// ── CRÉER UN SOUS-ADMIN ─────────────────────────────────────
router.post('/admins', authSuperAdmin, async (req, res) => {
  try {
    const { full_name, role, whatsapp_number } = req.body;
    if (!['admin_ventes','admin_cashwork','admin_externe'].includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide' });
    }
    const hash = await bcrypt.hash('aaaaaaaa', 12);
    const r = await query(
      `INSERT INTO admin_accounts (full_name, role, whatsapp_number, password_hash, must_change_password)
       VALUES ($1,$2,$3,$4,TRUE) RETURNING id, full_name, role, whatsapp_number`,
      [full_name, role, whatsapp_number, hash]
    );
    await sendWhatsApp(whatsapp_number,
      `Bienvenue sur Play16 Admin !\nRole : ${role}\nMot de passe temporaire : aaaaaaaa\nChangez-le a la premiere connexion.`);
    res.json({ success: true, admin: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erreur creation admin' });
  }
});

// ── LISTE SOUS-ADMINS ───────────────────────────────────────
router.get('/admins', authSuperAdmin, async (req, res) => {
  try {
    const r = await query(`SELECT id, full_name, role, whatsapp_number, extended_access, is_active, must_change_password FROM admin_accounts WHERE role != 'super_admin' ORDER BY created_at DESC`);
    res.json({ admins: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erreur liste admins' }); }
});

// ── ACCÈS ÉTENDU ────────────────────────────────────────────
router.put('/admins/:id/extended-access', authSuperAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    await query(`UPDATE admin_accounts SET extended_access = $1 WHERE id = $2 AND role != 'super_admin'`, [!!enabled, req.params.id]);
    const a = await query(`SELECT whatsapp_number FROM admin_accounts WHERE id = $1`, [req.params.id]);
    if (a.rows[0]) await sendWhatsApp(a.rows[0].whatsapp_number, enabled ? `Acces etendu accorde par le Super Admin.` : `Acces etendu revoque.`);
    res.json({ success: true, extended_access: !!enabled });
  } catch (err) { res.status(500).json({ error: 'Erreur acces etendu' }); }
});

// ── MODE SUPERVISION ────────────────────────────────────────
router.post('/supervision/start/:adminId', authSuperAdmin, async (req, res) => {
  try {
    const adminRes = await query(`SELECT id, full_name, role, extended_access FROM admin_accounts WHERE id = $1`, [req.params.adminId]);
    if (!adminRes.rows[0]) return res.status(404).json({ error: 'Admin introuvable' });
    const target = adminRes.rows[0];
    const log = await query(`INSERT INTO supervision_logs (super_admin_id, viewed_admin_id) VALUES ($1,$2) RETURNING id`, [req.admin.id, req.params.adminId]);
    const dash = await getAdminDashboard(target.role, target.extended_access);
    res.json({ success: true, supervision_session_id: log.rows[0].id, viewing_admin: target, mode: 'READ_ONLY', dashboard: dash });
  } catch (err) { res.status(500).json({ error: 'Erreur supervision' }); }
});

router.post('/supervision/end/:sessionId', authSuperAdmin, async (req, res) => {
  try {
    await query(`UPDATE supervision_logs SET ended_at = now() WHERE id = $1 AND super_admin_id = $2`, [req.params.sessionId, req.admin.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erreur fin supervision' }); }
});

// ── SESSIONS ────────────────────────────────────────────────
router.get('/sessions', authSuperAdmin, async (req, res) => {
  try {
    const { admin_id, date } = req.query;
    let where = 'WHERE 1=1'; const params = [];
    if (admin_id) { params.push(admin_id); where += ` AND s.admin_id = $${params.length}`; }
    if (date) { params.push(date); where += ` AND s.started_at::date = $${params.length}::date`; }
    const r = await query(
      `SELECT s.id, s.started_at, s.ended_at, s.whatsapp_number_used, s.ip_address,
              a.full_name as admin_name, a.role, COUNT(sa.id) as action_count
       FROM admin_sessions s JOIN admin_accounts a ON a.id = s.admin_id
       LEFT JOIN admin_session_actions sa ON sa.session_id = s.id
       ${where} GROUP BY s.id, a.full_name, a.role ORDER BY s.started_at DESC LIMIT 100`, params);
    res.json({ sessions: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erreur sessions' }); }
});

router.get('/sessions/:id/actions', authSuperAdmin, async (req, res) => {
  try {
    const r = await query(
      `SELECT sa.*, s.whatsapp_number_used, a.full_name FROM admin_session_actions sa
       JOIN admin_sessions s ON s.id = sa.session_id JOIN admin_accounts a ON a.id = s.admin_id
       WHERE sa.session_id = $1 ORDER BY sa.created_at ASC`, [req.params.id]);
    res.json({ actions: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erreur actions session' }); }
});

// ── RECHERCHE GLOBALE ────────────────────────────────────────
router.get('/search', authSuperAdmin, async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q) return res.status(400).json({ error: 'Terme requis' });
    const results = {};
    if (!type || type === 'order') {
      const r = await query(`SELECT o.id, o.status, o.total_amount, o.created_at, u.full_name as client_name, u.phone_number, p.name as product_name FROM orders o JOIN users u ON u.id = o.client_id JOIN product_variants pv ON pv.id = o.product_variant_id JOIN products p ON p.id = pv.product_id WHERE o.id::text ILIKE $1 OR u.phone_number ILIKE $1 LIMIT 20`, [`%${q}%`]);
      results.orders = r.rows;
    }
    if (!type || type === 'external') {
      const r = await query(`SELECT ep.id, ep.status, ep.amount, ep.seller_whatsapp_number, u.phone_number as buyer_phone FROM external_payments ep JOIN users u ON u.id = ep.buyer_id WHERE ep.id::text ILIKE $1 OR u.phone_number ILIKE $1 LIMIT 20`, [`%${q}%`]);
      results.external_payments = r.rows;
    }
    res.json({ query: q, results });
  } catch (err) { res.status(500).json({ error: 'Erreur recherche' }); }
});

// ── QR LOTS ─────────────────────────────────────────────────
router.post('/qr-lots', authSuperAdmin, async (req, res) => {
  try {
    const { target_buyer_count, rewards } = req.body;
    if (!target_buyer_count || !rewards?.length) return res.status(400).json({ error: 'Données manquantes' });
    const seed = crypto.randomBytes(64).toString('hex');
    const lot = await query(`INSERT INTO qr_lots (created_by_super_admin_id, target_buyer_count, crypto_seed) VALUES ($1,$2,$3) RETURNING *`, [req.admin.id, target_buyer_count, seed]);
    for (const r of rewards) await query(`INSERT INTO qr_lot_rewards (qr_lot_id, reward_type, reward_value, winner_count) VALUES ($1,$2,$3,$4)`, [lot.rows[0].id, r.type, r.value||null, r.winner_count]);
    res.json({ success: true, lot_id: lot.rows[0].id, target_buyer_count, rewards });
  } catch (err) { res.status(500).json({ error: 'Erreur QR lot' }); }
});

router.get('/qr-lots', authSuperAdmin, async (req, res) => {
  try {
    const r = await query(`SELECT ql.*, a.full_name as created_by FROM qr_lots ql LEFT JOIN admin_accounts a ON a.id = ql.created_by_super_admin_id ORDER BY ql.created_at DESC`);
    res.json({ qr_lots: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erreur liste QR lots' }); }
});

// ── CGU ──────────────────────────────────────────────────────
router.get('/cgu/current', async (req, res) => {
  try {
    const r = await query(`SELECT version_number, content, module, published_at FROM cgu_versions WHERE module = 'global' ORDER BY version_number DESC LIMIT 1`);
    res.json(r.rows[0] || { version: 0, content: '', empty: true });
  } catch (err) { res.status(500).json({ error: 'Erreur CGU' }); }
});

router.get('/cgu', authAdmin, async (req, res) => {
  try {
    const r = await query(`SELECT * FROM cgu_versions ORDER BY version_number DESC LIMIT 5`);
    res.json({ versions: r.rows });
  } catch (err) { res.status(500).json({ error: 'Erreur CGU' }); }
});

router.post('/cgu', authSuperAdmin, async (req, res) => {
  try {
    const { content, module = 'global' } = req.body;
    if (!content) return res.status(400).json({ error: 'Contenu requis' });
    const last = await query(`SELECT MAX(version_number) as v FROM cgu_versions WHERE module = $1`, [module]);
    const v = (last.rows[0].v || 0) + 1;
    await query(`INSERT INTO cgu_versions (version_number, content, module, published_by) VALUES ($1,$2,$3,$4)`, [v, content, module, req.admin.id]);
    res.json({ success: true, version: v });
  } catch (err) { res.status(500).json({ error: 'Erreur publication CGU' }); }
});

// ── RAPPORT QUOTIDIEN ────────────────────────────────────────
router.get('/report/daily', authSuperAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [orders, cw, ext, users] = await Promise.all([
      query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as revenue FROM orders WHERE created_at::date = $1`, [today]),
      query(`SELECT COUNT(*) as count FROM cash_work_missions WHERE created_at::date = $1`, [today]),
      query(`SELECT COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM external_payments WHERE created_at::date = $1`, [today]),
      query(`SELECT COUNT(*) as count FROM users WHERE created_at::date = $1`, [today]),
    ]);
    res.json({ date: today, orders: orders.rows[0], cashwork: cw.rows[0], external: ext.rows[0], new_users: users.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erreur rapport' }); }
});

async function getAdminDashboard(role, extendedAccess) {
  const data = {};
  if (role === 'admin_ventes' || extendedAccess) {
    const r = await query(`SELECT COUNT(*) as total, COALESCE(SUM(total_amount),0) as revenue FROM orders WHERE created_at > now() - INTERVAL '30 days'`);
    data.orders = r.rows[0];
  }
  if (role === 'admin_cashwork' || extendedAccess) {
    const r = await query(`SELECT COUNT(*) as total FROM cash_work_missions WHERE created_at > now() - INTERVAL '30 days'`);
    data.missions = r.rows[0];
  }
  if (role === 'admin_externe' || extendedAccess) {
    const r = await query(`SELECT COUNT(*) as total, COALESCE(SUM(amount),0) as total_amount FROM external_payments WHERE status = 'escrowed'`);
    data.external_escrow = r.rows[0];
  }
  return data;
}

module.exports = router;
