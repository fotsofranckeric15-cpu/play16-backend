// ============================================================
// PLAY16 — Routes Auth (corrigé — Super Admin sans OTP)
// ============================================================
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcrypt');
const { query }    = require('./pool');
const { sendOTP, verifyOTP } = require('./otpService');
const {
  checkOTPRateLimit, recordOTPFailure, clearOTPAttempts,
  isTokenBlacklisted, blacklistToken, maskSensitive, createFraudAlert,
} = require('./securityMiddleware');

// ── CLIENT : Demander un OTP ─────────────────────────────────
router.post('/request-otp', async (req, res) => {
  try {
    const { phone_number } = req.body;
    if (!phone_number) return res.status(400).json({ error: 'Numéro requis' });

    // Créer le compte si premier accès
    await query(
      `INSERT INTO users (phone_number) VALUES ($1) ON CONFLICT (phone_number) DO NOTHING`,
      [phone_number]
    );

    // Rate limiting OTP (seulement si la table existe)
    try { await checkOTPRateLimit(phone_number); } catch(rl) {
      return res.status(429).json({ error: rl.message });
    }

    const result = await sendOTP(phone_number);
    if (result.simulated) {
      console.log(`[OTP SIM] Code pour ${maskSensitive(phone_number)} visible dans les logs Railway`);
    }
    res.json({ success: true, simulated: result.simulated });
  } catch (err) {
    console.error('[Auth] request-otp:', err.message);
    res.status(500).json({ error: 'Erreur envoi OTP' });
  }
});

// ── CLIENT : Vérifier OTP ────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone_number, code } = req.body;
    if (!phone_number || !code) return res.status(400).json({ error: 'Données manquantes' });

    const valid = await verifyOTP(phone_number, code);
    if (!valid) {
      try { await recordOTPFailure(phone_number); } catch(e) {}
      return res.status(401).json({ error: 'Code invalide ou expiré' });
    }

    try { await clearOTPAttempts(phone_number); } catch(e) {}

    const userRes = await query(`SELECT * FROM users WHERE phone_number=$1`, [phone_number]);
    const user = userRes.rows[0];

    const cguRes = await query(`SELECT MAX(version_number) as latest FROM cgu_versions WHERE module='global'`);
    const latestCGU = cguRes.rows[0]?.latest || 0;

    const token = jwt.sign(
      { id: user.id, phone: user.phone_number, type: 'client' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true, token,
      user: {
        id: user.id, phone_number: user.phone_number, full_name: user.full_name,
        is_supplier: user.is_supplier, is_cash_worker: user.is_cash_worker,
        supplier_verified: user.supplier_verified, cashback_balance: user.cashback_balance,
      },
      needs_cgu_acceptance: user.cgu_accepted_version < latestCGU,
      cgu_version: latestCGU,
    });
  } catch (err) {
    console.error('[Auth] verify-otp:', err.message);
    res.status(500).json({ error: 'Erreur vérification OTP' });
  }
});

// ── ADMIN : Login (mot de passe uniquement) ──────────────────
// RÈGLE : Super Admin → connexion directe par mot de passe, PAS d'OTP
//         Sous-admins → mot de passe + OTP WhatsApp (2FA)
router.post('/admin-login', async (req, res) => {
  try {
    const { whatsapp_number, password } = req.body;
    if (!whatsapp_number || !password) return res.status(400).json({ error: 'Données manquantes' });

    const adminRes = await query(
      `SELECT * FROM admin_accounts WHERE whatsapp_number=$1 AND is_active=TRUE`,
      [whatsapp_number]
    );

    // Délai constant anti timing-attack
    const dummyHash = '$2b$12$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const admin = adminRes.rows[0];
    const validPassword = admin
      ? await bcrypt.compare(password, admin.password_hash)
      : await bcrypt.compare(password, dummyHash);

    if (!admin || !validPassword) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    // ── SUPER ADMIN : connexion directe, pas d'OTP ───────────
    if (admin.role === 'super_admin') {
      const token = jwt.sign(
        { id: admin.id, role: admin.role, whatsapp: whatsapp_number,
          extended_access: true, type: 'admin' },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
      );

      // Créer session
      await query(
        `INSERT INTO admin_sessions (admin_id, whatsapp_number_used, ip_address)
         VALUES ($1,$2,$3)`, [admin.id, whatsapp_number, req.ip]
      );

      return res.json({
        success: true,
        requires_2fa: false,
        token,
        admin: {
          id: admin.id, full_name: admin.full_name, role: admin.role,
          extended_access: true, must_change_password: admin.must_change_password,
        },
      });
    }

    // ── SOUS-ADMINS : OTP 2FA requis ─────────────────────────
    try { await checkOTPRateLimit(whatsapp_number); } catch(rl) {
      return res.status(429).json({ error: rl.message });
    }

    const otpResult = await sendOTP(whatsapp_number);

    const sessionRes = await query(
      `INSERT INTO admin_sessions (admin_id, whatsapp_number_used, ip_address)
       VALUES ($1,$2,$3) RETURNING id`,
      [admin.id, whatsapp_number, req.ip]
    );

    res.json({
      success: true,
      requires_2fa: true,
      admin_id: admin.id,
      session_id: sessionRes.rows[0].id,
      must_change_password: admin.must_change_password,
      simulated: otpResult.simulated,
    });
  } catch (err) {
    console.error('[Auth] admin-login:', err.message);
    res.status(500).json({ error: 'Erreur connexion admin' });
  }
});

// ── ADMIN : Vérifier 2FA (sous-admins uniquement) ────────────
router.post('/admin-verify-2fa', async (req, res) => {
  try {
    const { admin_id, whatsapp_number, code, session_id } = req.body;

    const valid = await verifyOTP(whatsapp_number, code);
    if (!valid) {
      try { await recordOTPFailure(whatsapp_number); } catch(e) {}
      return res.status(401).json({ error: 'Code 2FA invalide ou expiré' });
    }

    try { await clearOTPAttempts(whatsapp_number); } catch(e) {}

    const adminRes = await query(`SELECT * FROM admin_accounts WHERE id=$1`, [admin_id]);
    const admin = adminRes.rows[0];
    if (!admin) return res.status(404).json({ error: 'Admin introuvable' });

    const token = jwt.sign(
      { id: admin.id, role: admin.role, whatsapp: whatsapp_number,
        extended_access: admin.extended_access, type: 'admin', session_id },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    await query(`UPDATE admin_sessions SET started_at=now() WHERE id=$1`, [session_id]);

    res.json({
      success: true, token,
      admin: {
        id: admin.id, full_name: admin.full_name, role: admin.role,
        extended_access: admin.extended_access, must_change_password: admin.must_change_password,
      },
    });
  } catch (err) {
    console.error('[Auth] admin-verify-2fa:', err.message);
    res.status(500).json({ error: 'Erreur vérification 2FA' });
  }
});

// ── DÉCONNEXION ──────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) { try { await blacklistToken(token, 'logout'); } catch(e) {} }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erreur déconnexion' }); }
});

router.post('/admin-logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) { try { await blacklistToken(token, 'admin_logout'); } catch(e) {} }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erreur déconnexion admin' }); }
});

// ── ACCEPTER CGU ─────────────────────────────────
router.post('/accept-cgu', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { version } = req.body;
    await query(
      `UPDATE users SET cgu_accepted_version=$1, cgu_accepted_at=now() WHERE id=$2`,
      [version, decoded.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erreur acceptation CGU' }); }
});

module.exports = router;
