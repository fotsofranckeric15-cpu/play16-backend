// ============================================================
// PLAY16 — Système de Feature Flags
// Inclut le mode PLAY_STORE_REVIEW_MODE
// ============================================================
// Principe : chaque fonctionnalité peut être activée ou
// désactivée à chaud depuis Super Admin > Paramètres > Modules.
// Aucune modification de code, aucun redéploiement.
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('./pool');
const { authSuperAdmin } = require('./authMiddleware');

// ── LISTE DES FONCTIONNALITÉS GÉRÉES PAR FLAGS ──────────────
const FEATURE_FLAGS = {
  // ── Marketplace de base (JAMAIS désactivées) ──────────────
  user_registration:        { label: 'Inscription utilisateur',        always_on: true },
  product_catalog:          { label: 'Catalogue produits',             always_on: true },
  product_search:           { label: 'Recherche produits',             always_on: true },
  orders:                   { label: 'Commandes',                      always_on: true },
  standard_payment:         { label: 'Paiement standard',              always_on: true },
  buyer_seller_messaging:   { label: 'Messagerie acheteur-vendeur',    always_on: true },
  standard_notifications:   { label: 'Notifications classiques',       always_on: true },
  account_management:       { label: 'Gestion de compte',              always_on: true },

  // ── Fonctionnalités avancées (désactivables) ──────────────
  cashback_system:          { label: 'Système cashback',               always_on: false, store_review_off: true },
  wallet_balance:           { label: 'Solde portefeuille',             always_on: false, store_review_off: true },
  withdrawals:              { label: 'Retraits',                       always_on: false, store_review_off: true },
  installment_credit:       { label: 'Crédit / paiement en différé',   always_on: false, store_review_off: true },
  cash_work_system:         { label: 'Module Cash-Work',               always_on: false, store_review_off: true },
  lottery_system:           { label: 'Système QR / loterie',           always_on: false, store_review_off: true },
  referral_rewards:         { label: 'Système de parrainage',          always_on: false, store_review_off: true },
  reward_notifications:     { label: 'Notifications de gains',         always_on: false, store_review_off: true },
  boost_system:             { label: 'Mise en avant produits (boost)', always_on: false, store_review_off: false },
  supplier_verification:    { label: 'Vérification fournisseur',       always_on: false, store_review_off: false },
  external_payment_escrow:  { label: 'Paiement externe sécurisé',      always_on: false, store_review_off: true },
  two_fa:                   { label: 'Double authentification (2FA)',   always_on: false, store_review_off: false },
};

