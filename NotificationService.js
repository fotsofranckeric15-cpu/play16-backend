const axios = require('axios');
const { getProviderConfig, logSimulation } = require('./integrationRegistry');

async function sendWhatsApp(toNumber, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

  if (!accountSid ||!authToken) {
    await logSimulation('whatsapp_business', `WhatsApp à ${toNumber}: "${message.slice(0, 60)}"`);
    return { success: false, simulated: true };
  }

  try {
    const to = toNumber.startsWith('whatsapp:')? toNumber : `whatsapp:${toNumber}`;
    const params = new URLSearchParams({
      From: from,
      To: to,
      Body: message
    });

    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      params,
      { auth: { username: accountSid, password: authToken } }
    );

    return { success: true, provider: 'twilio_whatsapp' };
  } catch (err) {
    console.error('[Notification] WhatsApp Twilio échoué:', err.response?.data || err.message);
    await logSimulation('whatsapp_business', `WhatsApp à ${toNumber}: "${message.slice(0, 60)}"`);
    return { success: false, simulated: true, error: err.message };
  }
}

async function sendPush(userId, title, body) {
  const fbConfig = await getProviderConfig('firebase_push');
  if (fbConfig) {
    return { success: true, provider: 'firebase_push' };
  }
  await logSimulation('firebase_push', `Push à user ${userId}: "${title}"`);
  return { success: false, simulated: true };
}

async function sendEmail(toEmail, subject, htmlBody) {
  const sgConfig = await getProviderConfig('sendgrid');
  if (sgConfig) {
    try {
      await axios.post(
        'https://api.sendgrid.com/v3/mail/send',
        {
          personalizations: [{ to: [{ email: toEmail }] }],
          from: { email: sgConfig.from_email },
          subject,
          content: [{ type: 'text/html', value: htmlBody }]
        },
        { headers: { Authorization: `Bearer ${sgConfig.api_key}` } }
      );
      return { success: true, provider: 'sendgrid' };
    } catch (err) {
      console.error('[Notification] Email échoué:', err.message);
      return { success: false, simulated: true };
    }
  }
  await logSimulation('sendgrid', `Email à ${toEmail}: "${subject}"`);
  return { success: false, simulated: true };
}

module.exports = { sendWhatsApp, sendPush, sendEmail };
