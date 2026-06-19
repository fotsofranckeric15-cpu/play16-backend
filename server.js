// ============================================================
// PLAY16 — Point d'entrée serveur (Étape 3)
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
  res.json({ status: 'ok', service: 'play16-backend', version: '3.0', time: new Date().toISOString() });
});

// ── ROUTES API ───────────────────────────────────────────────
app.use('/api/auth',              require('./routesAuth'));
app.use('/api/products',          require('./routesProducts'));
app.use('/api/settings',          require('./routesSettings').router);
app.use('/api/orders',            require('./routesOrders'));
app.use('/api/deliveries',        require('./routesDeliveries'));
app.use('/api/cashwork',          require('./routesCashWork'));
app.use('/api/external-payments', require('./routesExternalPayments'));

// ── GESTION D'ERREURS GLOBALE ───────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Erreur interne.' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await ensureCatalogSeeded();
    await seedDefaultSettings();
    console.log('[Boot] Play16 backend v3.0 initialisé.');
  } catch (err) {
    console.error('[Boot] Erreur initialisation (non bloquant):', err.message);
  }
  app.listen(PORT, () => {
    console.log(`[Boot] Play16 backend démarré sur le port ${PORT}`);
  });
}

start();
module.exports = app;
