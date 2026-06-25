// ============================================================
// PLAY16 — Routes Sécurité (Super Admin)
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('./pool');
const { authSuperAdmin, authAdmin } = require('./authMiddleware');

// ── TABLEAU DE BORD SÉCURITÉ ────────────────────────────────
// GET /api/security/dashboard
router.get('/dashboard', authSuperAdmin, async (req, res) => {
  try {
    const [alerts, blacklisted, anomalies, otpBlocked, recentFraud] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(CASE WHEN resolved=FALSE THEN 1 END) as open FROM fraud_alerts`),
      query(`SELECT COUNT(*) as total FROM jwt_blacklist WHERE revoked_at > now() - INTERVAL '7 days'`),
      query(`SELECT COUNT(*) as total FROM gps_anomalies WHERE detected_at > now() - INTERVAL '24 hours'`),
      query(`SELECT COUNT(*) as total FROM otp_attempts WHERE blocked_until > now()`),
      query(`SELECT user_id, alert_type, severity, details, created_at FROM fraud_alerts WHERE resolved=FALSE ORDER BY created_at DESC LIMIT 10`),
    ]);

    res.json({
      fraud_alerts: alerts.rows[0],
      jwt_revocations_7d: blacklisted.rows[0],
      gps_anomalies_24h: anomalies.rows[0],
      otp_blocked_numbers: otpBlocked.rows[0],
      recent_alerts: recentFraud.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur dashboard sécurité' });
  }
});

// ── LIRE TOUS LES PARAMÈTRES SÉCURITÉ ───────────────────────
// GET /api/security/settings
router.get('/settings', authSuperAdmin, async (req, res) => {
  try {
    const r = await query(`SELECT key, value, description, updated_at FROM security_settings ORDER BY key`);
    res.json({ settings: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture paramètres sécurité' });
  }
});

// ── MODIFIER UN PARAMÈTRE SÉCURITÉ ──────────────────────────
// PUT /api/security/settings/:key
router.put('/settings/:key', authSuperAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    // Validations spécifiques
    const validations = {
      otp_max_attempts: v => parseInt(v) >= 3 && parseInt(v) <= 10,
      otp_block_duration_min: v => parseInt(v) >= 5 && parseInt(v) <= 1440,
      otp_per_hour_limit: v => parseInt(v) >= 1 && parseInt(v) <= 10,
      gps_max_speed_kmh: v => parseInt(v) >= 50 && parseInt(v) <= 500,
      gps_update_interval_sec: v => parseInt(v) >= 1 && parseInt(v) <= 60,
      video_min_duration_sec: v => parseInt(v) >= 5 && parseInt(v) <= 300,
      video_max_size_mb: v => parseInt(v) >= 10 && parseInt(v) <= 2000,
      cashwork_invoice_max_fcfa: v => parseInt(v) >= 1000,
      payment_token_expiry_hours: v => parseInt(v) >= 1 && parseInt(v) <= 168,
    };

    if (validations[key] && !validations[key](value)) {
      return res.status(400).json({ error: `Valeur invalide pour ${key}` });
    }

    await query(
      `UPDATE security_settings SET value=$1, updated_by=$2, updated_at=now() WHERE key=$3`,
      [value, req.admin.id, key]
    );

    res.json({ success: true, key, value });
  } catch (err) {
    res.status(500).json({ error: 'Erreur modification paramètre sécurité' });
  }
});

// ── ALERTES FRAUDE ───────────────────────────────────────────
// GET /api/security/alerts
router.get('/alerts', authSuperAdmin, async (req, res) => {
  try {
    const { resolved = 'false', page = 1 } = req.query;
    const limit = 30, offset = (page-1)*limit;
    const r = await query(
      `SELECT fa.*, u.phone_number, u.full_name
       FROM fraud_alerts fa LEFT JOIN users u ON u.id = fa.user_id
       WHERE fa.resolved = $1
       ORDER BY fa.created_at DESC LIMIT $2 OFFSET $3`,
      [resolved === 'true', limit, offset]
    );
    res.json({ alerts: r.rows, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur liste alertes' });
  }
});

// PUT /api/security/alerts/:id/resolve
router.put('/alerts/:id/resolve', authSuperAdmin, async (req, res) => {
  try {
    await query(
      `UPDATE fraud_alerts SET resolved=TRUE, resolved_by=$1 WHERE id=$2`,
      [req.admin.id, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur résolution alerte' });
  }
});

// ── TOKENS JWT RÉVOQUÉS ──────────────────────────────────────
// GET /api/security/blacklist
router.get('/blacklist', authSuperAdmin, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, reason, revoked_at FROM jwt_blacklist
       ORDER BY revoked_at DESC LIMIT 50`
    );
    res.json({ revoked_tokens: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur liste blacklist' });
  }
});

// POST /api/security/revoke-all-sessions
// Révoque TOUS les tokens actifs (urgence sécurité)
router.post('/revoke-all-sessions', authSuperAdmin, async (req, res) => {
  try {
    const { reason = 'emergency_revocation' } = req.body;
    // Marquer dans la DB qu'une révocation globale a eu lieu
    await query(
      `INSERT INTO security_settings (key, value, description, updated_by, updated_at)
       VALUES ('last_global_revocation', $1, 'Dernière révocation globale JWT', $2, now())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=now()`,
      [new Date().toISOString(), req.admin.id]
    );
    res.json({
      success: true,
      message: 'Révocation globale enregistrée. Tous les utilisateurs devront se reconnecter.',
      reason,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur révocation globale' });
  }
});

// ── ANOMALIES GPS ────────────────────────────────────────────
// GET /api/security/gps-anomalies
router.get('/gps-anomalies', authAdmin, async (req, res) => {
  try {
    const r = await query(
      `SELECT ga.*, d.order_id, u.full_name as livreur_name
       FROM gps_anomalies ga
       JOIN deliveries d ON d.id = ga.delivery_id
       LEFT JOIN users u ON u.id = d.delivery_person_id
       ORDER BY ga.detected_at DESC LIMIT 50`
    );
    res.json({ anomalies: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur anomalies GPS' });
  }
});

// ── NUMÉROS OTP BLOQUÉS ──────────────────────────────────────
// GET /api/security/otp-blocked
router.get('/otp-blocked', authSuperAdmin, async (req, res) => {
  try {
    const r = await query(
      `SELECT phone_number, attempts, blocked_until
       FROM otp_attempts WHERE blocked_until > now()
       ORDER BY blocked_until DESC`
    );
    res.json({ blocked: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur liste bloqués OTP' });
  }
});

// POST /api/security/otp-unblock/:phone
// Débloquer manuellement un numéro
router.post('/otp-unblock/:phone', authSuperAdmin, async (req, res) => {
  try {
    await query(`DELETE FROM otp_attempts WHERE phone_number=$1`, [req.params.phone]);
    res.json({ success: true, message: `Numéro ${req.params.phone} débloqué.` });
  } catch (err) {
    res.status(500).json({ error: 'Erreur déblocage numéro' });
  }
});

// ── TOKENS PAIEMENT EXTERNE ──────────────────────────────────
// GET /api/security/payment-tokens
router.get('/payment-tokens', authAdmin, async (req, res) => {
  try {
    const r = await query(
      `SELECT pt.token, pt.used, pt.expires_at, pt.used_at,
              ep.amount, ep.seller_whatsapp_number,
              u.phone_number as buyer_phone
       FROM payment_tokens pt
       JOIN external_payments ep ON ep.id = pt.external_payment_id
       JOIN users u ON u.id = ep.buyer_id
       ORDER BY pt.expires_at DESC LIMIT 50`
    );
    res.json({ tokens: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur liste tokens paiement' });
  }
});

// ── RAPPORT SÉCURITÉ QUOTIDIEN ───────────────────────────────
// GET /api/security/report
router.get('/report', authSuperAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [alerts, gps, otpBlocks, revokedTokens, suspiciousPayments] = await Promise.all([
      query(`SELECT COUNT(*) as cnt FROM fraud_alerts WHERE created_at::date=$1`, [today]),
      query(`SELECT COUNT(*) as cnt FROM gps_anomalies WHERE detected_at::date=$1`, [today]),
      query(`SELECT COUNT(*) as cnt FROM otp_attempts WHERE window_start::date=$1 AND blocked_until IS NOT NULL`, [today]),
      query(`SELECT COUNT(*) as cnt FROM jwt_blacklist WHERE revoked_at::date=$1`, [today]),
      query(`SELECT COUNT(*) as cnt FROM external_payments WHERE created_at::date=$1 AND status='refunded'`, [today]),
    ]);

    res.json({
      date: today,
      fraud_alerts_today: parseInt(alerts.rows[0].cnt),
      gps_anomalies_today: parseInt(gps.rows[0].cnt),
      otp_blocks_today: parseInt(otpBlocks.rows[0].cnt),
      jwt_revocations_today: parseInt(revokedTokens.rows[0].cnt),
      suspicious_refunds_today: parseInt(suspiciousPayments.rows[0].cnt),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur rapport sécurité' });
  }
});

module.exports = router;
