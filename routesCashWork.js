// ============================================================
// PLAY16 — Routes Cash-Work (version sécurisée)
// Anti auto-achat, plafond facture, GPS mission uniquement
// ============================================================
const express = require('express');
const router  = express.Router();
const { query } = require('./pool');
const { authClient, authAdmin } = require('./authMiddleware');
const { charge } = require('./PaymentService');
const { sendWhatsApp } = require('./NotificationService');
const { checkNotOwnPost, checkCashworkInvoiceLimit } = require('./securityMiddleware');

const CATEGORIES = {
  nettoyage:['nettoyage','ménage','balayer','laver'],
  electricite:['électri','câble','courant','prise'],
  plomberie:['plomberie','tuyau','robinet','fuite'],
  peinture:['peinture','peindre'],
  informatique:['informatique','ordinateur','réseau','wifi'],
  demenagement:['déménage','transport','porter'],
  jardinage:['jardinage','gazon','plante'],
  cuisine:['cuisine','chef','repas','traiteur'],
  livraison:['livraison','colis','course'],
};

function detectCategory(desc) {
  const d = desc.toLowerCase();
  for (const [cat, kw] of Object.entries(CATEGORIES)) {
    if (kw.some(k => d.includes(k))) return cat;
  }
  return 'divers';
}

// ── PUBLIER UNE ANNONCE ──────────────────────────────────────
router.post('/posts', authClient, async (req, res) => {
  try {
    const { description, location_lat, location_lng } = req.body;
    if (!description) return res.status(400).json({ error: 'Description requise' });

    const category = detectCategory(description);
    const post = await query(
      `INSERT INTO cash_work_posts (posted_by_user_id,description,category,location_lat,location_lng)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, description, category, location_lat||null, location_lng||null]
    );

    const workers = await query(
      `SELECT phone_number,whatsapp_number FROM users WHERE is_cash_worker=TRUE LIMIT 5`
    );
    for (const w of workers.rows) {
      await sendWhatsApp(w.whatsapp_number||w.phone_number,
        `🔔 Nouvelle mission Cash-Work !\nCatégorie: ${category}\n${description.slice(0,100)}...\nOuvrez Play16 pour accepter.`
      ).catch(()=>{});
    }

    res.json({ success:true, post:post.rows[0], workers_notified:workers.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Erreur publication annonce' });
  }
});

// ── TABLEAU PUBLIC ───────────────────────────────────────────
router.get('/posts', authClient, async (req, res) => {
  try {
    const { category, page=1 } = req.query;
    const limit=20, offset=(page-1)*limit;
    let where=`WHERE cp.status='open'`; const params=[];
    if (category) { params.push(category); where+=` AND cp.category=$${params.length}`; }
    const r = await query(
      `SELECT cp.*,u.full_name as posted_by_name FROM cash_work_posts cp
       JOIN users u ON u.id=cp.posted_by_user_id
       ${where} ORDER BY cp.created_at DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params,limit,offset]
    );
    res.json({ posts:r.rows, page:parseInt(page) });
  } catch (err) { res.status(500).json({ error: 'Erreur annonces' }); }
});

// ── ACCEPTER UNE ANNONCE (avec vérification anti-auto-achat) ─
router.post('/posts/:id/accept', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const workerId = req.user.id;

    // SÉCURITÉ : interdire d'accepter sa propre annonce
    await checkNotOwnPost(id, workerId);

    const postRes = await query(
      `SELECT cp.*,u.whatsapp_number as cwha,u.phone_number as cp FROM cash_work_posts cp
       JOIN users u ON u.id=cp.posted_by_user_id WHERE cp.id=$1 AND cp.status='open'`, [id]
    );
    if (!postRes.rows[0]) return res.status(404).json({ error: 'Annonce introuvable ou déjà prise' });
    const post = postRes.rows[0];

    const mission = await query(
      `INSERT INTO cash_work_missions (post_id,client_id,worker_id,status) VALUES ($1,$2,$3,'pending_invoice') RETURNING *`,
      [id, post.posted_by_user_id, workerId]
    );
    await query(`UPDATE cash_work_posts SET status='matched' WHERE id=$1`, [id]);

    await sendWhatsApp(post.cwha||post.cp,
      `✅ Un prestataire a accepté votre mission Cash-Work !\nCatégorie: ${post.category}\n\n⚠️ IMPORTANT : Tout paiement DOIT se faire via Play16. Tout paiement hors plateforme vous engage personnellement et échappe à notre protection.`
    ).catch(()=>{});

    res.json({ success:true, mission:mission.rows[0] });
  } catch (err) {
    if (err.message.includes('propre annonce')) return res.status(403).json({ error: err.message });
    res.status(500).json({ error: 'Erreur acceptation' });
  }
});

