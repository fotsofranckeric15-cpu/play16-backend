const axios = require('axios');
const { getProviderConfig, logSimulation } = require('./integrationRegistry');
const { query } = require('./pool');

async function getRetryAttempts() {
  const res = await query(`SELECT value FROM platform_settings WHERE key = 'payment_retry_attempts'`);
  return res.rows[0]?.value ? parseInt(res.rows[0].value, 10) : 1;
}

async function charge({ phoneNumber, amount, description, internalReference }) {
  const maxAttempts = await getRetryAttempts();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const campayConfig = await getProviderConfig('campay');
    if (campayConfig) {
      try {
        const response = await axios.post(
          campayConfig.mode === 'live'
            ? 'https://www.campay.net/api/collect/'
            : 'https://demo.campay.net/api/collect/',
          { amount, currency: 'XAF', from: phoneNumber, description, external_reference: internalReference },
          { headers: { Authorization: `Token ${campayConfig.api_key}` } }
        );
        return { success: true, provider: 'campay', providerReference: response.data.reference, attempt };
      } catch (err) {
        lastError = err;
        console.error(`[Payment] Tentative ${attempt} Campay échouée:`, err.message);
      }
    }

    const cinetpayConfig = await getProviderConfig('cinetpay');
    if (cinetpayConfig) {
      try {
        const response = await axios.post(
          'https://api-checkout.cinetpay.com/v2/payment',
          { apikey: cinetpayConfig.api_key, site_id: cinetpayConfig.site_id, amount, currency: 'XAF', customer_phone_number: phoneNumber, description, transaction_id: internalReference }
        );
        return { success: true, provider: 'cinetpay', providerReference: response.data.transaction_id, attempt };
      } catch (err) {
        lastError = err;
        console.error(`[Payment] Tentative ${attempt} CinetPay échouée:`, err.message);
      }
    }

    if (!campayConfig && !cinetpayConfig) break;
  }

  await logSimulation('campay', `Paiement ${amount} FCFA depuis ${phoneNumber}`);
  return { success: false, simulated: true, error: lastError?.message };
}

module.exports = { charge, getRetryAttempts };
