// ============================================================
// PLAY16 — Routes Paiement Externe (hors plateforme)
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('./pool');
const { authClient, authAdmin } = require('./authMiddleware');
const { charge } = require('./PaymentService');
const { sendWhatsApp } = require('./NotificationService');
const multer = require('multer');

// Stockage temporaire en mémoire (les fichiers vont au CDN ensuite)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// ── INITIER UN PAIEMENT EXTERNE (Acheteur) ──────────────────
// POST /api/external-payments
// Body: { seller_whatsapp_number, amount, description_text,
//         expected_delivery_date, travel_agency_estimate, requested_proofs }
router.post('/', authClient, async (req, res) => {
  try {
    const {
      seller_whatsapp_number, amount, description_text,
      expected_delivery_date, travel_agency_estimate, requested_proofs
    } = req.body;

    if (!seller_whatsapp_number || !amount) {
      return res.status(400).json({ error: 'Numéro vendeur et montant requis' });
    }

    const buyerId = req.user.id;
    const buyerRes = await query(`SELECT phone_number FROM users WHERE id = $1`, [buyerId]);
    const buyerPhone = buyerRes.rows[0].phone_number;

    // Séquestrer les fonds
    const paymentResult = await charge({
      phoneNumber: buyerPhone,
      amount,
      description: `Séquestre paiement externe Play16 — ${description_text?.slice(0, 60) || 'Sans description'}`,
      internalReference: `ext-${Date.now()}`,
    });

    if (!paymentResult.success && !paymentResult.simulated) {
      return res.status(402).json({ error: 'Paiement échoué. Vérifiez votre solde Mobile Money.' });
    }

    // Calculer la deadline (24h après les deux dates)
    const noActionDeadline = expected_delivery_date
      ? new Date(new Date(expected_delivery_date).getTime() + 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const paymentRes = await query(
      `INSERT INTO external_payments
         (buyer_id, seller_whatsapp_number, amount, description_text,
          expected_delivery_date, travel_agency_estimate, requested_proofs,
          status, buyer_expected_date, no_action_deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'escrowed', $5, $8)
       RETURNING *`,
      [buyerId, seller_whatsapp_number, amount, description_text,
       expected_delivery_date || null, travel_agency_estimate, requested_proofs, noActionDeadline]
    );

    const payment = paymentRes.rows[0];

    // Notifier le vendeur via WhatsApp avec lien deep link
    await sendWhatsApp(
      seller_whatsapp_number,
      `🔐 Paiement sous séquestre initié vers vous sur Play16.\n` +
      `N° de transaction : EXT-${payment.id.slice(0,8).toUpperCase()}\n` +
      `Montant : ${amount} FCFA\n\n` +
      `Pour accepter et voir les détails :\nhttps://play16app.page.link/payment/${payment.id}\n\n` +
      `(Si vous n'avez pas Play16, installez-le depuis ce lien pour accéder au paiement)`
    );

    res.json({
      success: true,
      payment: {
        id: payment.id,
        amount,
        status: 'escrowed',
        seller_whatsapp: seller_whatsapp_number,
      },
      message: 'Paiement séquestré. Le vendeur a été notifié par WhatsApp.',
      buyer_payment_code: buyerPhone,
    });
  } catch (err) {
    console.error('[ExtPayment] Erreur initiation:', err.message);
    res.status(500).json({ error: 'Erreur initiation paiement externe' });
  }
});

// ── NOTE VOCALE (Acheteur) ──────────────────────────────────
// POST /api/external-payments/:id/voice-note
router.post('/:id/voice-note', authClient, upload.single('audio'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'Fichier audio requis' });

    // TODO: Upload vers CDN (StorageService) quand configuré
    // Pour l'instant, stocké en base en mode simulation
    const voiceUrl = `[SIMULATION] audio-${id}-${Date.now()}.ogg`;

    await query(
      `UPDATE external_payments SET description_voice_url = $1 WHERE id = $2 AND buyer_id = $3`,
      [voiceUrl, id, req.user.id]
    );

    res.json({ success: true, voice_url: voiceUrl });
  } catch (err) {
    res.status(500).json({ error: 'Erreur upload note vocale' });
  }
});

// ── VÉRIFIER ET ACCEPTER (Vendeur) ──────────────────────────
// POST /api/external-payments/:id/accept
router.post('/:id/accept', async (req, res) => {
  try {
    const { id } = req.params;
    const { seller_full_name, seller_birth_date } = req.body;

    if (!seller_full_name || !seller_birth_date) {
      return res.status(400).json({ error: 'Nom complet et date de naissance requis pour sécurité' });
    }

    const paymentRes = await query(
      `SELECT * FROM external_payments WHERE id = $1 AND status = 'escrowed'`,
      [id]
    );

    if (paymentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction introuvable ou déjà traitée' });
    }

    const payment = paymentRes.rows[0];

    await query(
      `UPDATE external_payments SET status = 'accepted', seller_accepted_at = now() WHERE id = $1`,
      [id]
    );

    res.json({
      success: true,
      payment: {
        id: payment.id,
        amount: payment.amount,
        description: payment.description_text,
        status: 'accepted',
      },
      next_step: 'execute_order',
      message: 'Montant confirmé. Cliquez sur "Exécuter la commande" pour préparer le colis.',
    });
  } catch (err) {
    console.error('[ExtPayment] Erreur acceptation:', err.message);
    res.status(500).json({ error: 'Erreur acceptation' });
  }
});

