// ============================================================
// PLAY16 — Routes Super Admin
// ============================================================
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { query } = require('./pool');
const { authAdmin, authSuperAdmin } = require('./authMiddleware');
const { sendWhatsApp } = require('./NotificationService');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// ── DASHBOARD GLOBAL ────────────────────────────────────────
// GET /api/superadmin/dashboard
router.get('/dashboard', authSuperAdmin, async (req, res) => {
  try {
    const [users, orders, cashwork, disputes, pendingBoosts, pendingRequests] = await Promise.all([
      query(`SELECT COUNT(*) as total,
               SUM(CASE WHEN created_at > now() - INTERVAL '30 days' THEN 1 ELSE 0 END) as this_month
             FROM users WHERE deleted_at IS NULL`),
      query(`SELECT COUNT(*) as total,
               SUM(total_amount) as revenue,
               SUM(CASE WHEN status = 'delivered' THEN total_amount ELSE 0 END) as confirmed_revenue
             FROM orders`),
      query(`SELECT COUNT(*) as total FROM cash_work_missions WHERE status = 'validated'`),
      query(`SELECT COUNT(*) as open FROM disputes WHERE resolved_at IS NULL`),
      query(`SELECT COUNT(*) as total FROM boost_requests WHERE status = 'pending'`),
      query(`SELECT COUNT(*) as total FROM password_change_requests WHERE status = 'pending'`),
    ]);

    res.json({
      users: users.rows[0],
      orders: orders.rows[0],
      cashwork: cashwork.rows[0],
      disputes: disputes.rows[0],
      pending_boosts: pendingBoosts.rows[0],
      pending_requests: pendingRequests.rows[0],
    });
  } catch (err) {
    console.error('[SuperAdmin] Erreur dashboard:', err.message);
    res.status(500).json({ error: 'Erreur dashboard' });
  }
});

// ── CRÉER UN SOUS-ADMIN ─────────────────────────────────────
// POST /api/superadmin/admins
// Body: { full_name, role, whatsapp_number }
router.post('/admins', authSuperAdmin, async (req, res) => {
  try {
    const { full_name, role, whatsapp_number } = req.body;
    const validRoles = ['admin_ventes', 'admin_cashwork', 'admin_externe'];

    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide', valid_roles: validRoles });
    }

    // Mot de passe par défaut : aaaaaaaa
    const defaultPassword = 'aaaaaaaa';
    const passwordHash = await bcrypt.hash(defaultPassword, 12);

    const adminRes = await query(
      `INSERT INTO admin_accounts (full_name, role, whatsapp_number, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING id, full_name, role, whatsapp_number, created_at`,
      [full_name, role, whatsapp_number, passwordHash]
    );

    const admin = adminRes.rows[0];

    // Notifier le nouveau sous-admin
    await sendWhatsApp(
      whatsapp_number,
      `🎉 Bienvenue sur Play16 Admin !\nVotre compte ${role} a été créé.\nMot de passe temporaire : ${defaultPassword}\nVous serez forcé de le changer à la première connexion.\nURL Admin : https://play16-backend-production.up.railway.app`
    );

    // Journaliser
    await query(
      `INSERT INTO admin_session_actions (action_type, description, target_table, target_id)
       VALUES ('create_admin', $1, 'admin_accounts', $2)`,
      [`Super Admin a créé le compte ${role} pour ${full_name}`, admin.id]
    );

    res.json({ success: true, admin });
  } catch (err) {
    console.error('[SuperAdmin] Erreur création admin:', err.message);
    res.status(500).json({ error: 'Erreur création sous-admin' });
  }
});

