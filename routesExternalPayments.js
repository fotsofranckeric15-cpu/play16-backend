// ============================================================
// PLAY16 — Paiement Externe Sécurisé
// Token UUID, validation vidéo, attribution messages
// ============================================================
const express = require('express');
const router  = express.Router();
const { query }  = require('./pool');
const { authClient, authAdmin } = require('./authMiddleware');
const { charge } = require('./PaymentService');
const { sendWhatsApp } = require('./NotificationService');
const multer = require('multer');
const {
  generatePaymentToken, verifyPaymentToken, consumePaymentToken,
  validateVideo, checkIdempotency, saveIdempotencyResult,
  getSetting, createFraudAlert,
} = require('./securityMiddleware');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500*1024*1024 } });

// ── INITIER UN PAIEMENT EXTERNE ──────────────────────────────
router.post('/', authClient, async (req, res) => {
  try {
    const { seller_whatsapp_number, amount, description_text,
            expected_delivery_date, travel_agency_estimate, requested_proofs } = req.body;
    if (!seller_whatsapp_number || !amount) return res.status(400).json({ error: 'Numéro vendeur et montant requis' });

    const clientId = req.user.id;
    const idempKey = `ext-${clientId}-${amount}-${Date.now().toString().slice(0,-2)}`;
    const cached = await checkIdempotency(idempKey);
    if (cached.duplicate) return res.status(cached.status).json(cached.result);

    const buyerRes = await query(`SELECT phone_number FROM users WHERE id=$1`, [clientId]);
    const buyerPhone = buyerRes.rows[0].phone_number;

    const pay = await charge({ phoneNumber:buyerPhone, amount:parseInt(amount),
      description:`Séquestre paiement externe Play16`, internalReference:`ext-${Date.now()}` });
    if (!pay.success && !pay.simulated) return res.status(402).json({ error: 'Paiement échoué' });

    const deadline = expected_delivery_date
      ? new Date(new Date(expected_delivery_date).getTime() + 24*3600*1000)
      : new Date(Date.now() + 7*24*3600*1000);

    const epRes = await query(
      `INSERT INTO external_payments
       (buyer_id,seller_whatsapp_number,amount,description_text,
        expected_delivery_date,travel_agency_estimate,requested_proofs,
        status,buyer_expected_date,no_action_deadline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'escrowed',$5,$8) RETURNING *`,
      [clientId, seller_whatsapp_number, amount, description_text,
       expected_delivery_date||null, travel_agency_estimate, requested_proofs, deadline]
    );
    const payment = epRes.rows[0];

    // Générer token sécurisé (pas juste le numéro de téléphone)
    const expiryHours = parseInt(await getSetting('payment_token_expiry_hours', '48'));
    const token = await generatePaymentToken(payment.id);

    // Notifier le vendeur avec deep link
    await sendWhatsApp(seller_whatsapp_number,
      `🔐 Paiement sous séquestre initié vers vous sur Play16.\n` +
      `N° transaction : EXT-${payment.id.slice(0,8).toUpperCase()}\n` +
      `Montant : ${parseInt(amount).toLocaleString()} FCFA\n` +
      `Code de vérification : ${token}\n` +
      `Valable ${expiryHours}h.\n\n` +
      `Vérifiez sur Play16 : https://play16app.page.link/payment/${token}`
    ).catch(()=>{});

    const result = { success:true, payment:{ id:payment.id, amount:parseInt(amount), status:'escrowed' },
                     payment_token:token, token_expires_hours:expiryHours, buyer_phone:buyerPhone };
    await saveIdempotencyResult(idempKey, result, 200);
    res.json(result);
  } catch (err) {
    console.error('[ExtPay] initiation:', err.message);
    res.status(500).json({ error: 'Erreur initiation paiement externe' });
  }
});