// ── REFUSER LE MONTANT (Vendeur) ─────────────────────────────
// POST /api/external-payments/:id/reject
router.post('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;

    const paymentRes = await query(
      `SELECT ep.*, u.whatsapp_number as buyer_whatsapp, u.phone_number as buyer_phone
       FROM external_payments ep
       JOIN users u ON u.id = ep.buyer_id
       WHERE ep.id = $1 AND ep.status = 'escrowed'`,
      [id]
    );

    if (paymentRes.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction introuvable' });
    }

    const payment = paymentRes.rows[0];

    await query(`UPDATE external_payments SET status = 'refunded' WHERE id = $1`, [id]);

    // Notifier l'acheteur
    await sendWhatsApp(
      payment.buyer_whatsapp || payment.buyer_phone,
      `[Message généré sur la base des informations fournies par le vendeur]\n❌ Le vendeur a refusé le montant proposé.\nVos ${payment.amount} FCFA seront remboursés sous 24h sur votre Mobile Money.`
    );

    res.json({ success: true, message: 'Transaction refusée. Remboursement initié.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur refus transaction' });
  }
});

// ── VIDÉO D'EMBALLAGE (Vendeur — optionnelle) ────────────────
// POST /api/external-payments/:id/packing-video
// RÈGLES : pas de pause, pas de téléchargement externe, stockage auto si coupure
router.post('/:id/packing-video', upload.single('video'), async (req, res) => {
  try {
    const { id } = req.params;
    const { was_ignored } = req.body;

    const paymentRes = await query(
      `SELECT ep.*, u.whatsapp_number as buyer_whatsapp, u.phone_number as buyer_phone
       FROM external_payments ep JOIN users u ON u.id = ep.buyer_id WHERE ep.id = $1`,
      [id]
    );

    if (paymentRes.rows.length === 0) return res.status(404).json({ error: 'Transaction introuvable' });
    const payment = paymentRes.rows[0];

    if (was_ignored === 'true' || was_ignored === true) {
      // Vidéo ignorée — notifier l'acheteur
      await query(
        `INSERT INTO external_payment_media (external_payment_id, media_type, was_ignored)
         VALUES ($1, 'packing_video', TRUE)`,
        [id]
      );

      await sendWhatsApp(
        payment.buyer_whatsapp || payment.buyer_phone,
        `[Message généré sur la base des informations fournies par le vendeur]\n📦 Votre vendeur est en train de préparer votre commande.\n⚠️ La vidéo de preuve d\'emballage a été ignorée par ce dernier.`
      );
    } else if (req.file) {
      // Vidéo enregistrée (stockage auto même si coupure)
      const videoUrl = `[SIMULATION] packing-video-${id}-${Date.now()}.mp4`;

      await query(
        `INSERT INTO external_payment_media (external_payment_id, media_type, url, was_ignored, recorded_without_interruption)
         VALUES ($1, 'packing_video', $2, FALSE, TRUE)`,
        [id, videoUrl]
      );

      await sendWhatsApp(
        payment.buyer_whatsapp || payment.buyer_phone,
        `[Message généré sur la base des informations fournies par le vendeur]\n📦 Votre vendeur a préparé votre commande et attend votre confirmation pour expédier.`
      );
    }

    await query(`UPDATE external_payments SET status = 'preparing' WHERE id = $1`, [id]);

    res.json({ success: true, next_step: 'await_buyer_confirmation' });
  } catch (err) {
    console.error('[ExtPayment] Erreur vidéo emballage:', err.message);
    res.status(500).json({ error: 'Erreur vidéo emballage' });
  }
});

// ── CONFIRMATION EXPÉDITION PAR L'ACHETEUR ──────────────────
// POST /api/external-payments/:id/confirm-shipment
router.post('/:id/confirm-shipment', authClient, async (req, res) => {
  try {
    const { id } = req.params;

    await query(`UPDATE external_payments SET status = 'shipping_confirmed' WHERE id = $1 AND buyer_id = $2`, [id, req.user.id]);

    res.json({ success: true, message: 'Vendeur notifié. Il peut maintenant expédier.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur confirmation expédition' });
  }
});

