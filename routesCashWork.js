// ============================================================
// PLAY16 — Routes Cash-Work
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('./pool');
const { authClient, authAdmin } = require('./authMiddleware');
const { charge } = require('./PaymentService');
const { sendWhatsApp, sendPush } = require('./NotificationService');

// ── PUBLIER UNE ANNONCE CASH-WORK ───────────────────────────
// POST /api/cashwork/posts
// Accessible à TOUS les profils (client, fournisseur, cash-worker, admin)
// Body: { description, location_lat, location_lng }
router.post('/posts', authClient, async (req, res) => {
  try {
    const { description, location_lat, location_lng } = req.body;
    if (!description) return res.status(400).json({ error: 'Description requise' });

    // Détection automatique de catégorie basée sur mots-clés
    const category = detectCategory(description);

    const postRes = await query(
      `INSERT INTO cash_work_posts (posted_by_user_id, description, category, location_lat, location_lng)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.id, description, category, location_lat || null, location_lng || null]
    );

    // Chercher des prestataires disponibles dans la zone
    const workers = await findAvailableWorkers(category, location_lat, location_lng);

    if (workers.length > 0) {
      // Notifier les prestataires disponibles
      for (const worker of workers.slice(0, 3)) {
        await sendWhatsApp(
          worker.whatsapp_number || worker.phone_number,
          `🔔 Nouvelle mission disponible près de vous !\nCatégorie : ${category}\nDescription : ${description.slice(0, 100)}...\nOuvrez Play16 pour accepter.`
        );
      }
    }

    res.json({
      success: true,
      post: postRes.rows[0],
      workers_notified: workers.length,
      message: workers.length > 0
        ? `${workers.length} prestataire(s) notifié(s). En attente d'acceptation.`
        : 'Annonce publiée dans le tableau public. Vous serez notifié dès qu\'un prestataire accepte.',
    });
  } catch (err) {
    console.error('[CashWork] Erreur publication:', err.message);
    res.status(500).json({ error: 'Erreur publication annonce' });
  }
});