// ── INITIALISER LES FLAGS EN BASE ───────────────────────────
async function seedFeatureFlags() {
  for (const [key, config] of Object.entries(FEATURE_FLAGS)) {
    const defaultValue = config.always_on ? 'true' : 'true';
    await query(
      `INSERT INTO platform_settings (key, value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [
        `feature_${key}`,
        defaultValue,
        `[FEATURE] ${config.label}${config.always_on ? ' [TOUJOURS ACTIVE]' : ''}${config.store_review_off ? ' [DÉSACTIVÉE EN MODE STORE]' : ''}`,
      ]
    );
  }

  // Flag du mode Store Review
  await query(
    `INSERT INTO platform_settings (key, value, description)
     VALUES ('play_store_review_mode', 'false', 'Mode validation Google Play / App Store — désactive les fonctionnalités financières avancées')
     ON CONFLICT (key) DO NOTHING`
  );
}

// ── VÉRIFIER SI UNE FEATURE EST ACTIVE ──────────────────────
// Utilisé par toutes les routes pour bloquer si nécessaire
async function isFeatureEnabled(featureKey) {
  // Les features always_on ne peuvent jamais être désactivées
  const config = FEATURE_FLAGS[featureKey];
  if (config?.always_on) return true;

  // Vérifier si mode Store Review actif
  const storeMode = await query(
    `SELECT value FROM platform_settings WHERE key = 'play_store_review_mode'`
  );
  const isStoreMode = storeMode.rows[0]?.value === 'true';

  if (isStoreMode && config?.store_review_off) return false;

  // Vérifier le flag individuel
  const result = await query(
    `SELECT value FROM platform_settings WHERE key = $1`,
    [`feature_${featureKey}`]
  );
  return result.rows[0]?.value !== 'false';
}

// ── MIDDLEWARE : bloquer une route si feature désactivée ─────
function requireFeature(featureKey) {
  return async (req, res, next) => {
    const enabled = await isFeatureEnabled(featureKey);
    if (!enabled) {
      return res.status(403).json({
        error: 'Fonctionnalité non disponible',
        feature: featureKey,
        reason: 'Cette fonctionnalité est temporairement désactivée par l\'administrateur.',
      });
    }
    next();
  };
}

// ── ROUTES SUPER ADMIN ───────────────────────────────────────

// GET /api/features — liste tous les flags avec leur état
router.get('/', authSuperAdmin, async (req, res) => {
  try {
    await seedFeatureFlags();

    const storeMode = await query(
      `SELECT value FROM platform_settings WHERE key = 'play_store_review_mode'`
    );
    const isStoreMode = storeMode.rows[0]?.value === 'true';

    const flags = [];
    for (const [key, config] of Object.entries(FEATURE_FLAGS)) {
      const result = await query(
        `SELECT value FROM platform_settings WHERE key = $1`,
        [`feature_${key}`]
      );
      const individualValue = result.rows[0]?.value !== 'false';
      const effectiveValue = config.always_on
        ? true
        : isStoreMode && config.store_review_off
          ? false
          : individualValue;

      flags.push({
        key,
        label: config.label,
        always_on: config.always_on || false,
        store_review_off: config.store_review_off || false,
        individual_setting: individualValue,
        effective_status: effectiveValue,
        reason: config.always_on
          ? 'Toujours active (fonctionnalité de base)'
          : isStoreMode && config.store_review_off
            ? 'Désactivée automatiquement — Mode Store Review actif'
            : null,
      });
    }

    res.json({
      play_store_review_mode: isStoreMode,
      features: flags,
    });
  } catch (err) {
    console.error('[Features] Erreur liste:', err.message);
    res.status(500).json({ error: 'Erreur chargement features' });
  }
});

// PUT /api/features/:key — activer/désactiver une feature
router.put('/:key', authSuperAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { enabled } = req.body;

    if (!FEATURE_FLAGS[key]) {
      return res.status(404).json({ error: 'Feature inconnue' });
    }

    if (FEATURE_FLAGS[key].always_on) {
      return res.status(400).json({
        error: 'Cette fonctionnalité ne peut pas être désactivée — elle est indispensable au fonctionnement de base.'
      });
    }

    await query(
      `UPDATE platform_settings SET value = $1, updated_at = now()
       WHERE key = $2`,
      [enabled ? 'true' : 'false', `feature_${key}`]
    );

    res.json({
      success: true,
      feature: key,
      label: FEATURE_FLAGS[key].label,
      enabled: !!enabled,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur modification feature' });
  }
});

// POST /api/features/store-review/activate
// Active le mode PLAY_STORE_REVIEW_MODE
router.post('/store-review/activate', authSuperAdmin, async (req, res) => {
  try {
    await query(
      `UPDATE platform_settings SET value = 'true', updated_at = now()
       WHERE key = 'play_store_review_mode'`
    );

    const disabled = Object.entries(FEATURE_FLAGS)
      .filter(([, c]) => c.store_review_off)
      .map(([k, c]) => c.label);

    res.json({
      success: true,
      mode: 'PLAY_STORE_REVIEW_MODE',
      status: 'ACTIVÉ',
      message: 'L\'application fonctionne maintenant comme une marketplace classique. Aucune fonctionnalité financière avancée n\'est visible.',
      automatically_disabled: disabled,
      note: 'Aucune modification de code ni redéploiement nécessaire. Désactivez ce mode après validation sur le Store.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur activation mode Store' });
  }
});

// POST /api/features/store-review/deactivate
// Désactive le mode — réactive progressivement
router.post('/store-review/deactivate', authSuperAdmin, async (req, res) => {
  try {
    const { features_to_reactivate } = req.body;
    // Si non spécifié, on laisse les flags individuels décider

    await query(
      `UPDATE platform_settings SET value = 'false', updated_at = now()
       WHERE key = 'play_store_review_mode'`
    );

    // Réactiver sélectivement si demandé
    if (features_to_reactivate?.length) {
      for (const featureKey of features_to_reactivate) {
        if (FEATURE_FLAGS[featureKey] && !FEATURE_FLAGS[featureKey].always_on) {
          await query(
            `UPDATE platform_settings SET value = 'true' WHERE key = $1`,
            [`feature_${featureKey}`]
          );
        }
      }
    }

    res.json({
      success: true,
      mode: 'PLAY_STORE_REVIEW_MODE',
      status: 'DÉSACTIVÉ',
      reactivated: features_to_reactivate || 'Toutes (selon réglages individuels)',
      message: 'Mode Store Review désactivé. Les fonctionnalités reprennent selon leurs réglages individuels.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur désactivation mode Store' });
  }
});

// GET /api/features/app-config
// Endpoint appelé par l'app mobile au démarrage
// Retourne la config complète (quoi afficher ou cacher)
router.get('/app-config', async (req, res) => {
  try {
    await seedFeatureFlags();

    const storeMode = await query(
      `SELECT value FROM platform_settings WHERE key = 'play_store_review_mode'`
    );
    const isStoreMode = storeMode.rows[0]?.value === 'true';

    const config = { play_store_review_mode: isStoreMode };

    for (const [key, flagConfig] of Object.entries(FEATURE_FLAGS)) {
      const result = await query(
        `SELECT value FROM platform_settings WHERE key = $1`,
        [`feature_${key}`]
      );
      const individualValue = result.rows[0]?.value !== 'false';
      config[key] = flagConfig.always_on
        ? true
        : isStoreMode && flagConfig.store_review_off
          ? false
          : individualValue;
    }

    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'Erreur app config' });
  }
});

module.exports = { router, isFeatureEnabled, requireFeature, seedFeatureFlags, FEATURE_FLAGS };
