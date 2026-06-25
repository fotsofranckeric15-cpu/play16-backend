require('dotenv').config();
const { Pool } = require('pg');

async function migrate() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  async function safe(sql, label) {
    try { await pool.query(sql); console.log(`OK: ${label}`); }
    catch(err) {
      if (err.code==='42P07'||err.message.includes('already exists')) console.log(`SKIP: ${label}`);
      else { console.error(`ERR: ${label}:`, err.message); throw err; }
    }
  }

  try {
    await safe(`CREATE TABLE IF NOT EXISTS jwt_blacklist (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash VARCHAR(256) NOT NULL,
      revoked_at TIMESTAMPTZ DEFAULT now(),
      reason VARCHAR(100),
      revoked_by UUID
    )`, 'jwt_blacklist');

    await safe(`CREATE TABLE IF NOT EXISTS rate_limit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      identifier VARCHAR(100) NOT NULL,
      endpoint VARCHAR(100) NOT NULL,
      attempts INTEGER DEFAULT 1,
      window_start TIMESTAMPTZ DEFAULT now(),
      blocked_until TIMESTAMPTZ
    )`, 'rate_limit_log');

    await safe(`CREATE TABLE IF NOT EXISTS idempotency_keys (
      key VARCHAR(128) PRIMARY KEY,
      result_json TEXT,
      status_code INTEGER,
      created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ DEFAULT now() + INTERVAL '10 minutes'
    )`, 'idempotency_keys');

    await safe(`CREATE TABLE IF NOT EXISTS fraud_alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      alert_type VARCHAR(50) NOT NULL,
      severity VARCHAR(20) DEFAULT 'medium',
      details TEXT,
      resolved BOOLEAN DEFAULT FALSE,
      resolved_by UUID REFERENCES admin_accounts(id),
      created_at TIMESTAMPTZ DEFAULT now()
    )`, 'fraud_alerts');

    await safe(`CREATE TABLE IF NOT EXISTS security_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      description TEXT,
      updated_by UUID REFERENCES admin_accounts(id),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`, 'security_settings');

    await safe(`CREATE TABLE IF NOT EXISTS video_integrity (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      media_id UUID,
      sha256_hash VARCHAR(256),
      duration_sec INTEGER,
      mime_type VARCHAR(50),
      size_bytes BIGINT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`, 'video_integrity');

    await safe(`CREATE TABLE IF NOT EXISTS gps_anomalies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      delivery_id UUID REFERENCES deliveries(id),
      anomaly_type VARCHAR(50),
      details TEXT,
      detected_at TIMESTAMPTZ DEFAULT now()
    )`, 'gps_anomalies');

    await safe(`CREATE TABLE IF NOT EXISTS payment_tokens (
      token VARCHAR(16) PRIMARY KEY,
      external_payment_id UUID REFERENCES external_payments(id),
      expires_at TIMESTAMPTZ DEFAULT now() + INTERVAL '48 hours',
      used BOOLEAN DEFAULT FALSE,
      used_at TIMESTAMPTZ
    )`, 'payment_tokens');

    await safe(`CREATE TABLE IF NOT EXISTS otp_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_number VARCHAR(20) NOT NULL,
      attempts INTEGER DEFAULT 0,
      window_start TIMESTAMPTZ DEFAULT now(),
      blocked_until TIMESTAMPTZ
    )`, 'otp_attempts');

    await safe(`CREATE INDEX IF NOT EXISTS idx_jwt_blacklist_hash ON jwt_blacklist(token_hash)`, 'idx jwt_blacklist');
    await safe(`CREATE INDEX IF NOT EXISTS idx_rate_limit ON rate_limit_log(identifier, endpoint)`, 'idx rate_limit');
    await safe(`CREATE INDEX IF NOT EXISTS idx_fraud_alerts ON fraud_alerts(user_id, resolved)`, 'idx fraud_alerts');
    await safe(`CREATE INDEX IF NOT EXISTS idx_otp_attempts ON otp_attempts(phone_number)`, 'idx otp_attempts');
    await safe(`CREATE INDEX IF NOT EXISTS idx_payment_tokens ON payment_tokens(token, used)`, 'idx payment_tokens');

    // Paramètres de sécurité par défaut
    const securityDefaults = [
      ['otp_max_attempts', '5', 'Tentatives OTP max avant blocage'],
      ['otp_block_duration_min', '30', 'Durée blocage OTP après échecs (minutes)'],
      ['otp_per_hour_limit', '3', 'Envois OTP max par heure par numéro'],
      ['jwt_expiry_days', '30', 'Durée de validité des tokens JWT (jours)'],
      ['session_timeout_admin_min', '60', 'Timeout session admin (minutes)'],
      ['payment_idempotency_ttl_min', '10', 'TTL clé idempotence paiement (minutes)'],
      ['escrow_timeout_alert_hours', '48', 'Délai alerte séquestre bloqué (heures)'],
      ['refund_auto_approval_max_fcfa', '0', 'Montant max remboursement auto sans validation Super Admin (0=jamais)'],
      ['cashback_min_delay_after_delivery_min', '30', 'Délai min entre livraison et confirmation cashback (minutes)'],
      ['gps_max_speed_kmh', '200', 'Vitesse GPS max avant alerte fraude (km/h)'],
      ['gps_update_interval_sec', '5', 'Intervalle min entre updates GPS (secondes)'],
      ['gps_cameroon_bbox_strict', 'true', 'Validation coordonnées GPS dans bbox Cameroun'],
      ['video_min_duration_sec', '30', 'Durée min vidéo emballage (secondes)'],
      ['video_max_size_mb', '500', 'Taille max vidéo upload (MB)'],
      ['alert_on_foreign_ip', 'true', 'Alerte Super Admin si connexion IP étrangère'],
      ['alert_on_multiple_accounts', 'true', 'Alerte si tentative multi-comptes détectée'],
      ['cashwork_invoice_max_fcfa', '500000', 'Montant max facture Cash-Work (FCFA)'],
      ['auto_validate_external_payment_hours', '24', 'Délai auto-validation paiement externe (heures)'],
      ['payment_token_expiry_hours', '48', 'Durée validité token paiement externe (heures)'],
    ];

    for (const [key, value, description] of securityDefaults) {
      await pool.query(
        `INSERT INTO security_settings (key, value, description)
         VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING`,
        [key, value, description]
      );
    }
    console.log('OK: security_settings defaults');
    console.log('\nMigration securite terminee avec succes.');
  } catch(err) {
    console.error('Echec:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
