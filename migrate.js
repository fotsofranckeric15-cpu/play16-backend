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
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
    await pool.query(schemaSql);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS simulation_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_name VARCHAR(50),
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    console.log('[Migrate] Migration terminée avec succès.');
  } catch (err) {
    console.error('[Migrate] Echec:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
migrate();
