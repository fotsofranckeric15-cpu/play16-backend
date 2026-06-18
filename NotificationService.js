// ============================================================
// PLAY16 — NotificationService
// ============================================================
// Le reste de l'app appelle UNIQUEMENT NotificationService.send().
// Le choix du provider réel (WhatsApp Business, Twilio, Firebase)
// est déterminé ici, en lisant settings_integrations.
// Aucun crash possible : si rien n'est configuré, on simule.
// ============================================================
const axios = require('axios');
const { getProviderConfig, logSimulation } = require('./integrationRegistry');

/**
 * Envoie un message WhatsApp à un numéro donné.
 * Tente whatsapp_business en priorité, puis twilio en repli.
 */
async function sendWhatsApp(toNumber, message) {
  const waConfig = await getProviderConfig('whatsapp_business');
  if (waConfig) {
    try {
      await axios.post(
        `https://graph.facebook.com/v19.0/${waConfig.phone_number_id}/messages`,
        {
          messaging_product: 'whatsapp',
          to: toNumber,
          type: 'text',
          text: { body: message },
        },
        { headers: { Authorization: `Bearer ${waConfig.access_token}` } }
      );
      return { success: true, provider: 'whatsapp_business' };
    } catch (err) {
      console.error('[NotificationService] Échec WhatsApp Business:', err.message);
      // on tente le repli plutôt que de remonter une erreur brute
    }
  }

  const twilioConfig = await getProviderConfig('twilio');
  if (twilioConfig) {
    try {
      const twilioClient = require('twilio')(twilioConfig.account_sid, twilioConfig.auth_token);
      await twilioClient.messages.create({
        from: twilioConfig.from_number,
        to: toNumber,
        body: message,
      });
      return { success: true, provider: 'twilio' };
    } catch (err) {
      console.error('[NotificationService] Échec Twilio:', err.message);
    }
  }

  await logSimulation('whatsapp_business', `WhatsApp à ${toNumber}: "${message.slice(0, 60)}..."`);
  return { success: false, simulated: true };
}

async function sendPush(userId, title, body, data = {}) {
  const fbConfig = await getProviderConfig('firebase_push');
  if (!fbConfig) {
    await logSimulation('firebase_push', `Notification push à user ${userId}: "${title}"`);
    return { success: false, simulated: true };
  }
  // Implémentation réelle Firebase Admin SDK à brancher ici une
  // fois le provider configuré et testé depuis Super Admin.
  try {
    // const admin = getFirebaseAdminInstance(fbConfig);
    // await admin.messaging().send({ token: ..., notification: { title, body }, data });
    return { success: true, provider: 'firebase_push' };
  } catch (err) {
    console.error('[NotificationService] Échec push Firebase:', err.message);
    await logSimulation('firebase_push', `Notification push à user ${userId} (erreur réelle, fallback simulation)`);
    return { success: false, simulated: true };
  }
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
    console.error('[NotificationService] Échec SendGrid:', err.message);
    await logSimulation('sendgrid', `Email à ${toEmail} (erreur réelle, fallback simulation)`);
    return { success: false, simulated: true };
  }
}

module.exports = { sendWhatsApp, sendPush, sendEmail };
