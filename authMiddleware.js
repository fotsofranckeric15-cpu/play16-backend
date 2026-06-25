// ============================================================
// PLAY16 — Middleware Auth (avec blacklist JWT)
// ============================================================
const jwt = require('jsonwebtoken');
const { isTokenBlacklisted } = require('./securityMiddleware');
const { query } = require('./pool');

async function authClient(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token manquant' });

    // Vérifier blacklist
    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ error: 'Session révoquée. Reconnectez-vous.' });
    }

    // Vérifier révocation globale
    const lastRevocation = await query(
      `SELECT value FROM security_settings WHERE key='last_global_revocation'`
    );
    if (lastRevocation.rows[0]) {
      const decoded = jwt.decode(token);
      const revokedAt = new Date(lastRevocation.rows[0].value).getTime() / 1000;
      if (decoded.iat < revokedAt) {
        return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' });
      }
    }

    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

async function authAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token manquant' });

    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ error: 'Session révoquée. Reconnectez-vous.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.role) return res.status(403).json({ error: 'Accès refusé' });
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

async function authSuperAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token manquant' });

    if (await isTokenBlacklisted(token)) {
      return res.status(401).json({ error: 'Session révoquée. Reconnectez-vous.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'super_admin') return res.status(403).json({ error: 'Réservé au Super Admin' });
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

module.exports = { authClient, authAdmin, authSuperAdmin };