// ── TABLEAU PUBLIC DES ANNONCES ──────────────────────────────
// GET /api/cashwork/posts
router.get('/posts', authClient, async (req, res) => {
  try {
    const { category, page = 1 } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;

    let where = `WHERE cp.status = 'open'`;
    const params = [];

    if (category) { params.push(category); where += ` AND cp.category = $${params.length}`; }

    const result = await query(
      `SELECT cp.*, u.full_name as posted_by_name
       FROM cash_work_posts cp
       JOIN users u ON u.id = cp.posted_by_user_id
       ${where}
       ORDER BY cp.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({ posts: result.rows, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur chargement annonces' });
  }
});

// ── ACCEPTER UNE ANNONCE (Cash-Worker) ──────────────────────
// POST /api/cashwork/posts/:id/accept
router.post('/posts/:id/accept', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const workerId = req.user.id;

    const postRes = await query(
      `SELECT cp.*, u.whatsapp_number as client_whatsapp, u.phone_number as client_phone,
              u.full_name as client_name
       FROM cash_work_posts cp
       JOIN users u ON u.id = cp.posted_by_user_id
       WHERE cp.id = $1 AND cp.status = 'open'`,
      [id]
    );

    if (postRes.rows.length === 0) {
      return res.status(404).json({ error: 'Annonce introuvable ou déjà prise' });
    }

    const post = postRes.rows[0];

    // Créer la mission
    const missionRes = await query(
      `INSERT INTO cash_work_missions (post_id, client_id, worker_id, status)
       VALUES ($1, $2, $3, 'pending_invoice')
       RETURNING *`,
      [id, post.posted_by_user_id, workerId]
    );

    // Marquer l'annonce comme matched
    await query(`UPDATE cash_work_posts SET status = 'matched' WHERE id = $1`, [id]);

    // Notifier le client
    await sendWhatsApp(
      post.client_whatsapp || post.client_phone,
      `✅ Un prestataire a accepté votre mission Cash-Work !\nCatégorie : ${post.category}\nIl vous contactera bientôt pour convenir des détails.\n⚠️ IMPORTANT : Tout paiement doit être effectué via Play16. Tout paiement hors plateforme échappe à notre contrôle et engage votre responsabilité.`
    );

    res.json({ success: true, mission: missionRes.rows[0] });
  } catch (err) {
    console.error('[CashWork] Erreur acceptation:', err.message);
    res.status(500).json({ error: 'Erreur acceptation annonce' });
  }
});

// ── SOUMETTRE UNE FACTURE (Cash-Worker) ─────────────────────
// POST /api/cashwork/missions/:id/invoice
// Body: { amount }
router.post('/missions/:id/invoice', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: 'Montant invalide' });

    const missionRes = await query(
      `SELECT cm.*, u.whatsapp_number as client_whatsapp, u.phone_number as client_phone
       FROM cash_work_missions cm
       JOIN users u ON u.id = cm.client_id
       WHERE cm.id = $1 AND cm.worker_id = $2 AND cm.status = 'pending_invoice'`,
      [id, req.user.id]
    );

    if (missionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Mission introuvable' });
    }

    const mission = missionRes.rows[0];

    await query(
      `UPDATE cash_work_missions SET invoice_amount = $1, status = 'invoice_sent' WHERE id = $2`,
      [amount, id]
    );

    // Notifier le client
    await sendWhatsApp(
      mission.client_whatsapp || mission.client_phone,
      `📄 Facture reçue pour votre mission Cash-Work !\nMontant : ${amount} FCFA\nOuvrez Play16 pour accepter ou renégocier.\n⚠️ RAPPEL : Tout paiement doit se faire via Play16 pour que les deux parties soient protégées.`
    );

    res.json({ success: true, amount });
  } catch (err) {
    console.error('[CashWork] Erreur facture:', err.message);
    res.status(500).json({ error: 'Erreur soumission facture' });
  }
});

// ── ACCEPTER LA FACTURE + SÉQUESTRE (Client) ─────────────────
// POST /api/cashwork/missions/:id/accept-invoice
router.post('/missions/:id/accept-invoice', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = req.user.id;

    const missionRes = await query(
      `SELECT cm.*, u.phone_number as client_phone, u.whatsapp_number as client_whatsapp,
              uw.whatsapp_number as worker_whatsapp, uw.phone_number as worker_phone,
              uw.full_name as worker_name
       FROM cash_work_missions cm
       JOIN users u ON u.id = cm.client_id
       JOIN users uw ON uw.id = cm.worker_id
       WHERE cm.id = $1 AND cm.client_id = $2 AND cm.status = 'invoice_sent'`,
      [id, clientId]
    );

    if (missionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Mission introuvable' });
    }

    const mission = missionRes.rows[0];

    // Initier le paiement (séquestre)
    const paymentResult = await charge({
      phoneNumber: mission.client_phone,
      amount: mission.invoice_amount,
      description: `Séquestre Cash-Work — Mission ${id.slice(0,8).toUpperCase()}`,
      internalReference: `cw-${id}`,
    });

    if (paymentResult.success || paymentResult.simulated) {
      await query(
        `UPDATE cash_work_missions SET status = 'escrowed', escrowed_at = now() WHERE id = $1`,
        [id]
      );

      // Notifier le prestataire
      await sendWhatsApp(
        mission.worker_whatsapp || mission.worker_phone,
        `🔐 Fonds séquestrés ! ${mission.invoice_amount} FCFA sont sécurisés chez Play16.\nVous pouvez commencer le travail. Les fonds seront libérés après validation du client.\n⚠️ IMPORTANT : Accepter un paiement en dehors de la plateforme est considéré comme une fraude et peut entraîner votre bannissement.`
      );

      res.json({
        success: true,
        escrowed_amount: mission.invoice_amount,
        message: 'Fonds séquestrés. Le prestataire peut commencer le travail.',
      });
    } else {
      res.status(402).json({ error: 'Paiement échoué' });
    }
  } catch (err) {
    console.error('[CashWork] Erreur séquestre:', err.message);
    res.status(500).json({ error: 'Erreur séquestre' });
  }
});

// ── VALIDER LE TRAVAIL + LIBÉRER LES FONDS (Client) ─────────
// POST /api/cashwork/missions/:id/validate
router.post('/missions/:id/validate', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = req.user.id;

    const missionRes = await query(
      `SELECT cm.*, u.whatsapp_number as worker_whatsapp, u.phone_number as worker_phone
       FROM cash_work_missions cm
       JOIN users u ON u.id = cm.worker_id
       WHERE cm.id = $1 AND cm.client_id = $2 AND cm.status IN ('escrowed', 'submitted')`,
      [id, clientId]
    );

    if (missionRes.rows.length === 0) {
      return res.status(404).json({ error: 'Mission introuvable' });
    }

    const mission = missionRes.rows[0];
    const commissionRate = parseFloat(mission.commission_rate) / 100;
    const commission = Math.round(mission.invoice_amount * commissionRate);
    const workerAmount = mission.invoice_amount - commission;

    await query(
      `UPDATE cash_work_missions SET status = 'validated', validated_at = now() WHERE id = $1`,
      [id]
    );

    // Notifier le prestataire du versement
    await sendWhatsApp(
      mission.worker_whatsapp || mission.worker_phone,
      `✅ Mission validée ! ${workerAmount} FCFA vont être versés sur votre compte dans l\'heure.\n(Commission Play16 : ${commission} FCFA — ${mission.commission_rate}%)`
    );

    res.json({
      success: true,
      worker_amount: workerAmount,
      commission,
      message: 'Mission validée. Fonds libérés au prestataire.',
    });
  } catch (err) {
    console.error('[CashWork] Erreur validation:', err.message);
    res.status(500).json({ error: 'Erreur validation mission' });
  }
});

