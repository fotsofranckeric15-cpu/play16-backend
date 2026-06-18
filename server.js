require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ensureCatalogSeeded } = require('./integrationRegistry');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'play16-backend', time: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Erreur interne.' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await ensureCatalogSeeded();
    console.log('[Boot] Catalogue des intégrations initialisé.');
  } catch (err) {
    console.error('[Boot] Erreur catalogue (non bloquant):', err.message);
  }
  app.listen(PORT, () => {
    console.log(`[Boot] Play16 backend démarré sur le port ${PORT}`);
  });
}

start();
module.exports = app;
