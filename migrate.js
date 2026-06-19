require('dotenv').config();
const { Pool } = require('pg');

async function migrate() {
  if (!process.env.DATABASE_URL) { console.error('[Migrate] DATABASE_URL manquant.'); process.exit(1); }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  async function safe(sql, label) {
    try {
      await pool.query(sql);
      console.log(`[Migrate] OK: ${label}`);
    } catch (err) {
      if (err.code === '42P07' || err.code === '42710' || err.message.includes('already exists')) {
        console.log(`[Migrate] SKIP: ${label} (deja existant)`);
      } else {
        console.error(`[Migrate] ERREUR: ${label}:`, err.message);
        throw err;
      }
    }
  }

  try {
    await safe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`, 'pgcrypto');
    await safe(`CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone_number VARCHAR(20) UNIQUE NOT NULL, whatsapp_number VARCHAR(20), full_name VARCHAR(150), password_hash TEXT, is_client BOOLEAN DEFAULT TRUE, is_supplier BOOLEAN DEFAULT FALSE, is_cash_worker BOOLEAN DEFAULT FALSE, supplier_verified BOOLEAN DEFAULT FALSE, identity_verification_status VARCHAR(20) DEFAULT 'none', two_fa_enabled BOOLEAN DEFAULT FALSE, cashback_balance INTEGER DEFAULT 0, trust_score INTEGER DEFAULT 100, cgu_accepted_version INTEGER DEFAULT 0, cgu_accepted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ)`, 'users');
    await safe(`CREATE TABLE admin_accounts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), full_name VARCHAR(150) NOT NULL, role VARCHAR(30) NOT NULL, whatsapp_number VARCHAR(20) NOT NULL, password_hash TEXT NOT NULL, must_change_password BOOLEAN DEFAULT TRUE, extended_access BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now())`, 'admin_accounts');
    await safe(`CREATE TABLE admin_sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), admin_id UUID REFERENCES admin_accounts(id), whatsapp_number_used VARCHAR(20) NOT NULL, started_at TIMESTAMPTZ DEFAULT now(), ended_at TIMESTAMPTZ, ip_address VARCHAR(45))`, 'admin_sessions');
    await safe(`CREATE TABLE admin_session_actions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id UUID REFERENCES admin_sessions(id), action_type VARCHAR(50) NOT NULL, description TEXT, target_table VARCHAR(50), target_id UUID, created_at TIMESTAMPTZ DEFAULT now())`, 'admin_session_actions');
    await safe(`CREATE TABLE supervision_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), super_admin_id UUID REFERENCES admin_accounts(id), viewed_admin_id UUID REFERENCES admin_accounts(id), started_at TIMESTAMPTZ DEFAULT now(), ended_at TIMESTAMPTZ)`, 'supervision_logs');
    await safe(`CREATE TABLE password_change_requests (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), admin_id UUID REFERENCES admin_accounts(id), new_password_hash TEXT NOT NULL, requested_at TIMESTAMPTZ DEFAULT now(), activates_at TIMESTAMPTZ NOT NULL, delay_days INTEGER DEFAULT 32, status VARCHAR(20) DEFAULT 'pending', ip_address VARCHAR(45))`, 'password_change_requests');
    await safe(`CREATE TABLE cgu_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), version_number INTEGER NOT NULL, content TEXT NOT NULL, module VARCHAR(30), published_at TIMESTAMPTZ DEFAULT now(), published_by UUID REFERENCES admin_accounts(id))`, 'cgu_versions');
    await safe(`CREATE TABLE products (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id UUID REFERENCES users(id), name VARCHAR(200) NOT NULL, description TEXT, category VARCHAR(50), base_price INTEGER NOT NULL, discounted_price INTEGER, cashback_amount INTEGER DEFAULT 0, is_active BOOLEAN DEFAULT TRUE, boost_level_requested INTEGER DEFAULT 0, boost_level_active INTEGER DEFAULT 0, boost_status VARCHAR(20) DEFAULT 'none', image_urls TEXT[], click_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now())`, 'products');
    await safe(`CREATE TABLE product_variants (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id UUID REFERENCES products(id), color VARCHAR(50), size VARCHAR(20), stock INTEGER DEFAULT 0)`, 'product_variants');
    await safe(`CREATE TABLE product_clicks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id UUID REFERENCES products(id), user_id UUID REFERENCES users(id), ip_address VARCHAR(45), clicked_at TIMESTAMPTZ DEFAULT now())`, 'product_clicks');
    await safe(`CREATE TABLE boost_requests (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), product_id UUID REFERENCES products(id), requested_level INTEGER NOT NULL, requested_at TIMESTAMPTZ DEFAULT now(), status VARCHAR(20) DEFAULT 'pending', reviewed_by UUID REFERENCES admin_accounts(id), reviewed_at TIMESTAMPTZ)`, 'boost_requests');
    await safe(`CREATE TABLE orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), client_id UUID REFERENCES users(id), supplier_id UUID REFERENCES users(id), product_variant_id UUID REFERENCES product_variants(id), total_amount INTEGER NOT NULL, status VARCHAR(30) DEFAULT 'pending', payment_method VARCHAR(20), created_by_admin_id UUID REFERENCES admin_accounts(id), created_at TIMESTAMPTZ DEFAULT now())`, 'orders');
    await safe(`CREATE TABLE deliveries (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID REFERENCES orders(id), delivery_person_id UUID REFERENCES users(id), status VARCHAR(30) DEFAULT 'awaiting_pickup', location_sharing_client_enabled BOOLEAN DEFAULT FALSE, created_by_admin_id UUID REFERENCES admin_accounts(id), completed_at TIMESTAMPTZ)`, 'deliveries');
    await safe(`CREATE TABLE delivery_locations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id UUID REFERENCES deliveries(id), latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL, recorded_at TIMESTAMPTZ DEFAULT now())`, 'delivery_locations');
    await safe(`CREATE TABLE cashback_transactions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), order_id UUID REFERENCES orders(id), amount INTEGER NOT NULL, type VARCHAR(20) DEFAULT 'purchase', created_at TIMESTAMPTZ DEFAULT now())`, 'cashback_transactions');
    await safe(`CREATE TABLE referrals (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), referrer_id UUID REFERENCES users(id), referred_id UUID REFERENCES users(id), signup_bonus_paid BOOLEAN DEFAULT FALSE, first_purchase_bonus_paid BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now())`, 'referrals');
    await safe(`CREATE TABLE qr_lots (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), created_by_super_admin_id UUID REFERENCES admin_accounts(id) NOT NULL, target_buyer_count INTEGER NOT NULL, crypto_seed VARCHAR(128) NOT NULL, status VARCHAR(20) DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT now())`, 'qr_lots');
    await safe(`CREATE TABLE qr_lot_rewards (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), qr_lot_id UUID REFERENCES qr_lots(id), reward_type VARCHAR(50), reward_value VARCHAR(100), winner_count INTEGER NOT NULL)`, 'qr_lot_rewards');
    await safe(`CREATE TABLE qr_codes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), qr_lot_id UUID REFERENCES qr_lots(id), order_id UUID REFERENCES orders(id), reward_id UUID REFERENCES qr_lot_rewards(id), is_winner BOOLEAN DEFAULT FALSE, activated_by_client BOOLEAN DEFAULT FALSE, scanned_at TIMESTAMPTZ, drawn_at TIMESTAMPTZ DEFAULT now())`, 'qr_codes');
    await safe(`CREATE TABLE cash_work_posts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), posted_by_user_id UUID REFERENCES users(id), description TEXT NOT NULL, category VARCHAR(50), location_lat DOUBLE PRECISION, location_lng DOUBLE PRECISION, status VARCHAR(20) DEFAULT 'open', last_reminder_sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`, 'cash_work_posts');
    await safe(`CREATE TABLE cash_work_missions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID REFERENCES cash_work_posts(id), client_id UUID REFERENCES users(id), worker_id UUID REFERENCES users(id), invoice_amount INTEGER, commission_rate NUMERIC(5,2) DEFAULT 1.00, status VARCHAR(30) DEFAULT 'pending_invoice', escrowed_at TIMESTAMPTZ, validated_at TIMESTAMPTZ, location_tracking_active BOOLEAN DEFAULT FALSE, off_platform_payment_flagged BOOLEAN DEFAULT FALSE, off_platform_payment_flagged_by VARCHAR(20), created_at TIMESTAMPTZ DEFAULT now())`, 'cash_work_missions');
    await safe(`CREATE TABLE cash_work_proof_media (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), mission_id UUID REFERENCES cash_work_missions(id), media_type VARCHAR(20), url TEXT NOT NULL, uploaded_at TIMESTAMPTZ DEFAULT now())`, 'cash_work_proof_media');
    await safe(`CREATE TABLE external_payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), buyer_id UUID REFERENCES users(id), seller_whatsapp_number VARCHAR(20) NOT NULL, amount INTEGER NOT NULL, description_text TEXT, description_voice_url TEXT, expected_delivery_date DATE, travel_agency_estimate VARCHAR(150), requested_proofs TEXT, status VARCHAR(30) DEFAULT 'escrowed', seller_accepted_at TIMESTAMPTZ, buyer_expected_date DATE, seller_expected_date DATE, no_action_deadline TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`, 'external_payments');
    await safe(`CREATE TABLE external_payment_media (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), external_payment_id UUID REFERENCES external_payments(id), media_type VARCHAR(30), url TEXT, was_ignored BOOLEAN DEFAULT FALSE, recorded_without_interruption BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now())`, 'external_payment_media');
    await safe(`CREATE TABLE disputes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), module VARCHAR(20) NOT NULL, related_id UUID NOT NULL, handled_by_admin_id UUID REFERENCES admin_accounts(id), pv_content TEXT, resolution_type VARCHAR(30), escalated_to_super_admin BOOLEAN DEFAULT FALSE, attestation_pdf_url TEXT, created_at TIMESTAMPTZ DEFAULT now(), resolved_at TIMESTAMPTZ)`, 'disputes');
    await safe(`CREATE TABLE account_blocks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), blocked_by_admin_id UUID REFERENCES admin_accounts(id) NOT NULL, reason TEXT NOT NULL, resolution_attempts TEXT NOT NULL, blocked_at TIMESTAMPTZ DEFAULT now(), unblocked_at TIMESTAMPTZ, unblocked_by_super_admin_id UUID REFERENCES admin_accounts(id))`, 'account_blocks');
    await safe(`CREATE TABLE settings_integrations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider_name VARCHAR(50) UNIQUE NOT NULL, is_active BOOLEAN DEFAULT FALSE, config_json JSONB DEFAULT '{}', schema_version INTEGER DEFAULT 1, last_tested_at TIMESTAMPTZ, last_test_status VARCHAR(20) DEFAULT 'never')`, 'settings_integrations');
    await safe(`CREATE TABLE platform_settings (key VARCHAR(100) PRIMARY KEY, value TEXT NOT NULL, description TEXT, updated_by UUID REFERENCES admin_accounts(id), updated_at TIMESTAMPTZ DEFAULT now())`, 'platform_settings');
    await safe(`CREATE TABLE simulation_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), provider_name VARCHAR(50), description TEXT, created_at TIMESTAMPTZ DEFAULT now())`, 'simulation_logs');
    await safe(`CREATE TABLE otp_codes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone_number VARCHAR(20) NOT NULL, code VARCHAR(6) NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`, 'otp_codes');
    await safe(`CREATE INDEX idx_products_boost ON products(is_active, boost_level_active DESC)`, 'index produits');
    await safe(`CREATE INDEX idx_product_clicks ON product_clicks(product_id, clicked_at DESC)`, 'index clics');
    await safe(`CREATE INDEX idx_orders_client ON orders(client_id, created_at DESC)`, 'index commandes');
    await safe(`CREATE INDEX idx_otp_phone ON otp_codes(phone_number)`, 'index otp');
    console.log('\n[Migrate] Migration terminee avec succes.');
  } catch (err) {
    console.error('[Migrate] Erreur fatale:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