// ── VÉRIFIER LE TOKEN (Vendeur) ──────────────────────────────
router.get('/verify-token/:token', async (req, res) => {
  try {
    const pt = await verifyPaymentToken(req.params.token);
    const epRes = await query(
      `SELECT ep.*,u.full_name as buyer_name FROM external_payments ep
       JOIN users u ON u.id=ep.buyer_id WHERE ep.id=$1`, [pt.external_payment_id]
    );
    if (!epRes.rows[0]) return res.status(404).json({ error: 'Transaction introuvable' });
    const ep = epRes.rows[0];
    res.json({ valid:true, payment:{ id:ep.id, amount:ep.amount, description:ep.description_text,
      buyer_name:ep.buyer_name, status:ep.status, expires_at:pt.expires_at } });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ── ACCEPTER (Vendeur) ───────────────────────────────────────
router.post('/:id/accept', async (req, res) => {
  try {
    const { token, seller_full_name, seller_birth_date } = req.body;
    if (!seller_full_name || !seller_birth_date) return res.status(400).json({ error: 'Nom complet et date de naissance requis' });
    if (!token) return res.status(400).json({ error: 'Token de vérification requis' });

    // Vérifier et consommer le token
    const pt = await verifyPaymentToken(token);
    if (pt.external_payment_id !== req.params.id) return res.status(403).json({ error: 'Token invalide pour cette transaction' });
    await consumePaymentToken(token);

    const epRes = await query(`SELECT * FROM external_payments WHERE id=$1 AND status='escrowed'`, [req.params.id]);
    if (!epRes.rows[0]) return res.status(404).json({ error: 'Transaction introuvable ou déjà traitée' });

    await query(`UPDATE external_payments SET status='accepted',seller_accepted_at=now() WHERE id=$1`, [req.params.id]);
    res.json({ success:true, next_step:'execute_order', message:'Montant confirmé. Préparez la commande.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── REFUSER (Vendeur) ────────────────────────────────────────
router.post('/:id/reject', async (req, res) => {
  try {
    const epRes = await query(
      `SELECT ep.*,u.whatsapp_number as bwa,u.phone_number as bp FROM external_payments ep
       JOIN users u ON u.id=ep.buyer_id WHERE ep.id=$1 AND ep.status='escrowed'`, [req.params.id]
    );
    if (!epRes.rows[0]) return res.status(404).json({ error: 'Transaction introuvable' });
    const ep = epRes.rows[0];
    await query(`UPDATE external_payments SET status='refunded' WHERE id=$1`, [req.params.id]);
    await sendWhatsApp(ep.bwa||ep.bp,
      `[Message généré sur la base des informations fournies par le vendeur]\n❌ Le vendeur a refusé le montant. Vos ${ep.amount.toLocaleString()} FCFA seront remboursés sous 24h.`
    ).catch(()=>{});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ error: 'Erreur refus' }); }
});

// ── NOTE VOCALE (Acheteur) ───────────────────────────────────
router.post('/:id/voice-note', authClient, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Fichier audio requis' });
    const voiceUrl = `voice-${req.params.id}-${Date.now()}.ogg`;
    await query(`UPDATE external_payments SET description_voice_url=$1 WHERE id=$2 AND buyer_id=$3`,
      [voiceUrl, req.params.id, req.user.id]);
    res.json({ success:true, voice_url:voiceUrl });
  } catch (err) { res.status(500).json({ error: 'Erreur note vocale' }); }
});

// ── VIDÉO EMBALLAGE (Vendeur) ────────────────────────────────
router.post('/:id/packing-video', upload.single('video'), async (req, res) => {
  try {
    const { was_ignored } = req.body;
    const epRes = await query(
      `SELECT ep.*,u.whatsapp_number as bwa,u.phone_number as bp FROM external_payments ep
       JOIN users u ON u.id=ep.buyer_id WHERE ep.id=$1`, [req.params.id]
    );
    if (!epRes.rows[0]) return res.status(404).json({ error: 'Transaction introuvable' });
    const ep = epRes.rows[0];

    if (was_ignored==='true'||was_ignored===true) {
      await query(`INSERT INTO external_payment_media (external_payment_id,media_type,was_ignored) VALUES ($1,'packing_video',TRUE)`, [req.params.id]);
      await sendWhatsApp(ep.bwa||ep.bp,
        `[Message généré sur la base des informations fournies par le vendeur]\n📦 Votre vendeur prépare votre commande.\n⚠️ La vidéo de preuve d'emballage a été ignorée par ce dernier.`
      ).catch(()=>{});
    } else if (req.file) {
      // Validation MIME et taille
      let videoMeta;
      try { videoMeta = await validateVideo(req.file); }
      catch(vErr) { return res.status(400).json({ error: vErr.message }); }

      const videoUrl = `packing-${req.params.id}-${Date.now()}.mp4`;
      await query(
        `INSERT INTO external_payment_media (external_payment_id,media_type,url,was_ignored,recorded_without_interruption)
         VALUES ($1,'packing_video',$2,FALSE,TRUE)`, [req.params.id, videoUrl]
      );
      // Stocker intégrité vidéo
      const mediaRes = await query(`SELECT id FROM external_payment_media WHERE external_payment_id=$1 ORDER BY created_at DESC LIMIT 1`, [req.params.id]);
      await query(`INSERT INTO video_integrity (media_id,sha256_hash,mime_type,size_bytes) VALUES ($1,$2,$3,$4)`,
        [mediaRes.rows[0]?.id, videoMeta.hash, videoMeta.mime, videoMeta.size]);

      await sendWhatsApp(ep.bwa||ep.bp,
        `[Message généré sur la base des informations fournies par le vendeur]\n📦 Votre vendeur a préparé votre commande et attend votre confirmation pour expédier.`
      ).catch(()=>{});
    }

    await query(`UPDATE external_payments SET status='preparing' WHERE id=$1`, [req.params.id]);
    res.json({ success:true });
  } catch (err) {
    console.error('[ExtPay] packing-video:', err.message);
    res.status(500).json({ error: 'Erreur vidéo emballage' });
  }
});

// ── CONFIRMATION EXPÉDITION (Acheteur) ───────────────────────
router.post('/:id/confirm-shipment', authClient, async (req, res) => {
  try {
    await query(`UPDATE external_payments SET status='shipping_confirmed' WHERE id=$1 AND buyer_id=$2`,
      [req.params.id, req.user.id]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ error: 'Erreur confirmation expédition' }); }
});

// ── PREUVES D'EXPÉDITION (Vendeur) ──────────────────────────
router.post('/:id/shipping-proof', upload.single('proof'), async (req, res) => {
  try {
    const { seller_expected_date } = req.body;
    const proofUrl = req.file ? `shipping-proof-${req.params.id}-${Date.now()}` : null;
    await query(`INSERT INTO external_payment_media (external_payment_id,media_type,url) VALUES ($1,'shipping_proof',$2)`,
      [req.params.id, proofUrl]);
    if (seller_expected_date) {
      await query(`UPDATE external_payments SET seller_expected_date=$1 WHERE id=$2`, [seller_expected_date, req.params.id]);
    }
    await query(`UPDATE external_payments SET status='shipped' WHERE id=$1`, [req.params.id]);

    const epRes = await query(
      `SELECT ep.*,u.whatsapp_number as bwa,u.phone_number as bp FROM external_payments ep
       JOIN users u ON u.id=ep.buyer_id WHERE ep.id=$1`, [req.params.id]
    );
    const ep = epRes.rows[0];
    await sendWhatsApp(ep?.bwa||ep?.bp,
      `[Message généré sur la base des informations fournies par le vendeur — Play16 ne garantit pas ces informations]\n🚚 Votre colis a été expédié !\nDate estimée : ${seller_expected_date||'Non précisée'}\nConfirmez la réception dans Play16 dès l'arrivée.`
    ).catch(()=>{});
    res.json({ success:true });
  } catch (err) { res.status(500).json({ error: 'Erreur preuves expédition' }); }
});

// ── RÉCEPTION + VIDÉO (Acheteur) ─────────────────────────────
router.post('/:id/reception', authClient, upload.single('video'), async (req, res) => {
  try {
    const { accepted, was_video_ignored } = req.body;
    const epRes = await query(
      `SELECT ep.*,u.phone_number as sp FROM external_payments ep
       LEFT JOIN users seller ON seller.phone_number=ep.seller_whatsapp_number
       WHERE ep.id=$1 AND ep.buyer_id=$2`, [req.params.id, req.user.id]
    );
    if (!epRes.rows[0]) return res.status(404).json({ error: 'Transaction introuvable' });

    if (req.file) {
      let videoMeta;
      try { videoMeta = await validateVideo(req.file); }
      catch(vErr) { return res.status(400).json({ error: vErr.message }); }
      const videoUrl = `reception-${req.params.id}-${Date.now()}.mp4`;
      await query(`INSERT INTO external_payment_media (external_payment_id,media_type,url,was_ignored) VALUES ($1,'reception_video',$2,FALSE)`,
        [req.params.id, videoUrl]);
    } else if (was_video_ignored==='true') {
      await query(`INSERT INTO external_payment_media (external_payment_id,media_type,was_ignored) VALUES ($1,'reception_video',TRUE)`,
        [req.params.id]);
    }

    if (accepted==='true'||accepted===true) {
      await query(`UPDATE external_payments SET status='completed' WHERE id=$1`, [req.params.id]);
      res.json({ success:true, status:'completed', message:'Colis accepté. Fonds libérés au vendeur.' });
    } else {
      await query(`UPDATE external_payments SET status='rejected_returning' WHERE id=$1`, [req.params.id]);
      res.json({
        success:true, status:'rejected_returning',
        return_instructions:{
          at_your_expense:true, deadline_hours:24,
          message:'Retournez le colis au vendeur dans les 24h, à vos frais. Tout dommage pendant le retour est à votre charge. Filmez l\'emballage du retour comme preuve.',
        },
      });
    }
  } catch (err) {
    console.error('[ExtPay] réception:', err.message);
    res.status(500).json({ error: 'Erreur réception colis' });
  }
});

// ── AUTO-VALIDATION (cron) ───────────────────────────────────
router.post('/auto-complete', authAdmin, async (req, res) => {
  try {
    const expired = await query(
      `SELECT ep.*,u.whatsapp_number as bwa,u.phone_number as bp FROM external_payments ep
       JOIN users u ON u.id=ep.buyer_id
       WHERE ep.status='shipped' AND ep.no_action_deadline < now()`
    );
    let done=0;
    for (const ep of expired.rows) {
      await query(`UPDATE external_payments SET status='completed' WHERE id=$1`, [ep.id]);
      await sendWhatsApp(ep.bwa||ep.bp,
        `✅ Transaction EXT-${ep.id.slice(0,8).toUpperCase()} auto-validée suite à expiration du délai. Fonds libérés.`
      ).catch(()=>{});
      done++;
    }
    res.json({ success:true, auto_completed:done });
  } catch (err) { res.status(500).json({ error: 'Erreur auto-complétion' }); }
});

module.exports = router;