// ── PREUVES D'EXPÉDITION (Vendeur) ──────────────────────────
// POST /api/external-payments/:id/shipping-proof
router.post('/:id/shipping-proof', upload.single('proof'), async (req, res) => {
  try {
    const { id } = req.params;
    const { seller_expected_date } = req.body;

    const proofUrl = req.file ? `[SIMULATION] shipping-proof-${id}-${Date.now()}` : null;

    await query(
      `INSERT INTO external_payment_media (external_payment_id, media_type, url)
       VALUES ($1, 'shipping_proof', $2)`,
      [id, proofUrl]
    );

    if (seller_expected_date) {
      await query(`UPDATE external_payments SET seller_expected_date = $1 WHERE id = $2`, [seller_expected_date, id]);
    }

    await query(`UPDATE external_payments SET status = 'shipped' WHERE id = $1`, [id]);

    // Notifier l'acheteur
    const paymentRes = await query(
      `SELECT ep.*, u.whatsapp_number as buyer_whatsapp, u.phone_number as buyer_phone
       FROM external_payments ep JOIN users u ON u.id = ep.buyer_id WHERE ep.id = $1`, [id]
    );
    const payment = paymentRes.rows[0];

    await sendWhatsApp(
      payment.buyer_whatsapp || payment.buyer_phone,
      `[Message généré sur la base des informations fournies par le vendeur — Play16 ne garantit pas ces informations]\n🚚 Votre colis a été expédié !\nDate de livraison estimée : ${seller_expected_date || 'Non précisée'}\nDès réception, ouvrez Play16 et confirmez pour libérer le paiement.`
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur preuves expédition' });
  }
});

// ── RÉCEPTIONNER LE COLIS + VIDÉO (Acheteur) ────────────────
// POST /api/external-payments/:id/reception
router.post('/:id/reception', authClient, upload.single('video'), async (req, res) => {
  try {
    const { id } = req.params;
    const { accepted, was_video_ignored } = req.body;
    const clientId = req.user.id;

    const paymentRes = await query(
      `SELECT ep.*, u.whatsapp_number as seller_whatsapp
       FROM external_payments ep
       LEFT JOIN users seller ON seller.phone_number = ep.seller_whatsapp_number
       JOIN users buyer ON buyer.id = ep.buyer_id
       WHERE ep.id = $1 AND ep.buyer_id = $2`,
      [id, clientId]
    );

    if (paymentRes.rows.length === 0) return res.status(404).json({ error: 'Transaction introuvable' });
    const payment = paymentRes.rows[0];

    // Enregistrer la vidéo de réception si fournie
    if (req.file) {
      const videoUrl = `[SIMULATION] reception-video-${id}-${Date.now()}.mp4`;
      await query(
        `INSERT INTO external_payment_media (external_payment_id, media_type, url, was_ignored)
         VALUES ($1, 'reception_video', $2, FALSE)`,
        [id, videoUrl]
      );
    } else if (was_video_ignored === 'true') {
      await query(
        `INSERT INTO external_payment_media (external_payment_id, media_type, was_ignored)
         VALUES ($1, 'reception_video', TRUE)`,
        [id]
      );
    }

    if (accepted === 'true' || accepted === true) {
      // COLIS ACCEPTÉ → transaction terminée, fonds libérés
      await query(`UPDATE external_payments SET status = 'completed' WHERE id = $1`, [id]);

      res.json({
        success: true,
        status: 'completed',
        message: 'Colis accepté. Les fonds ont été libérés au vendeur.',
      });
    } else {
      // COLIS REFUSÉ → retour aux frais de l'acheteur
      await query(`UPDATE external_payments SET status = 'rejected_returning' WHERE id = $1`, [id]);

      res.json({
        success: true,
        status: 'rejected_returning',
        return_instructions: {
          at_your_expense: true,
          deadline_hours: 24,
          message: 'Vous devez retourner le colis au vendeur dans les 24h, à vos frais. Tout dommage pendant le retour est également à votre charge. Filmez l\'emballage du retour comme preuve.',
        },
      });
    }
  } catch (err) {
    console.error('[ExtPayment] Erreur réception:', err.message);
    res.status(500).json({ error: 'Erreur réception colis' });
  }
});

// ── AUTO-VALIDATION APRÈS DÉLAI (appelé par cron) ───────────
// POST /api/external-payments/auto-complete
router.post('/auto-complete', authAdmin, async (req, res) => {
  try {
    const expired = await query(
      `SELECT ep.*, u.whatsapp_number, u.phone_number
       FROM external_payments ep
       JOIN users u ON u.id = ep.buyer_id
       WHERE ep.status = 'shipped'
         AND ep.no_action_deadline < now()`,
      []
    );

    let completed = 0;
    for (const payment of expired.rows) {
      await query(`UPDATE external_payments SET status = 'completed' WHERE id = $1`, [payment.id]);
      await sendWhatsApp(
        payment.whatsapp_number || payment.phone_number,
        `✅ Votre transaction EXT-${payment.id.slice(0,8).toUpperCase()} a été automatiquement validée suite à l\'expiration du délai de réponse. Les fonds ont été libérés au vendeur.`
      );
      completed++;
    }

    res.json({ success: true, auto_completed: completed });
  } catch (err) {
    res.status(500).json({ error: 'Erreur auto-complétion' });
  }
});

module.exports = router;
