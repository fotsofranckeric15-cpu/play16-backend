// ============================================================
// PLAY16 — Routes Litiges & Blocages
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('./pool');
const { authAdmin, authSuperAdmin } = require('./authMiddleware');
const { sendWhatsApp } = require('./NotificationService');

// ── OUVRIR UN LITIGE ────────────────────────────────────────
// POST /api/disputes
// Body: { module: 'sales'|'cashwork'|'external', related_id }
router.post('/', authAdmin, async (req, res) => {
  try {
    const { module, related_id } = req.body;

    const disputeRes = await query(
      `INSERT INTO disputes (module, related_id, handled_by_admin_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [module, related_id, req.admin.id]
    );

    await logAdminAction(req, 'open_dispute', 'disputes', disputeRes.rows[0].id,
      `Litige ouvert sur ${module} — ref: ${related_id}`);

    res.json({ success: true, dispute: disputeRes.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erreur ouverture litige' });
  }
});

// ── LISTE DES LITIGES (selon rôle) ──────────────────────────
// GET /api/disputes
router.get('/', authAdmin, async (req, res) => {
  try {
    const { status = 'open' } = req.query;

    // Filtrer par module selon le rôle de l'admin
    let moduleFilter = '';
    if (req.admin.role === 'admin_ventes') moduleFilter = `AND d.module = 'sales'`;
    else if (req.admin.role === 'admin_cashwork') moduleFilter = `AND d.module = 'cashwork'`;
    else if (req.admin.role === 'admin_externe') moduleFilter = `AND d.module = 'external'`;
    // super_admin et extended_access → tout voir

    const result = await query(
      `SELECT d.*, a.full_name as handled_by_name
       FROM disputes d
       LEFT JOIN admin_accounts a ON a.id = d.handled_by_admin_id
       WHERE ${status === 'open' ? 'd.resolved_at IS NULL' : 'd.resolved_at IS NOT NULL'}
       ${moduleFilter}
       ORDER BY d.created_at DESC
       LIMIT 50`
    );

    res.json({ disputes: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur liste litiges' });
  }
});

// ── SOUMETTRE UN PV (Procès-Verbal) ─────────────────────────
// PUT /api/disputes/:id/pv
// Body: { pv_content, resolution_type: 'arrangement'|'non_conciliation' }
router.put('/:id/pv', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { pv_content, resolution_type } = req.body;

    if (!pv_content) return res.status(400).json({ error: 'Contenu PV requis' });

    await query(
      `UPDATE disputes SET pv_content = $1, resolution_type = $2 WHERE id = $3`,
      [pv_content, resolution_type, id]
    );

    if (resolution_type === 'arrangement') {
      // PV validé → litige résolu
      await query(`UPDATE disputes SET resolved_at = now() WHERE id = $1`, [id]);
      await logAdminAction(req, 'resolve_dispute_pv', 'disputes', id,
        `Litige résolu par arrangement — PV soumis`);

      res.json({ success: true, status: 'resolved', message: 'PV validé. Litige clôturé.' });

    } else if (resolution_type === 'non_conciliation') {
      // Non-conciliation → escalade automatique au Super Admin
      await query(
        `UPDATE disputes SET escalated_to_super_admin = TRUE WHERE id = $1`, [id]
      );

      await logAdminAction(req, 'escalate_dispute', 'disputes', id,
        `Litige escaladé au Super Admin — non-conciliation`);

      // Notifier le Super Admin
      const superAdmins = await query(
        `SELECT whatsapp_number FROM admin_accounts WHERE role = 'super_admin' AND is_active = TRUE`
      );
      for (const sa of superAdmins.rows) {
        await sendWhatsApp(
          sa.whatsapp_number,
          `⚠️ Litige escaladé — Fiche de non-conciliation\nN° Litige : ${id.slice(0,8).toUpperCase()}\nAdmin : ${req.admin.full_name}\nAction requise : arbitrage final dans Play16 Admin > Litiges escaladés.`
        );
      }

      res.json({
        success: true,
        status: 'escalated',
        message: 'Fiche de non-conciliation générée. Le Super Admin a été notifié pour arbitrage final.',
      });
    }
  } catch (err) {
    console.error('[Disputes] Erreur PV:', err.message);
    res.status(500).json({ error: 'Erreur soumission PV' });
  }
});

// ── ARBITRAGE SUPER ADMIN ───────────────────────────────────
// POST /api/disputes/:id/arbitrate
// Body: { decision, refund_amount (optionnel) }
router.post('/:id/arbitrate', authSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { decision } = req.body;

    await query(
      `UPDATE disputes
       SET resolved_at = now(), pv_content = COALESCE(pv_content, '') || $1
       WHERE id = $2`,
      [`\n\n[DÉCISION SUPER ADMIN] ${decision}`, id]
    );

    await logAdminAction(req, 'arbitrate_dispute', 'disputes', id,
      `Super Admin a arbitré le litige : ${decision.slice(0, 100)}`);

    res.json({ success: true, decision, message: 'Arbitrage final enregistré. Litige clôturé.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur arbitrage' });
  }
});

// ── GÉNÉRER ATTESTATION PDF (Admin Externe) ─────────────────
// POST /api/disputes/:id/attestation
router.post('/:id/attestation', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const disputeRes = await query(
      `SELECT d.*, ep.amount, ep.seller_whatsapp_number,
              u.full_name as buyer_name, u.phone_number as buyer_phone
       FROM disputes d
       LEFT JOIN external_payments ep ON ep.id = d.related_id
       LEFT JOIN users u ON u.id = ep.buyer_id
       WHERE d.id = $1`,
      [id]
    );

    if (disputeRes.rows.length === 0) return res.status(404).json({ error: 'Litige introuvable' });
    const dispute = disputeRes.rows[0];

    // Attestation en format texte (PDF généré côté frontend ou via service tiers)
    const attestationContent = {
      title: 'ATTESTATION DE LITIGE — PLAY16',
      transaction_id: `EXT-${dispute.related_id?.slice(0,8).toUpperCase() || 'N/A'}`,
      dispute_id: `LIT-${id.slice(0,8).toUpperCase()}`,
      amount: dispute.amount,
      buyer_name: dispute.buyer_name,
      buyer_phone: dispute.buyer_phone,
      seller_whatsapp: dispute.seller_whatsapp_number,
      pv_summary: dispute.pv_content?.slice(0, 500) || 'En cours de rédaction',
      issued_at: new Date().toISOString(),
      note: 'Ce document permet aux parties de se présenter à la brigade compétente. Play16 exécutera la décision finale sur présentation de ce document signé par les autorités.',
    };

    // Stocker la référence dans la base
    await query(
      `UPDATE disputes SET attestation_pdf_url = $1 WHERE id = $2`,
      [`attestation-${id}-${Date.now()}.pdf`, id]
    );

    res.json({ success: true, attestation: attestationContent });
  } catch (err) {
    res.status(500).json({ error: 'Erreur génération attestation' });
  }
});

// ── BLOQUER UN COMPTE ────────────────────────────────────────
// POST /api/disputes/block-account
// Body: { user_id, reason, resolution_attempts }
router.post('/block-account', authAdmin, async (req, res) => {
  try {
    const { user_id, reason, resolution_attempts } = req.body;

    if (!reason || !resolution_attempts) {
      return res.status(400).json({
        error: 'Motif et tentatives de résolution obligatoires avant tout blocage'
      });
    }

    // Archivage permanent (identité admin + date + motif)
    const blockRes = await query(
      `INSERT INTO account_blocks (user_id, blocked_by_admin_id, reason, resolution_attempts)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [user_id, req.admin.id, reason, resolution_attempts]
    );

    // Désactiver l'accès utilisateur
    await query(`UPDATE users SET trust_score = 0 WHERE id = $1`, [user_id]);

    await logAdminAction(req, 'block_account', 'account_blocks', blockRes.rows[0].id,
      `Compte ${user_id} bloqué — Motif: ${reason.slice(0, 100)}`);

    // Notifier l'utilisateur
    const userRes = await query(
      `SELECT whatsapp_number, phone_number FROM users WHERE id = $1`, [user_id]
    );
    if (userRes.rows[0]) {
      await sendWhatsApp(
        userRes.rows[0].whatsapp_number || userRes.rows[0].phone_number,
        `⛔ Votre compte Play16 a été temporairement suspendu.\nMotif : ${reason}\nPour toute réclamation, contactez notre support.`
      );
    }

    res.json({
      success: true,
      block: blockRes.rows[0],
      note: 'Blocage archivé définitivement avec identité admin, date et motif. Seul le Super Admin peut débloquer.',
    });
  } catch (err) {
    console.error('[Disputes] Erreur blocage:', err.message);
    res.status(500).json({ error: 'Erreur blocage compte' });
  }
});