// ── SOUMETTRE FACTURE (avec plafond) ─────────────────────────
router.post('/missions/:id/invoice', authClient, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount<=0) return res.status(400).json({ error: 'Montant invalide' });

    const mRes = await query(
      `SELECT cm.*,u.whatsapp_number as cwha,u.phone_number as cp,cp2.category
       FROM cash_work_missions cm
       JOIN users u ON u.id=cm.client_id
       JOIN cash_work_posts cp2 ON cp2.id=cm.post_id
       WHERE cm.id=$1 AND cm.worker_id=$2 AND cm.status='pending_invoice'`,
      [req.params.id, req.user.id]
    );
    if (!mRes.rows[0]) return res.status(404).json({ error: 'Mission introuvable' });

    // Vérifier plafond
    await checkCashworkInvoiceLimit(mRes.rows[0].category, parseInt(amount));

    await query(`UPDATE cash_work_missions SET invoice_amount=$1,status='invoice_sent' WHERE id=$2`, [amount, req.params.id]);

    await sendWhatsApp(mRes.rows[0].cwha||mRes.rows[0].cp,
      `📄 Facture reçue : ${parseInt(amount).toLocaleString()} FCFA\n\n⚠️ RAPPEL : Acceptez uniquement via Play16. Tout paiement hors plateforme vous engage seul.`
    ).catch(()=>{});

    res.json({ success:true, amount });
  } catch (err) {
    if (err.message.includes('trop élevé')) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Erreur facture' });
  }
});

// ── ACCEPTER FACTURE + SÉQUESTRE ─────────────────────────────
router.post('/missions/:id/accept-invoice', authClient, async (req, res) => {
  try {
    const mRes = await query(
      `SELECT cm.*,uc.phone_number as cp,uw.whatsapp_number as wwha,uw.phone_number as wp
       FROM cash_work_missions cm JOIN users uc ON uc.id=cm.client_id
       JOIN users uw ON uw.id=cm.worker_id
       WHERE cm.id=$1 AND cm.client_id=$2 AND cm.status='invoice_sent'`,
      [req.params.id, req.user.id]
    );
    if (!mRes.rows[0]) return res.status(404).json({ error: 'Mission introuvable' });
    const m = mRes.rows[0];

    const pay = await charge({ phoneNumber:m.cp, amount:m.invoice_amount, description:`Séquestre CW ${req.params.id.slice(0,8)}`, internalReference:`cw-${req.params.id}` });
    if (!pay.success && !pay.simulated) return res.status(402).json({ error: 'Paiement échoué' });

    await query(`UPDATE cash_work_missions SET status='escrowed',escrowed_at=now() WHERE id=$1`, [req.params.id]);
    await sendWhatsApp(m.wwha||m.wp,
      `🔐 ${m.invoice_amount?.toLocaleString()} FCFA séquestrés. Vous pouvez commencer le travail.\n\n⚠️ Accepter un paiement hors Play16 = fraude = bannissement possible.`
    ).catch(()=>{});

    res.json({ success:true, escrowed_amount:m.invoice_amount });
  } catch (err) { res.status(500).json({ error: 'Erreur séquestre' }); }
});

// ── VALIDER MISSION ──────────────────────────────────────────
router.post('/missions/:id/validate', authClient, async (req, res) => {
  try {
    const mRes = await query(
      `SELECT cm.*,uw.whatsapp_number as wwha,uw.phone_number as wp
       FROM cash_work_missions cm JOIN users uw ON uw.id=cm.worker_id
       WHERE cm.id=$1 AND cm.client_id=$2 AND cm.status IN ('escrowed','submitted')`,
      [req.params.id, req.user.id]
    );
    if (!mRes.rows[0]) return res.status(404).json({ error: 'Mission introuvable' });
    const m = mRes.rows[0];
    const commission = Math.round(m.invoice_amount * parseFloat(m.commission_rate) / 100);
    const workerAmt  = m.invoice_amount - commission;

    await query(`UPDATE cash_work_missions SET status='validated',validated_at=now() WHERE id=$1`, [req.params.id]);
    await sendWhatsApp(m.wwha||m.wp,
      `✅ Mission validée ! ${workerAmt.toLocaleString()} FCFA seront versés sous 1h. (Commission Play16: ${commission.toLocaleString()} FCFA)`
    ).catch(()=>{});

    res.json({ success:true, worker_amount:workerAmt, commission });
  } catch (err) { res.status(500).json({ error: 'Erreur validation' }); }
});

// ── RELANCE AUTO 24H ─────────────────────────────────────────
router.post('/posts/remind-expired', authAdmin, async (req, res) => {
  try {
    const r = await query(
      `SELECT cp.*,u.whatsapp_number,u.phone_number FROM cash_work_posts cp
       JOIN users u ON u.id=cp.posted_by_user_id
       WHERE cp.status='open' AND cp.created_at < now()-INTERVAL '24 hours'
       AND (cp.last_reminder_sent_at IS NULL OR cp.last_reminder_sent_at < now()-INTERVAL '24 hours')`
    );
    let reminded=0;
    for (const p of r.rows) {
      await sendWhatsApp(p.whatsapp_number||p.phone_number,
        `⏰ Votre annonce Cash-Work "${p.description.slice(0,60)}..." n'a pas encore de prestataire. Ouvrez Play16 pour la réactiver.`
      ).catch(()=>{});
      await query(`UPDATE cash_work_posts SET last_reminder_sent_at=now() WHERE id=$1`, [p.id]);
      reminded++;
    }
    res.json({ success:true, reminded });
  } catch (err) { res.status(500).json({ error: 'Erreur relance' }); }
});

module.exports = router;