// ── LISTE DES SOUS-ADMINS ───────────────────────────────────
// GET /api/superadmin/admins
router.get('/admins', authSuperAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, full_name, role, whatsapp_number, extended_access,
              is_active, must_change_password, created_at
       FROM admin_accounts
       WHERE role != 'super_admin'
       ORDER BY created_at DESC`
    );
    res.json({ admins: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur liste admins' });
  }
});

// ── ACCORDER / RÉVOQUER ACCÈS ÉTENDU ───────────────────────
// PUT /api/superadmin/admins/:id/extended-access
// Body: { enabled: true|false }
router.put('/admins/:id/extended-access', authSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;

    await query(
      `UPDATE admin_accounts SET extended_access = $1 WHERE id = $2 AND role != 'super_admin'`,
      [!!enabled, id]
    );

    const adminRes = await query(`SELECT full_name, whatsapp_number FROM admin_accounts WHERE id = $1`, [id]);
    const admin = adminRes.rows[0];

    if (admin) {
      await sendWhatsApp(
        admin.whatsapp_number,
        enabled
          ? `🔓 Accès étendu accordé par le Super Admin. Vous avez maintenant accès à toutes les données de la plateforme.`
          : `🔒 Accès étendu révoqué par le Super Admin. Vous revenez à votre périmètre habituel.`
      );
    }

    res.json({ success: true, extended_access: !!enabled });
  } catch (err) {
    res.status(500).json({ error: 'Erreur mise à jour accès étendu' });
  }
});

// ── MODE SUPERVISION ────────────────────────────────────────
// POST /api/superadmin/supervision/start/:adminId
// Permet au Super Admin de "voir" l'interface d'un sous-admin
router.post('/supervision/start/:adminId', authSuperAdmin, async (req, res) => {
  try {
    const { adminId } = req.params;

    const adminRes = await query(
      `SELECT id, full_name, role, extended_access FROM admin_accounts WHERE id = $1`,
      [adminId]
    );
    if (adminRes.rows.length === 0) return res.status(404).json({ error: 'Admin introuvable' });

    const targetAdmin = adminRes.rows[0];

    // Enregistrer le début de la supervision
    const logRes = await query(
      `INSERT INTO supervision_logs (super_admin_id, viewed_admin_id)
       VALUES ($1, $2) RETURNING id`,
      [req.admin.id, adminId]
    );

    // Récupérer les données telles qu'elles seraient visibles par ce sous-admin
    const dashboardData = await getAdminDashboard(targetAdmin.role, targetAdmin.extended_access);

    res.json({
      success: true,
      supervision_session_id: logRes.rows[0].id,
      viewing_admin: targetAdmin,
      mode: 'READ_ONLY',
      note: 'Mode supervision actif. Lecture seule — aucune action ne peut être effectuée depuis cette vue.',
      dashboard: dashboardData,
    });
  } catch (err) {
    console.error('[SuperAdmin] Erreur supervision:', err.message);
    res.status(500).json({ error: 'Erreur démarrage supervision' });
  }
});

// Terminer la supervision
router.post('/supervision/end/:sessionId', authSuperAdmin, async (req, res) => {
  try {
    await query(
      `UPDATE supervision_logs SET ended_at = now() WHERE id = $1 AND super_admin_id = $2`,
      [req.params.sessionId, req.admin.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur fin supervision' });
  }
});

// ── SESSIONS ADMIN (traçabilité) ────────────────────────────
// GET /api/superadmin/sessions
router.get('/sessions', authSuperAdmin, async (req, res) => {
  try {
    const { admin_id, date } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (admin_id) { params.push(admin_id); where += ` AND s.admin_id = $${params.length}`; }
    if (date) {
      params.push(date);
      where += ` AND s.started_at::date = $${params.length}::date`;
    }

    const sessions = await query(
      `SELECT
         s.id, s.started_at, s.ended_at, s.whatsapp_number_used, s.ip_address,
         a.full_name as admin_name, a.role as admin_role,
         COUNT(sa.id) as action_count
       FROM admin_sessions s
       JOIN admin_accounts a ON a.id = s.admin_id
       LEFT JOIN admin_session_actions sa ON sa.session_id = s.id
       ${where}
       GROUP BY s.id, a.full_name, a.role
       ORDER BY s.started_at DESC
       LIMIT 100`,
      params
    );

    res.json({ sessions: sessions.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur sessions' });
  }
});

// GET /api/superadmin/sessions/:id/actions
router.get('/sessions/:id/actions', authSuperAdmin, async (req, res) => {
  try {
    const actions = await query(
      `SELECT sa.*, s.whatsapp_number_used, a.full_name
       FROM admin_session_actions sa
       JOIN admin_sessions s ON s.id = sa.session_id
       JOIN admin_accounts a ON a.id = s.admin_id
       WHERE sa.session_id = $1
       ORDER BY sa.created_at ASC`,
      [req.params.id]
    );
    res.json({ actions: actions.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur actions session' });
  }
});

// ── RECHERCHE TRANSACTION GLOBALE ───────────────────────────
// GET /api/superadmin/search?q=...&type=order|external|cashwork
router.get('/search', authSuperAdmin, async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q) return res.status(400).json({ error: 'Terme de recherche requis' });

    const results = {};

    if (!type || type === 'order') {
      const orders = await query(
        `SELECT o.id, o.status, o.total_amount, o.created_at,
                u.full_name as client_name, u.phone_number as client_phone,
                p.name as product_name
         FROM orders o
         JOIN users u ON u.id = o.client_id
         JOIN product_variants pv ON pv.id = o.product_variant_id
         JOIN products p ON p.id = pv.product_id
         WHERE o.id::text ILIKE $1 OR u.phone_number ILIKE $1 OR u.full_name ILIKE $1
         LIMIT 20`,
        [`%${q}%`]
      );
      results.orders = orders.rows;
    }

    if (!type || type === 'external') {
      const external = await query(
        `SELECT ep.id, ep.status, ep.amount, ep.created_at,
                ep.seller_whatsapp_number,
                u.full_name as buyer_name, u.phone_number as buyer_phone
         FROM external_payments ep
         JOIN users u ON u.id = ep.buyer_id
         WHERE ep.id::text ILIKE $1 OR u.phone_number ILIKE $1 OR ep.seller_whatsapp_number ILIKE $1
         LIMIT 20`,
        [`%${q}%`]
      );
      results.external_payments = external.rows;
    }

    if (!type || type === 'cashwork') {
      const cashwork = await query(
        `SELECT cm.id, cm.status, cm.invoice_amount, cm.created_at,
                uc.full_name as client_name, uw.full_name as worker_name
         FROM cash_work_missions cm
         JOIN users uc ON uc.id = cm.client_id
         JOIN users uw ON uw.id = cm.worker_id
         WHERE cm.id::text ILIKE $1 OR uc.phone_number ILIKE $1
         LIMIT 20`,
        [`%${q}%`]
      );
      results.cashwork_missions = cashwork.rows;
    }

    res.json({ query: q, results });
  } catch (err) {
    res.status(500).json({ error: 'Erreur recherche' });
  }
});

// ── QR LOTS (Super Admin uniquement) ────────────────────────
// POST /api/superadmin/qr-lots
router.post('/qr-lots', authSuperAdmin, async (req, res) => {
  try {
    const { target_buyer_count, rewards } = req.body;

    if (!target_buyer_count || !rewards?.length) {
      return res.status(400).json({ error: 'Nombre d\'acheteurs cibles et récompenses requis' });
    }

    // Seed cryptographique — tirage jamais prévisible ni manipulable
    const cryptoSeed = crypto.randomBytes(64).toString('hex');

    const lotRes = await query(
      `INSERT INTO qr_lots (created_by_super_admin_id, target_buyer_count, crypto_seed)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.admin.id, target_buyer_count, cryptoSeed]
    );
    const lot = lotRes.rows[0];

    for (const reward of rewards) {
      await query(
        `INSERT INTO qr_lot_rewards (qr_lot_id, reward_type, reward_value, winner_count)
         VALUES ($1, $2, $3, $4)`,
        [lot.id, reward.type, reward.value || null, reward.winner_count]
      );
    }

    res.json({
      success: true,
      lot: { id: lot.id, target_buyer_count, crypto_seed: cryptoSeed.slice(0, 16) + '...', rewards },
      note: 'Les QR codes seront attribués aléatoirement aux prochains acheteurs via tirage cryptographique.',
    });
  } catch (err) {
    console.error('[SuperAdmin] Erreur création QR lot:', err.message);
    res.status(500).json({ error: 'Erreur création QR lot' });
  }
});