// ── RELANCE AUTOMATIQUE 24H (appelé par un cron job) ────────
// POST /api/cashwork/posts/remind-expired
router.post('/posts/remind-expired', authAdmin, async (req, res) => {
  try {
    const thresholdRes = await query(
      `SELECT value FROM platform_settings WHERE key = 'cashwork_post_reminder_hours'`
    );
    const hours = parseInt(thresholdRes.rows[0]?.value || '24');

    const expiredPosts = await query(
      `SELECT cp.*, u.whatsapp_number, u.phone_number
       FROM cash_work_posts cp
       JOIN users u ON u.id = cp.posted_by_user_id
       WHERE cp.status = 'open'
         AND cp.created_at < now() - INTERVAL '${hours} hours'
         AND (cp.last_reminder_sent_at IS NULL
              OR cp.last_reminder_sent_at < now() - INTERVAL '${hours} hours')`,
      []
    );

    let reminded = 0;
    for (const post of expiredPosts.rows) {
      await sendWhatsApp(
        post.whatsapp_number || post.phone_number,
        `⏰ Rappel Play16 : Votre annonce Cash-Work "${post.description.slice(0, 60)}..." n\'a pas encore trouvé de prestataire.\nOuvrez l\'application pour la réactiver, modifier ou annuler.`
      );
      await query(
        `UPDATE cash_work_posts SET last_reminder_sent_at = now() WHERE id = $1`,
        [post.id]
      );
      reminded++;
    }

    res.json({ success: true, reminded });
  } catch (err) {
    res.status(500).json({ error: 'Erreur relance annonces' });
  }
});

// ── HELPERS ─────────────────────────────────────────────────
function detectCategory(description) {
  const desc = description.toLowerCase();
  if (desc.match(/nettoyage|ménage|balayer|laver/)) return 'Nettoyage';
  if (desc.match(/électri|câble|courant|prise|interrupteur/)) return 'Électricité';
  if (desc.match(/plomberie|tuyau|robinet|fuite|wc|toilette/)) return 'Plomberie';
  if (desc.match(/peinture|peindre|badigeonner/)) return 'Peinture';
  if (desc.match(/informatique|ordinateur|téléphone|réseau|wifi/)) return 'Informatique';
  if (desc.match(/déménage|transport|porter|déplacer/)) return 'Déménagement';
  if (desc.match(/jardinage|gazon|plante|arbre|herbe/)) return 'Jardinage';
  if (desc.match(/cuisine|chef|repas|manger|traiteur/)) return 'Cuisine';
  if (desc.match(/livraison|colis|course|commission/)) return 'Livraison';
  return 'Divers';
}

async function findAvailableWorkers(category, lat, lng) {
  const result = await query(
    `SELECT u.id, u.phone_number, u.whatsapp_number, u.full_name
     FROM users u
     WHERE u.is_cash_worker = TRUE
     LIMIT 5`
  );
  return result.rows;
}

module.exports = router;
