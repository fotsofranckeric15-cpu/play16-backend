// ============================================================
// PLAY16 — Routes Livraisons & GPS
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('./pool');
const { authClient, authAdmin } = require('./authMiddleware');
const { sendWhatsApp, sendPush } = require('./NotificationService');

// ── CRÉER UNE LIVRAISON (Admin manuel) ─────────────────────
// POST /api/deliveries
// Body: { order_id }
router.post('/', authAdmin, async (req, res) => {
  try {
    const { order_id } = req.body;

    const orderRes = await query(
      `SELECT o.*, p.name as product_name,
              uc.full_name as client_name, uc.phone_number as client_phone,
              uc.whatsapp_number as client_whatsapp
       FROM orders o
       JOIN product_variants pv ON pv.id = o.product_variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN users uc ON uc.id = o.client_id
       WHERE o.id = $1`,
      [order_id]
    );

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Commande introuvable' });
    }

    const order = orderRes.rows[0];

    const deliveryRes = await query(
      `INSERT INTO deliveries (order_id, status, created_by_admin_id)
       VALUES ($1, 'awaiting_pickup', $2)
       RETURNING *`,
      [order_id, req.admin.id]
    );
    const delivery = deliveryRes.rows[0];

    // Mettre à jour le statut de la commande
    await query(`UPDATE orders SET status = 'in_transit' WHERE id = $1`, [order_id]);

    // Notifier le client
    await sendWhatsApp(
      order.client_whatsapp || order.client_phone,
      `[Message généré sur la base des informations fournies par notre équipe]\n🚗 Votre commande est en cours de préparation pour livraison !\nCommande : ${order.product_name}\nNous vous confirmerons dès qu'un livreur est assigné.`
    );

    // Journaliser l'action admin
    await query(
      `INSERT INTO admin_session_actions (action_type, description, target_table, target_id)
       VALUES ('create_delivery', $1, 'deliveries', $2)`,
      [`Livraison manuelle créée pour commande ${order_id}`, delivery.id]
    );

    res.json({
      success: true,
      delivery: delivery,
      message: 'Livraison créée. Notification envoyée aux livreurs disponibles.',
    });
  } catch (err) {
    console.error('[Deliveries] Erreur création:', err.message);
    res.status(500).json({ error: 'Erreur création livraison' });
  }
});