// ── DÉBLOQUER UN COMPTE (Super Admin uniquement) ─────────────
// POST /api/disputes/unblock-account/:blockId
router.post('/unblock-account/:blockId', authSuperAdmin, async (req, res) => {
  try {
    const { blockId } = req.params;

    const blockRes = await query(
      `UPDATE account_blocks
       SET unblocked_at = now(), unblocked_by_super_admin_id = $1
       WHERE id = $2 RETURNING user_id`,
      [req.admin.id, blockId]
    );

    if (blockRes.rows.length === 0) return res.status(404).json({ error: 'Blocage introuvable' });

    await query(`UPDATE users SET trust_score = 100 WHERE id = $1`, [blockRes.rows[0].user_id]);

    res.json({ success: true, message: 'Compte débloqué par le Super Admin.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur déblocage' });
  }
});

// ── DEMANDER RE-VÉRIFICATION D'IDENTITÉ (Admin) ─────────────
// POST /api/disputes/request-reverification/:userId
router.post('/request-reverification/:userId', authAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    await query(
      `UPDATE users SET identity_verification_status = 're_requested' WHERE id = $1`,
      [userId]
    );

    const userRes = await query(
      `SELECT whatsapp_number, phone_number FROM users WHERE id = $1`, [userId]
    );

    if (userRes.rows[0]) {
      await sendWhatsApp(
        userRes.rows[0].whatsapp_number || userRes.rows[0].phone_number,
        `🆔 Play16 vous demande de re-vérifier votre identité.\nMotif : ${reason || 'Vérification requise'}\nVeuillez ouvrir l\'application et soumettre vos documents. Votre compte sera limité jusqu\'à complétion.`
      );
    }

    await logAdminAction(req, 'request_reverification', 'users', userId,
      `Re-vérification d\'identité demandée — motif: ${reason}`);

    res.json({ success: true, message: 'Demande de re-vérification envoyée à l\'utilisateur.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur demande re-vérification' });
  }
});

// ── HELPER : journaliser une action admin ───────────────────
async function logAdminAction(req, actionType, targetTable, targetId, description) {
  try {
    await query(
      `INSERT INTO admin_session_actions (action_type, target_table, target_id, description)
       VALUES ($1, $2, $3, $4)`,
      [actionType, targetTable, targetId, description]
    );
  } catch (err) {
    console.error('[Disputes] Erreur log action:', err.message);
  }
}

module.exports = router;
