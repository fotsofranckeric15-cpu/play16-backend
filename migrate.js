// ============================================================
// PLAY16 — Script de migration
// ============================================================
// Usage : npm run migrate
// Applique schema.sql à la base de données pointée par
// DATABASE_URL (Railway le fournit automatiquement).
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

  const schemaPath = path.join(__dirname, '..', '..', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  // Ajout de l'extension nécessaire pour gen_random_uuid()
  const setupSql = `CREATE EXTENSION IF NOT EXISTS pgcrypto;`;

  // Table de log des simulations (référencée par integrationRegistry)
  const simLogSql = `
    CREATE TABLE IF NOT EXISTS simulation_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_name VARCHAR(50),
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `;

  try {
    console.log('[Migrate] Activation extension pgcrypto...');
    await pool.query(setupSql);

    console.log('[Migrate] Application du schéma principal...');
    await pool.query(schemaSql);

    console.log('[Migrate] Création table simulation_logs...');
    await pool.query(simLogSql);

    console.log('[Migrate] ✅ Migration terminée avec succès.');
  } catch (err) {
    console.error('[Migrate] ❌ Échec de la migration:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
