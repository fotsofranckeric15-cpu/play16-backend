// ============================================================
// PLAY16 — Point d'entrée serveur
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { ensureCatalogSeeded } = require('./services/integrationRegistry');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Limite générale anti-abus — n'empêche pas l'usage normal,
// protège contre les scripts/bots.
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
  })
);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'play16-backend', time: new Date().toISOString() });
});

// Routes métier — branchées progressivement au fil des étapes.
// app.use('/api/auth', require('./routes/auth'));
// app.use('/api/products', require('./routes/products'));
// app.use('/api/orders', require('./routes/orders'));
// app.use('/api/cashwork', require('./routes/cashwork'));
// app.use('/api/admin', require('./routes/admin'));
// app.use('/api/integrations', require('./routes/integrations'));

// Gestion d'erreur globale — ne fait jamais planter le process.
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Erreur interne. Notre équipe a été notifiée.' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await ensureCatalogSeeded();
    console.log('[Boot] Catalogue des intégrations vérifié/initialisé.');
  } catch (err) {
    console.error('[Boot] Impossible de vérifier le catalogue d\'intégrations:', err.message);
    console.error('[Boot] Le serveur démarre tout de même — vérifie DATABASE_URL.');
  }

  app.listen(PORT, () => {
    console.log(`[Boot] PLAY16 backend démarré sur le port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
}

start();

module.exports = app;
