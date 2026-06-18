const { query } = require('./pool');

const PROVIDER_CATALOG = {
  campay: { requiredFields: ['api_key', 'api_secret', 'webhook_secret', 'mode'] },
  cinetpay: { requiredFields: ['site_id', 'api_key', 'secret_key', 'mode'] },
  whatsapp_business: { requiredFields: ['phone_number_id', 'access_token', 'business_account_id', 'webhook_verify_token'] },
  twilio: { requiredFields: ['account_sid', 'auth_token', 'from_number'] },
  firebase_push: { requiredFields: ['project_id', 'server_key', 'credentials_json'] },
  sendgrid: { requiredFields: ['api_key', 'from_email'] },
  google_maps: { requiredFields: ['api_key'] },
  storage_cdn: { requiredFields: ['bucket_name', 'access_key', 'secret_key', 'region'] },
  escrow_custom: { requiredFields: [] },
  deep_linking: { requiredFields: ['api_key', 'domain_uri_prefix'] },
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

async function getProviderConfig(providerName) {
  const catalogEntry = PROVIDER_CATALOG[providerName];
  if (!catalogEntry) return null;
  const res = await query(
    'SELECT * FROM settings_integrations WHERE provider_name = $1',
    [providerName]
  );
  const row = res.rows[0];
  if (!row || !row.is_active) return null;
  const config = row.config_json || {};
  const isComplete = catalogEntry.requiredFields.every(f => config[f] && config[f] !== '');
  if (!isComplete) return null;
  return config;
}

async function logSimulation(providerName, actionDescription) {
  console.log(`[SIMULATION] ${actionDescription} — ${providerName} non configuré.`);
  await query(
    `INSERT INTO simulation_logs (provider_name, description, created_at)
     VALUES ($1, $2, now())`,
    [providerName, actionDescription]
  ).catch(err => console.error('[SIMULATION] Log échoué:', err.message));
}

module.exports = { ensureCatalogSeeded, getProviderConfig, logSimulation };
