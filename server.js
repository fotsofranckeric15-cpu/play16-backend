// ============================================================
// PLAY16 — Serveur v4.1 + Interface Admin
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');
const fs      = require('fs');
const rateLimit = require('express-rate-limit');
const { ensureCatalogSeeded }  = require('./integrationRegistry');
const { seedDefaultSettings }  = require('./routesSettings');
const { seedFeatureFlags, requireFeature } = require('./routesFeatures');
const { query } = require('./pool');

const app = express();

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50mb' }));
app.use(rateLimit({ windowMs:15*60*1000, max:300, standardHeaders:true }));

// ── INTERFACE ADMIN (lit le fichier admin.html à plat) ───────
app.get('/admin', (req, res) => {
  const filePath = path.join(__dirname, 'admin.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('admin.html introuvable. Vérifiez qu\'il est bien à la racine du projet.');
  }
});

// ── HEALTH ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status:'ok', service:'play16-backend', version:'4.1', time:new Date().toISOString() });
});

// ── ROUTES API ───────────────────────────────────────────────
app.use('/api/auth',             require('./routesAuth'));
app.use('/api/features',         require('./routesFeatures').router);
app.use('/api/products',         require('./routesProducts'));
app.use('/api/settings',         require('./routesSettings').router);
app.use('/api/orders',           require('./routesOrders'));
app.use('/api/deliveries',       require('./routesDeliveries'));
app.use('/api/cashwork',         requireFeature('cash_work_system'), require('./routesCashWork'));
app.use('/api/external-payments',requireFeature('external_payment_escrow'), require('./routesExternalPayments'));
app.use('/api/superadmin',       require('./routesSuperAdmin'));
app.use('/api/disputes',         require('./routesDisputes'));
app.use('/api/reports',          require('./routesReports'));
app.use('/api/security',         require('./routesSecurity'));

// ── ERREURS ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Erreur interne.' });
});

const PORT = process.env.PORT || 3000;

async function seedSecurityDefaults() {
  const defaults = [
    ['otp_max_attempts','5'],['otp_block_duration_min','30'],['otp_per_hour_limit','3'],
    ['jwt_expiry_days','30'],['gps_max_speed_kmh','200'],['gps_update_interval_sec','5'],
    ['gps_cameroon_bbox_strict','true'],['video_min_duration_sec','30'],['video_max_size_mb','500'],
    ['cashback_min_delay_after_delivery_min','30'],['cashwork_invoice_max_fcfa','500000'],
    ['payment_token_expiry_hours','48'],['alert_on_foreign_ip','true'],
    ['payment_idempotency_ttl_min','10'],['escrow_timeout_alert_hours','48'],
  ];
  for (const [k,v] of defaults) {
    await query(`INSERT INTO security_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`,[k,v]).catch(()=>{});
  }
}

async function start() {
  try {
    await ensureCatalogSeeded();
    await seedDefaultSettings();
    await seedFeatureFlags();
    await seedSecurityDefaults();
    console.log('[Boot] Play16 v4.1 — tous modules initialisés.');
  } catch (err) {
    console.error('[Boot] Erreur init:', err.message);
  }
  app.listen(PORT, () => console.log(`[Boot] Play16 démarré sur le port ${PORT}`));
}

start();
module.exports = app;