// GET /api/superadmin/qr-lots
router.get('/qr-lots', authSuperAdmin, async (req, res) => {
  try {
    const lots = await query(
      `SELECT ql.*, a.full_name as created_by_name,
              COUNT(qc.id) as qr_codes_distributed,
              COUNT(CASE WHEN qc.is_winner THEN 1 END) as winners_so_far
       FROM qr_lots ql
       LEFT JOIN admin_accounts a ON a.id = ql.created_by_super_admin_id
       LEFT JOIN qr_codes qc ON qc.qr_lot_id = ql.id
       GROUP BY ql.id, a.full_name
       ORDER BY ql.created_at DESC`
    );
    res.json({ qr_lots: lots.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur liste QR lots' });
  }
});

// ── CGU DYNAMIQUES ──────────────────────────────────────────
// GET /api/superadmin/cgu
router.get('/cgu', authAdmin, async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM cgu_versions ORDER BY version_number DESC LIMIT 5`
    );
    res.json({ versions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture CGU' });
  }
});

// POST /api/superadmin/cgu — publier une nouvelle version
router.post('/cgu', authSuperAdmin, async (req, res) => {
  try {
    const { content, module = 'global' } = req.body;
    if (!content) return res.status(400).json({ error: 'Contenu CGU requis' });

    const lastVersion = await query(
      `SELECT MAX(version_number) as v FROM cgu_versions WHERE module = $1`, [module]
    );
    const newVersion = (lastVersion.rows[0].v || 0) + 1;

    await query(
      `INSERT INTO cgu_versions (version_number, content, module, published_by)
       VALUES ($1, $2, $3, $4)`,
      [newVersion, content, module, req.admin.id]
    );

    res.json({
      success: true,
      version: newVersion,
      note: 'Tous les utilisateurs devront accepter cette nouvelle version lors de leur prochaine connexion.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur publication CGU' });
  }
});

// GET /api/superadmin/cgu/current — pour l'app mobile
router.get('/cgu/current', async (req, res) => {
  try {
    const result = await query(
      `SELECT version_number, content, module, published_at
       FROM cgu_versions WHERE module = 'global'
       ORDER BY version_number DESC LIMIT 1`
    );
    if (result.rows.length === 0) {
      return res.json({ version: 0, content: '', empty: true });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture CGU courante' });
  }
});

// ── RAPPORT QUOTIDIEN ───────────────────────────────────────
// GET /api/superadmin/report/daily
router.get('/report/daily', authSuperAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [orders, cashwork, external, newUsers, disputes] = await Promise.all([
      query(`SELECT COUNT(*) as count, COALESCE(SUM(total_amount),0) as revenue
             FROM orders WHERE created_at::date = $1`, [today]),
      query(`SELECT COUNT(*) as count FROM cash_work_missions WHERE created_at::date = $1`, [today]),
      query(`SELECT COUNT(*) as count, COALESCE(SUM(amount),0) as total
             FROM external_payments WHERE created_at::date = $1`, [today]),
      query(`SELECT COUNT(*) as count FROM users WHERE created_at::date = $1`, [today]),
      query(`SELECT COUNT(*) as count FROM disputes WHERE created_at::date = $1 AND resolved_at IS NULL`, [today]),
    ]);

    const report = {
      date: today,
      orders: orders.rows[0],
      cashwork: cashwork.rows[0],
      external_payments: external.rows[0],
      new_users: newUsers.rows[0],
      open_disputes: disputes.rows[0],
    };

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Erreur rapport quotidien' });
  }
});

// ── HELPER : données dashboard selon le rôle ────────────────
async function getAdminDashboard(role, extendedAccess) {
  const data = {};

  if (role === 'admin_ventes' || extendedAccess) {
    const orders = await query(
      `SELECT COUNT(*) as total, SUM(total_amount) as revenue FROM orders WHERE created_at > now() - INTERVAL '30 days'`
    );
    data.orders = orders.rows[0];
  }

  if (role === 'admin_cashwork' || extendedAccess) {
    const missions = await query(
      `SELECT COUNT(*) as total FROM cash_work_missions WHERE created_at > now() - INTERVAL '30 days'`
    );
    data.missions = missions.rows[0];
  }

  if (role === 'admin_externe' || extendedAccess) {
    const external = await query(
      `SELECT COUNT(*) as total, SUM(amount) as total_amount FROM external_payments WHERE status = 'escrowed'`
    );
    data.external_escrow = external.rows[0];
  }

  return data;
}

module.exports = router;
