// ============================================================
// PLAY16 — Service OTP (codes de vérification)
// ============================================================
// Les OTP sont générés ici et envoyés via NotificationService.
// En mode simulation (WhatsApp non configuré), le code est
// loggué dans la console Railway — visible par le développeur.
// ============================================================
const { query } = require('./pool');
const { sendWhatsApp } = require('./NotificationService');

// Génère un code à 6 chiffres
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOTP(phoneNumber) {
  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Stocke le code en base (on supprime les anciens d'abord)
  await query(
    `DELETE FROM otp_codes WHERE phone_number = $1`,
    [phoneNumber]
  );
  await query(
    `INSERT INTO otp_codes (phone_number, code, expires_at)
     VALUES ($1, $2, $3)`,
    [phoneNumber, code, expiresAt]
  );

  const message = `Votre code de connexion Play16 : *${code}*\nValable 10 minutes. Ne le partagez avec personne.`;
  const result = await sendWhatsApp(phoneNumber, message);

  // En mode simulation, on affiche le code dans les logs Railway
  if (result.simulated) {
    console.log(`[OTP SIMULATION] Code pour ${phoneNumber} : ${code}`);
  }

  return { sent: true, simulated: result.simulated };
}

async function verifyOTP(phoneNumber, code) {
  const res = await query(
    `SELECT * FROM otp_codes
     WHERE phone_number = $1 AND code = $2 AND expires_at > now()`,
    [phoneNumber, code]
  );
  if (res.rows.length === 0) return false;

  // Supprime après usage (code à usage unique)
  await query(`DELETE FROM otp_codes WHERE phone_number = $1`, [phoneNumber]);
  return true;
}

module.exports = { sendOTP, verifyOTP };
