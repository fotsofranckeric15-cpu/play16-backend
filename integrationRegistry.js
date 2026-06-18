// ============================================================
// PLAY16 — Registre des intégrations ("tiroir SIM")
// ============================================================
// Toute la logique "PROVIDER_NOT_CONFIGURED" passe par ici.
// Aucun service métier ne lit jamais settings_integrations
// directement — tout passe par getProviderConfig().
// ============================================================
const { query } = require('../db/pool');

// Catalogue figé des providers attendus par le projet.
// Présent dès le déploiement initial, même si jamais utilisé.
const PROVIDER_CATALOG = {
  campay: { category: 'payment', requiredFields: ['api_key', 'api_secret', 'webhook_secret', 'mode'] },
  cinetpay: { category: 'payment', requiredFields: ['site_id', 'api_key', 'secret_key', 'mode'] },
  whatsapp_business: { category: 'notification', requiredFields: ['phone_number_id', 'access_token', 'business_account_id', 'webhook_verify_token'] },
  twilio: { category: 'notification', requiredFields: ['account_sid', 'auth_token', 'from_number'] },
  firebase_push: { category: 'notification', requiredFields: ['project_id', 'server_key', 'credentials_json'] },
  sendgrid: { category: 'notification', requiredFields: ['api_key', 'from_email'] },
  google_maps: { category: 'maps', requiredFields: ['api_key'] },
  storage_cdn: { category: 'storage', requiredFields: ['bucket_name', 'access_key', 'secret_key', 'region'] },
  escrow_custom: { category: 'escrow', requiredFields: [] }, // générique clé/valeur
  deep_linking: { category: 'linking', requiredFields: ['api_key', 'domain_uri_prefix'] },
};

async function ensureCatalogSeeded() {
  for (const providerName of Object.keys(PROVIDER_CATALOG)) {
    await query(
      `INSERT INTO settings_integrations (provider_name, is_active, config_json)
       VALUES ($1, FALSE, '{}'::jsonb)
       ON CONFLICT (provider_name) DO NOTHING`,
      [providerName]
    );
  }
}

/**
 * Retourne la config d'un provider si actif ET complet, sinon null.
 * Ne lève JAMAIS d'exception — c'est l'appelant (un service métier)
 * qui décide quoi faire en mode simulation.
 */
async function getProviderConfig(providerName) {
  const catalogEntry = PROVIDER_CATALOG[providerName];
  if (!catalogEntry) {
    console.error(`[Integrations] Provider inconnu demandé: ${providerName}`);
    return null;
  }

  const res = await query(
    'SELECT * FROM settings_integrations WHERE provider_name = $1',
    [providerName]
  );
  const row = res.rows[0];
  if (!row || !row.is_active) return null;

  const config = row.config_json || {};
  const isComplete = catalogEntry.requiredFields.every(
    (field) => config[field] !== undefined && config[field] !== ''
  );
  if (!isComplete) return null;

  return config;
}

async function logSimulation(providerName, actionDescription) {
  console.log(`[SIMULATION] ${actionDescription} — provider "${providerName}" non configuré ou inactif. PROVIDER_NOT_CONFIGURED.`);
  // Optionnel : insertion dans une table simulation_logs pour
  // affichage dans Super Admin > Intégrations > Journal.
  await query(
    `INSERT INTO simulation_logs (provider_name, description, created_at)
     VALUES ($1, $2, now())`,
    [providerName, actionDescription]
  ).catch((err) => console.error('[SIMULATION] Échec log (non bloquant):', err.message));
}

module.exports = { PROVIDER_CATALOG, ensureCatalogSeeded, getProviderConfig, logSimulation };
