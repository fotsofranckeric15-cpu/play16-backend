// ============================================================
// PLAY16 — Point d'entrée serveur (Étape 2)
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ensureCatalogSeeded } = require('./integrationRegistry');
const { seedDefaultSettings } = require('./routesSettings');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true }));

// ── HEALTH CHECK ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'play16-backend', time: new Date().toISOString() });
});

// ── ROUTES API ───────────────────────────────────────────────
app.use('/api/auth', require('./routesAuth'));
app.use('/api/products', require('./routesProducts'));
app.use('/api/settings', require('./routesSettings').router);

// ── GESTION D'ERREURS GLOBALE ───────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Erreur interne.' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await ensureCatalogSeeded();
    console.log('[Boot] Catalogue des intégrations initialisé.');
    await seedDefaultSettings();
    console.log('[Boot] Paramètres par défaut vérifiés.');
  } catch (err) {
    console.error('[Boot] Erreur initialisation (non bloquant):', err.message);
  }
  app.listen(PORT, () => {
    console.log(`[Boot] Play16 backend démarré sur le port ${PORT}`);
  });
}

start();
module.exports = app;
