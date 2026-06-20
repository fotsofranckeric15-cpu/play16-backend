// ============================================================
// PLAY16 — Point d'entrée serveur (Version finale v4.1)
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ensureCatalogSeeded } = require('./integrationRegistry');
const { seedDefaultSettings } = require('./routesSettings');
const { seedFeatureFlags, requireFeature } = require('./routesFeatures');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true }));

// ── HEALTH CHECK ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'play16-backend',
    version: '4.1',
    time: new Date().toISOString(),
  });
});

// ── ROUTES DE BASE (toujours actives) ───────────────────────
app.use('/api/auth',     require('./routesAuth'));
app.use('/api/products', require('./routesProducts'));
app.use('/api/settings', require('./routesSettings').router);
app.use('/api/features', require('./routesFeatures').router);

// ── ROUTES CONDITIONNELLES (désactivables par feature flag) ─

// Commandes — toujours actives (fonctionnalité de base)
app.use('/api/orders', require('./routesOrders'));

// Livraisons — toujours actives
app.use('/api/deliveries', require('./routesDeliveries'));

// Cash-Work — désactivé en mode Store Review
app.use('/api/cashwork',
  requireFeature('cash_work_system'),
  require('./routesCashWork')
);

// Paiement externe — désactivé en mode Store Review
app.use('/api/external-payments',
  requireFeature('external_payment_escrow'),
  require('./routesExternalPayments')
);

// ── ROUTES ADMINISTRATION ────────────────────────────────────
app.use('/api/superadmin', require('./routesSuperAdmin'));
app.use('/api/disputes',   require('./routesDisputes'));
app.use('/api/reports',    require('./routesReports'));

// ── GESTION D'ERREURS GLOBALE ────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Erreur interne.' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await ensureCatalogSeeded();
    await seedDefaultSettings();
    await seedFeatureFlags();
    console.log('[Boot] Play16 backend v4.1 — Feature flags initialisés.');
  } catch (err) {
    console.error('[Boot] Erreur initialisation (non bloquant):', err.message);
  }
  app.listen(PORT, () => {
    console.log(`[Boot] Play16 backend v4.1 démarré sur le port ${PORT}`);
  });
}

start();
module.exports = app;