// ── TOUTES LES LIVRAISONS (Admin — auto + manuelles) ────────
// GET /api/deliveries/admin/all
router.get('/admin/all', authAdmin, async (req, res) => {
  try {
    const { type, status, page = 1 } = req.query;
    const limit = 30;
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params = [];

    if (status) { params.push(status); where += ` AND d.status = $${params.length}`; }
    if (type === 'manuel') where += ` AND d.created_by_admin_id IS NOT NULL`;
    if (type === 'auto') where += ` AND d.created_by_admin_id IS NULL`;

    const result = await query(
      `SELECT
         d.id, d.status, d.created_at, d.completed_at,
         CASE WHEN d.created_by_admin_id IS NULL THEN 'automatique' ELSE 'manuel' END as origin,
         a.full_name as created_by_admin_name,
         o.total_amount, o.payment_method,
         p.name as product_name,
         uc.full_name as client_name, uc.phone_number as client_phone,
         ul.full_name as livreur_name, ul.phone_number as livreur_phone,
         -- Dernière position GPS du livreur (TOUJOURS visible pour admin)
         dl.latitude, dl.longitude, dl.recorded_at as last_location_at
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       JOIN product_variants pv ON pv.id = o.product_variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN users uc ON uc.id = o.client_id
       LEFT JOIN users ul ON ul.id = d.delivery_person_id
       LEFT JOIN admin_accounts a ON a.id = d.created_by_admin_id
       LEFT JOIN LATERAL (
         SELECT latitude, longitude, recorded_at
         FROM delivery_locations
         WHERE delivery_id = d.id
         ORDER BY recorded_at DESC LIMIT 1
       ) dl ON TRUE
       ${where}
       ORDER BY d.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({ deliveries: result.rows, page: parseInt(page) });
  } catch (err) {
    console.error('[Deliveries] Erreur admin liste:', err.message);
    res.status(500).json({ error: 'Erreur chargement livraisons' });
  }
});

// ── METTRE À JOUR LA POSITION GPS (Livreur) ─────────────────
// POST /api/deliveries/:id/location
// Body: { latitude, longitude }
// RÈGLE : position TOUJOURS transmise et stockée.
// La visibilité CLIENT est contrôlée par location_sharing_client_enabled.
// L'admin/super admin VOIT TOUJOURS la position, sans exception.
router.post('/:id/location', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const { latitude, longitude } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'Coordonnées requises' });
    }

    await query(
      `INSERT INTO delivery_locations (delivery_id, latitude, longitude, recorded_at)
       VALUES ($1, $2, $3, now())`,
      [id, latitude, longitude]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur mise à jour position' });
  }
});

// ── POSITION EN TEMPS RÉEL (Admin — TOUJOURS visible) ───────
// GET /api/deliveries/:id/location/admin
router.get('/:id/location/admin', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Admin voit TOUJOURS la position — aucun filtre
    const result = await query(
      `SELECT latitude, longitude, recorded_at
       FROM delivery_locations
       WHERE delivery_id = $1
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.json({ location: null, message: 'Aucune position enregistrée' });
    }

    res.json({ location: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture position' });
  }
});

// ── POSITION EN TEMPS RÉEL (Client — selon choix livreur) ───
// GET /api/deliveries/:id/location/client
router.get('/:id/location/client', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = req.user.id;

    // Vérifier que cette livraison appartient au client
    const deliveryRes = await query(
      `SELECT d.location_sharing_client_enabled
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       WHERE d.id = $1 AND o.client_id = $2`,
      [id, clientId]
    );

    if (deliveryRes.rows.length === 0) {
      return res.status(404).json({ error: 'Livraison introuvable' });
    }

    const delivery = deliveryRes.rows[0];

    if (!delivery.location_sharing_client_enabled) {
      return res.json({
        location: null,
        sharing_enabled: false,
        message: 'Le livreur n\'a pas activé le partage de position',
      });
    }

    const result = await query(
      `SELECT latitude, longitude, recorded_at
       FROM delivery_locations
       WHERE delivery_id = $1
       ORDER BY recorded_at DESC LIMIT 1`,
      [id]
    );

    res.json({
      location: result.rows[0] || null,
      sharing_enabled: true,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture position' });
  }
});

// ── ACTIVER/DÉSACTIVER PARTAGE POSITION (Livreur → client) ──
// PUT /api/deliveries/:id/location/sharing
// Body: { enabled: true|false }
router.put('/:id/location/sharing', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;

    await query(
      `UPDATE deliveries SET location_sharing_client_enabled = $1 WHERE id = $2`,
      [!!enabled, id]
    );

    res.json({ success: true, sharing_enabled: !!enabled });
  } catch (err) {
    res.status(500).json({ error: 'Erreur mise à jour partage position' });
  }
});

// ── ACCEPTER UNE LIVRAISON (Livreur) ────────────────────────
// POST /api/deliveries/:id/accept
router.post('/:id/accept', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const livreurId = req.user.id;

    const result = await query(
      `UPDATE deliveries
       SET delivery_person_id = $1, status = 'in_progress'
       WHERE id = $2 AND delivery_person_id IS NULL
       RETURNING *`,
      [livreurId, id]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Livraison déjà prise en charge' });
    }

    res.json({ success: true, delivery: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erreur acceptation livraison' });
  }
});

// ── TERMINER UNE LIVRAISON (Livreur) ────────────────────────
// POST /api/deliveries/:id/complete
router.post('/:id/complete', authClient, async (req, res) => {
  try {
    const { id } = req.params;

    const deliveryRes = await query(
      `SELECT d.*, o.client_id, o.id as order_id, p.name as product_name,
              uc.whatsapp_number as client_whatsapp, uc.phone_number as client_phone
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       JOIN product_variants pv ON pv.id = o.product_variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN users uc ON uc.id = o.client_id
       WHERE d.id = $1 AND d.delivery_person_id = $2`,
      [id, req.user.id]
    );

    if (deliveryRes.rows.length === 0) {
      return res.status(404).json({ error: 'Livraison introuvable' });
    }

    const delivery = deliveryRes.rows[0];

    await query(`UPDATE deliveries SET status = 'delivered' WHERE id = $1`, [id]);

    // Notifier le client pour confirmation
    await sendWhatsApp(
      delivery.client_whatsapp || delivery.client_phone,
      `[Message généré sur la base des informations fournies par le livreur]\n📦 Votre colis est arrivé !\nProduit : ${delivery.product_name}\nOuvrez Play16 et confirmez la réception pour libérer le paiement et recevoir votre cashback.`
    );

    res.json({
      success: true,
      message: 'Livraison terminée. Notification envoyée au client.',
    });
  } catch (err) {
    console.error('[Deliveries] Erreur complétion:', err.message);
    res.status(500).json({ error: 'Erreur complétion livraison' });
  }
});

module.exports = router;
