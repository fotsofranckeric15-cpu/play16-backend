// ============================================================
// PLAY16 — Middleware de Sécurité Centralisé
// ============================================================
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('./pool');

// ── HELPER : lire un paramètre de sécurité ──────────────────
async function getSetting(key, defaultVal) {
  try {
    const r = await query(`SELECT value FROM security_settings WHERE key = $1`, [key]);
    return r.rows[0]?.value ?? defaultVal;
  } catch { return defaultVal; }
}

// ── 1. RATE LIMITING OTP ────────────────────────────────────
async function checkOTPRateLimit(phoneNumber) {
  const maxAttempts  = parseInt(await getSetting('otp_max_attempts', '5'));
  const blockMinutes = parseInt(await getSetting('otp_block_duration_min', '30'));
  const perHourLimit = parseInt(await getSetting('otp_per_hour_limit', '3'));

  // Vérifier si bloqué
  const blocked = await query(
    `SELECT blocked_until FROM otp_attempts
     WHERE phone_number = $1 AND blocked_until > now()`, [phoneNumber]
  );
  if (blocked.rows.length > 0) {
    const until = new Date(blocked.rows[0].blocked_until);
    throw new Error(`Trop de tentatives. Réessayez après ${until.toLocaleTimeString('fr-FR')}.`);
  }

  // Vérifier le nombre d'envois dans l'heure
  const hourCount = await query(
    `SELECT COUNT(*) as cnt FROM otp_codes
     WHERE phone_number = $1 AND created_at > now() - INTERVAL '1 hour'`, [phoneNumber]
  );
  if (parseInt(hourCount.rows[0].cnt) >= perHourLimit) {
    throw new Error(`Limite d'envoi dépassée. Maximum ${perHourLimit} codes par heure.`);
  }

  return true;
}

async function recordOTPFailure(phoneNumber) {
  const maxAttempts  = parseInt(await getSetting('otp_max_attempts', '5'));
  const blockMinutes = parseInt(await getSetting('otp_block_duration_min', '30'));

  const existing = await query(
    `SELECT * FROM otp_attempts WHERE phone_number = $1 AND window_start > now() - INTERVAL '30 minutes'`,
    [phoneNumber]
  );

  if (existing.rows.length === 0) {
    await query(`INSERT INTO otp_attempts (phone_number, attempts) VALUES ($1, 1)`, [phoneNumber]);
  } else {
    const newCount = existing.rows[0].attempts + 1;
    if (newCount >= maxAttempts) {
      const blockedUntil = new Date(Date.now() + blockMinutes * 60 * 1000);
      await query(
        `UPDATE otp_attempts SET attempts = $1, blocked_until = $2 WHERE phone_number = $3`,
        [newCount, blockedUntil, phoneNumber]
      );
      throw new Error(`Trop de tentatives incorrectes. Compte bloqué ${blockMinutes} minutes.`);
    }
    await query(`UPDATE otp_attempts SET attempts = $1 WHERE phone_number = $2`, [newCount, phoneNumber]);
  }
}

async function clearOTPAttempts(phoneNumber) {
  await query(`DELETE FROM otp_attempts WHERE phone_number = $1`, [phoneNumber]);
}

// ── 2. JWT BLACKLIST ─────────────────────────────────────────
async function isTokenBlacklisted(token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const r = await query(`SELECT id FROM jwt_blacklist WHERE token_hash = $1`, [hash]);
  return r.rows.length > 0;
}

