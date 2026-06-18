// ============================================================
// PLAY16 — Connexion PostgreSQL (Railway)
// ============================================================
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('[FATAL] DATABASE_URL manquant. Vérifie les variables Railway.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // Une erreur de connexion DB ne doit jamais faire planter tout
  // le process — elle est journalisée, le reste de l'app continue.
  console.error('[DB] Erreur pool inattendue:', err.message);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 500) {
      console.warn(`[DB] Requête lente (${duration}ms): ${text.slice(0, 80)}`);
    }
    return res;
  } catch (err) {
    console.error('[DB] Erreur requête:', err.message, '| Query:', text.slice(0, 120));
    throw err;
  }
}

module.exports = { pool, query };
