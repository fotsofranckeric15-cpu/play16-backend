// ============================================================
// PLAY16 — Script de migration (corrigé — idempotent)
// ============================================================
// Ce script peut être relancé autant de fois que nécessaire
// sans jamais planter, même si les tables existent déjà.
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.error('[Migrate] DATABASE_URL manquant.');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('[Migrate] Extension pgcrypto...');
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

    console.log('[Migrate] Tables principales (IF NOT EXISTS)...');
    // Toutes les tables utilisent CREATE TABLE IF NOT EXISTS
    // donc ce bloc est sûr même si les tables existent déjà.
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    // Sécurité supplémentaire : on remplace au cas où
    const safeSql = schemaSql.replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS ');
    await pool.query(safeSql);

    console.log('[Migrate] Table simulation_logs...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS simulation_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_name VARCHAR(50),
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    console.log('[Migrate] Table otp_codes...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_codes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number VARCHAR(20) NOT NULL,
        code VARCHAR(6) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    console.log('[Migrate] Index de performance...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_products_active_boost
        ON products(is_active, boost_level_active DESC);
      CREATE INDEX IF NOT EXISTS idx_product_clicks_product
        ON product_clicks(product_id, clicked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_client
        ON orders(client_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_otp_phone
        ON otp_codes(phone_number);
    `);

    console.log('[Migrate] ✅ Migration terminée avec succès.');
  } catch (err) {
    console.error('[Migrate] ❌ Echec:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
