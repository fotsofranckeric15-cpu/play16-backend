const axios = require('axios');
const { getProviderConfig, logSimulation } = require('./integrationRegistry');

async function sendWhatsApp(toNumber, message) {
  const waConfig = await getProviderConfig('whatsapp_business');
  if (waConfig) {
    try {
      await axios.post(
        `https://graph.facebook.com/v19.0/${waConfig.phone_number_id}/messages`,
        { messaging_product: 'whatsapp', to: toNumber, type: 'text', text: { body: message } },
        { headers: { Authorization: `Bearer ${waConfig.access_token}` } }
      );
      return { success: true, provider: 'whatsapp_business' };
    } catch (err) {
      console.error('[Notification] WhatsApp échoué:', err.message);
    }
  }
  await logSimulation('whatsapp_business', `WhatsApp à ${toNumber}: "${message.slice(0, 60)}"`);
  return { success: false, simulated: true };
}

async function sendPush(userId, title, body) {
  const fbConfig = await getProviderConfig('firebase_push');
  if (!fbConfig) {
    await logSimulation('firebase_push', `Push à user ${userId}: "${title}"`);
    return { success: false, simulated: true };
  }
  return { success: true, provider: 'firebase_push' };
}

async function sendEmail(toEmail, subject, htmlBody) {
  const sgConfig = await getProviderConfig('sendgrid');
  if (!sgConfig) {
    await logSimulation('sendgrid', `Email à ${toEmail}: "${subject}"`);
    return { success: false, simulated: true };
  }
  try {
    await axios.post(
      'https://api.sendgrid.com/v3/mail/send',
      {
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: sgConfig.from_email },
        subject,
        content: [{ type: 'text/html', value: htmlBody }],
      },
      { headers: { Authorization: `Bearer ${sgConfig.api_key}` } }
    );
    return { success: true, provider: 'sendgrid' };
  } catch (err) {
    console.error('[Notification] Email échoué:', err.message);
    return { success: false, simulated: true };
  }
}

module.exports = { sendWhatsApp, sendPush, sendEmail };