async function blacklistToken(token, reason = 'logout', revokedBy = null) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await query(
    `INSERT INTO jwt_blacklist (token_hash, reason, revoked_by)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [hash, reason, revokedBy]
  );
}

// ── 3. IDEMPOTENCE PAIEMENTS ────────────────────────────────
async function checkIdempotency(key) {
  const r = await query(
    `SELECT result_json, status_code FROM idempotency_keys
     WHERE key = $1 AND expires_at > now()`, [key]
  );
  if (r.rows.length > 0) {
    return { duplicate: true, result: JSON.parse(r.rows[0].result_json), status: r.rows[0].status_code };
  }
  return { duplicate: false };
}

async function saveIdempotencyResult(key, result, statusCode) {
  const ttl = parseInt(await getSetting('payment_idempotency_ttl_min', '10'));
  await query(
    `INSERT INTO idempotency_keys (key, result_json, status_code, expires_at)
     VALUES ($1, $2, $3, now() + $4 * INTERVAL '1 minute')
     ON CONFLICT (key) DO NOTHING`,
    [key, JSON.stringify(result), statusCode, ttl]
  );
}

// ── 4. VALIDATION PRIX (lu depuis DB) ───────────────────────
async function getProductPrice(variantId) {
  const r = await query(
    `SELECT p.base_price, p.discounted_price, p.cashback_amount,
            p.supplier_id, p.name, p.cashback_amount,
            u.supplier_verified, u.whatsapp_number as supplier_whatsapp,
            pv.stock, pv.color, pv.size
     FROM product_variants pv
     JOIN products p ON p.id = pv.product_id
     JOIN users u ON u.id = p.supplier_id
     WHERE pv.id = $1 AND p.is_active = TRUE`, [variantId]
  );
  if (r.rows.length === 0) throw new Error('Produit introuvable ou inactif');
  const product = r.rows[0];
  return { ...product, price: product.discounted_price || product.base_price };
}

// ── 5. VALIDATION GPS ────────────────────────────────────────
const CAMEROON_BBOX = { minLat: 1.6, maxLat: 13.1, minLng: 8.4, maxLng: 16.2 };

async function validateGPSCoordinates(deliveryId, lat, lng) {
  const strictBbox = (await getSetting('gps_cameroon_bbox_strict', 'true')) === 'true';
  const maxSpeed   = parseFloat(await getSetting('gps_max_speed_kmh', '200'));

  if (strictBbox) {
    if (lat < CAMEROON_BBOX.minLat || lat > CAMEROON_BBOX.maxLat ||
        lng < CAMEROON_BBOX.minLng || lng > CAMEROON_BBOX.maxLng) {
      await logGPSAnomaly(deliveryId, 'OUT_OF_BOUNDS', `Coordonnées hors Cameroun: ${lat},${lng}`);
      throw new Error('Coordonnées GPS invalides pour cette région.');
    }
  }

  // Vérification vitesse impossible
  const lastPos = await query(
    `SELECT latitude, longitude, recorded_at FROM delivery_locations
     WHERE delivery_id = $1 ORDER BY recorded_at DESC LIMIT 1`, [deliveryId]
  );

  if (lastPos.rows.length > 0) {
    const last = lastPos.rows[0];
    const timeDiff = (Date.now() - new Date(last.recorded_at).getTime()) / 1000;
    if (timeDiff > 0) {
      const distKm = haversine(last.latitude, last.longitude, lat, lng);
      const speedKmh = (distKm / timeDiff) * 3600;
      if (speedKmh > maxSpeed) {
        await logGPSAnomaly(deliveryId, 'IMPOSSIBLE_SPEED', `Vitesse calculée: ${speedKmh.toFixed(0)} km/h`);
        throw new Error('Coordonnées GPS incohérentes (mouvement impossible détecté).');
      }
    }
  }

  return true;
}

async function checkGPSRateLimit(deliveryId) {
  const intervalSec = parseInt(await getSetting('gps_update_interval_sec', '5'));
  const last = await query(
    `SELECT recorded_at FROM delivery_locations
     WHERE delivery_id = $1 ORDER BY recorded_at DESC LIMIT 1`, [deliveryId]
  );
  if (last.rows.length > 0) {
    const diff = (Date.now() - new Date(last.rows[0].recorded_at).getTime()) / 1000;
    if (diff < intervalSec) throw new Error(`Mise à jour trop fréquente. Attendez ${intervalSec} secondes.`);
  }
  return true;
}

async function logGPSAnomaly(deliveryId, type, details) {
  await query(
    `INSERT INTO gps_anomalies (delivery_id, anomaly_type, details) VALUES ($1,$2,$3)`,
    [deliveryId, type, details]
  ).catch(() => {});
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── 6. VALIDATION VIDÉO ──────────────────────────────────────
const ALLOWED_MIME = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'];

async function validateVideo(file) {
  const maxMB = parseInt(await getSetting('video_max_size_mb', '500'));
  const minSec = parseInt(await getSetting('video_min_duration_sec', '30'));

  if (!file) throw new Error('Fichier vidéo manquant.');
  if (!ALLOWED_MIME.includes(file.mimetype)) {
    throw new Error(`Format vidéo non autorisé. Formats acceptés: MP4, WebM, MOV.`);
  }
  if (file.size > maxMB * 1024 * 1024) {
    throw new Error(`Vidéo trop volumineuse. Maximum ${maxMB}MB.`);
  }

  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  return { hash, valid: true, mime: file.mimetype, size: file.size };
}

// ── 7. TOKEN PAIEMENT EXTERNE ────────────────────────────────
async function generatePaymentToken(externalPaymentId) {
  const expiryHours = parseInt(await getSetting('payment_token_expiry_hours', '48'));
  const token = crypto.randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + expiryHours * 3600 * 1000);

  await query(
    `INSERT INTO payment_tokens (token, external_payment_id, expires_at)
     VALUES ($1, $2, $3)`, [token, externalPaymentId, expiresAt]
  );
  return token;
}

async function verifyPaymentToken(token) {
  const r = await query(
    `SELECT * FROM payment_tokens
     WHERE token = $1 AND used = FALSE AND expires_at > now()`, [token]
  );
  if (r.rows.length === 0) throw new Error('Code de paiement invalide ou expiré.');
  return r.rows[0];
}

async function consumePaymentToken(token) {
  await query(
    `UPDATE payment_tokens SET used = TRUE, used_at = now() WHERE token = $1`, [token]
  );
}

// ── 8. ALERTE FRAUDE ────────────────────────────────────────
async function createFraudAlert(userId, type, severity, details) {
  await query(
    `INSERT INTO fraud_alerts (user_id, alert_type, severity, details)
     VALUES ($1, $2, $3, $4)`, [userId, type, severity, details]
  ).catch(() => {});

  const alertOnForeign = await getSetting('alert_on_foreign_ip', 'true');
  if (alertOnForeign === 'true') {
    const superAdmins = await query(
      `SELECT whatsapp_number FROM admin_accounts WHERE role = 'super_admin' AND is_active = TRUE`
    );
    const { sendWhatsApp } = require('./NotificationService');
    for (const sa of superAdmins.rows) {
      await sendWhatsApp(sa.whatsapp_number,
        `⚠️ ALERTE SÉCURITÉ Play16\nType: ${type}\nSévérité: ${severity}\nUtilisateur: ${userId}\nDétails: ${details}`
      ).catch(() => {});
    }
  }
}

// ── 9. VÉRIFICATION CASHWORK — ANTI-AUTO-ACHAT ──────────────
async function checkNotOwnPost(postId, userId) {
  const r = await query(
    `SELECT posted_by_user_id FROM cash_work_posts WHERE id = $1`, [postId]
  );
  if (r.rows[0]?.posted_by_user_id === userId) {
    throw new Error('Vous ne pouvez pas accepter votre propre annonce Cash-Work.');
  }
}

async function checkCashworkInvoiceLimit(category, amount) {
  const maxFcfa = parseInt(await getSetting('cashwork_invoice_max_fcfa', '500000'));
  if (amount > maxFcfa) {
    throw new Error(`Montant de facture trop élevé. Maximum autorisé: ${maxFcfa.toLocaleString()} FCFA.`);
  }
}

// ── 10. MASQUAGE LOGS ────────────────────────────────────────
function maskSensitive(str) {
  if (!str) return str;
  return str.toString().replace(/(\d{3})\d{4,6}(\d{3})/g, '$1***$2');
}

module.exports = {
  getSetting,
  checkOTPRateLimit, recordOTPFailure, clearOTPAttempts,
  isTokenBlacklisted, blacklistToken,
  checkIdempotency, saveIdempotencyResult,
  getProductPrice,
  validateGPSCoordinates, checkGPSRateLimit,
  validateVideo,
  generatePaymentToken, verifyPaymentToken, consumePaymentToken,
  createFraudAlert,
  checkNotOwnPost, checkCashworkInvoiceLimit,
  maskSensitive,
};
