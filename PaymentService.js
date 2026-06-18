// ============================================================
// PLAY16 — PaymentService
// ============================================================
// Le reste de l'app appelle UNIQUEMENT PaymentService.charge()
// ou .checkStatus(). Le choix Campay/CinetPay est déterminé ici.
// Retry configurable (1 à 3x, défini par Super Admin) géré ici
// également, pour ne pas disperser cette logique dans les routes.
// ============================================================
const axios = require('axios');
const { getProviderConfig, logSimulation } = require('./integrationRegistry');
const { query } = require('../db/pool');

async function getRetryAttempts() {
  const res = await query(
    `SELECT value FROM platform_settings WHERE key = 'payment_retry_attempts'`
  );
  const val = res.rows[0]?.value;
  return val ? parseInt(val, 10) : 1; // défaut = 1 tentative
}

/**
 * Initie un paiement Mobile Money (Orange Money / MTN MoMo)
 * via le provider actif (Campay en priorité, CinetPay en repli).
 * Retourne toujours un objet structuré, jamais une exception brute.
 */
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
          {
            amount,
            currency: 'XAF',
            from: phoneNumber,
            description,
            external_reference: internalReference,
          },
          { headers: { Authorization: `Token ${campayConfig.api_key}` } }
        );
        return { success: true, provider: 'campay', providerReference: response.data.reference, attempt };
      } catch (err) {
        lastError = err;
        console.error(`[PaymentService] Tentative ${attempt}/${maxAttempts} Campay échouée:`, err.message);
        continue;
      }
    }

    const cinetpayConfig = await getProviderConfig('cinetpay');
    if (cinetpayConfig) {
      try {
        const response = await axios.post(
          'https://api-checkout.cinetpay.com/v2/payment',
          {
            apikey: cinetpayConfig.api_key,
            site_id: cinetpayConfig.site_id,
            amount,
            currency: 'XAF',
            customer_phone_number: phoneNumber,
            description,
            transaction_id: internalReference,
          }
        );
        return { success: true, provider: 'cinetpay', providerReference: response.data.transaction_id, attempt };
      } catch (err) {
        lastError = err;
        console.error(`[PaymentService] Tentative ${attempt}/${maxAttempts} CinetPay échouée:`, err.message);
        continue;
      }
    }

    if (!campayConfig && !cinetpayConfig) {
      // Aucun provider configuré du tout — pas la peine de boucler.
      break;
    }
  }

  if (!(await getProviderConfig('campay')) && !(await getProviderConfig('cinetpay'))) {
    await logSimulation('campay', `Paiement de ${amount} FCFA depuis ${phoneNumber} (réf: ${internalReference})`);
    return { success: false, simulated: true };
  }

  // Tous les providers configurés ont échoué après les tentatives autorisées.
  // Le sous-admin concerné doit le voir dans son journal de transactions.
  return {
    success: false,
    simulated: false,
    error: lastError?.message || 'Échec après tentatives multiples',
    requiresAdminReview: true,
  };
}

module.exports = { charge, getRetryAttempts };
