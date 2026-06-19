// ============================================================
// PLAY16 — Routes d'authentification
// ============================================================
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { query } = require('./pool');
const { sendOTP, verifyOTP } = require('./otpService');
const { sendWhatsApp } = require('./NotificationService');

// ── CLIENT : Demander un OTP ────────────────────────────────
// POST /api/auth/request-otp
// Body: { phone_number: "6XXXXXXXX" }
router.post('/request-otp', async (req, res) => {
  try {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ error: 'Numéro requis' });

    // Crée le compte si premier accès
    await query(
      `INSERT INTO users (phone_number) VALUES ($1) ON CONFLICT (phone_number) DO NOTHING`,
      [phone_number]
    );

    const result = await sendOTP(phone_number);
    res.json({ success: true, simulated: result.simulated });
  } catch (err) {
    console.error('[Auth] Erreur request-otp:', err.message);
    res.status(500).json({ error: 'Erreur envoi OTP' });
  }
});

// ── CLIENT : Vérifier l'OTP et recevoir un token ───────────
// POST /api/auth/verify-otp
// Body: { phone_number: "6XXXXXXXX", code: "123456" }
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone_number, code } = req.body;
    if (!phone_number || !code) return res.status(400).json({ error: 'Données manquantes' });

    const valid = await verifyOTP(phone_number, code);
    if (!valid) return res.status(401).json({ error: 'Code invalide ou expiré' });

    // Récupère l'utilisateur
    const userRes = await query(
      `SELECT * FROM users WHERE phone_number = $1`,
      [phone_number]
    );
    const user = userRes.rows[0];

    // Vérifie si CGU acceptée (version courante)
    const cguRes = await query(
      `SELECT MAX(version_number) as latest FROM cgu_versions WHERE module = 'global'`
    );
    const latestCGU = cguRes.rows[0]?.latest || 0;
    const needsCGU = user.cgu_accepted_version < latestCGU;

    const token = jwt.sign(
      { id: user.id, phone: user.phone_number, type: 'client' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        phone_number: user.phone_number,
        full_name: user.full_name,
        is_supplier: user.is_supplier,
        is_cash_worker: user.is_cash_worker,
        supplier_verified: user.supplier_verified,
        cashback_balance: user.cashback_balance,
        two_fa_enabled: user.two_fa_enabled,
      },
      needs_cgu_acceptance: needsCGU,
      cgu_version: latestCGU,
    });
  } catch (err) {
    console.error('[Auth] Erreur verify-otp:', err.message);
    res.status(500).json({ error: 'Erreur vérification OTP' });
  }
});

// ── ADMIN : Connexion avec mot de passe ─────────────────────
// POST /api/auth/admin-login
// Body: { whatsapp_number: "6XXXXXXXX", password: "..." }
router.post('/admin-login', async (req, res) => {
  try {
    const { whatsapp_number, password } = req.body;
    if (!whatsapp_number || !password) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    const adminRes = await query(
      `SELECT * FROM admin_accounts WHERE whatsapp_number = $1 AND is_active = TRUE`,
      [whatsapp_number]
    );
    const admin = adminRes.rows[0];
    if (!admin) return res.status(401).json({ error: 'Compte introuvable' });

    const validPassword = await bcrypt.compare(password, admin.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Mot de passe incorrect' });

    // Envoie un OTP 2FA via WhatsApp
    const otpResult = await sendOTP(whatsapp_number);
    if (otpResult.simulated) {
      console.log(`[Admin 2FA SIMULATION] OTP envoyé à ${whatsapp_number}`);
    }

    // Crée une session admin
    await query(
      `INSERT INTO admin_sessions (admin_id, whatsapp_number_used, ip_address)
       VALUES ($1, $2, $3)`,
      [admin.id, whatsapp_number, req.ip]
    );

    res.json({
      success: true,
      requires_2fa: true,
      admin_id: admin.id,
      must_change_password: admin.must_change_password,
      simulated: otpResult.simulated,
    });
  } catch (err) {
    console.error('[Auth] Erreur admin-login:', err.message);
    res.status(500).json({ error: 'Erreur connexion admin' });
  }
});

// ── ADMIN : Vérifier le 2FA et recevoir le token ────────────
// POST /api/auth/admin-verify-2fa
// Body: { admin_id: "uuid", whatsapp_number: "6XX", code: "123456" }
router.post('/admin-verify-2fa', async (req, res) => {
  try {
    const { admin_id, whatsapp_number, code } = req.body;

    const valid = await verifyOTP(whatsapp_number, code);
    if (!valid) return res.status(401).json({ error: 'Code 2FA invalide ou expiré' });

    const adminRes = await query(
      `SELECT * FROM admin_accounts WHERE id = $1`,
      [admin_id]
    );
    const admin = adminRes.rows[0];
    if (!admin) return res.status(404).json({ error: 'Admin introuvable' });

    const token = jwt.sign(
      {
        id: admin.id,
        role: admin.role,
        whatsapp: whatsapp_number,
        extended_access: admin.extended_access,
        type: 'admin',
      },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      success: true,
      token,
      admin: {
        id: admin.id,
        full_name: admin.full_name,
        role: admin.role,
        extended_access: admin.extended_access,
        must_change_password: admin.must_change_password,
      },
    });
  } catch (err) {
    console.error('[Auth] Erreur admin-verify-2fa:', err.message);
    res.status(500).json({ error: 'Erreur vérification 2FA' });
  }
});

// ── CLIENT : Accepter les CGU ───────────────────────────────
// POST /api/auth/accept-cgu
// Body: { version: 1 }
router.post('/accept-cgu', async (req, res) => {
  try {
    const { id } = req.user || {};
    const { version } = req.body;
    if (!id) return res.status(401).json({ error: 'Non authentifié' });

    await query(
      `UPDATE users SET cgu_accepted_version = $1, cgu_accepted_at = now() WHERE id = $2`,
      [version, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur acceptation CGU' });
  }
});

module.exports = router;
