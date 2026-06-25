// ============================================================
// PLAY16 — Routes Livraisons (version sécurisée GPS)
// ============================================================
const express = require('express');
const router  = express.Router();
const { query } = require('./pool');
const { authClient, authAdmin } = require('./authMiddleware');
const { sendWhatsApp } = require('./NotificationService');
const {
  validateGPSCoordinates, checkGPSRateLimit, createFraudAlert,
} = require('./securityMiddleware');

// ── METTRE À JOUR LA POSITION GPS ───────────────────────────
router.post('/:id/location', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const { latitude, longitude } = req.body;

    if (latitude == null || longitude == null) return res.status(400).json({ error: 'Coordonnées requises' });

    // Rate limit GPS
    await checkGPSRateLimit(id);

    // Validation coordonnées (bbox Cameroun + vitesse)
    try {
      await validateGPSCoordinates(id, parseFloat(latitude), parseFloat(longitude));
    } catch (gpsErr) {
      await createFraudAlert(req.user.id, 'GPS_ANOMALY', 'medium', gpsErr.message);
      return res.status(400).json({ error: gpsErr.message });
    }

    await query(
      `INSERT INTO delivery_locations (delivery_id, latitude, longitude) VALUES ($1,$2,$3)`,
      [id, latitude, longitude]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.message.includes('fréquente')) return res.status(429).json({ error: err.message });
    res.status(500).json({ error: 'Erreur mise à jour position' });
  }
});

// ── POSITION ADMIN (TOUJOURS VISIBLE) ───────────────────────
router.get('/:id/location/admin', authAdmin, async (req, res) => {
  try {
    const r = await query(
      `SELECT latitude, longitude, recorded_at FROM delivery_locations
       WHERE delivery_id=$1 ORDER BY recorded_at DESC LIMIT 1`, [req.params.id]
    );
    res.json({ location: r.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture position' });
  }
});

// ── POSITION CLIENT (opt-in livreur) ────────────────────────
router.get('/:id/location/client', authClient, async (req, res) => {
  try {
    const deliveryRes = await query(
      `SELECT d.location_sharing_client_enabled FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       WHERE d.id=$1 AND o.client_id=$2`, [req.params.id, req.user.id]
    );
    if (!deliveryRes.rows[0]) return res.status(404).json({ error: 'Livraison introuvable' });
    if (!deliveryRes.rows[0].location_sharing_client_enabled) {
      return res.json({ location: null, sharing_enabled: false });
    }
    const r = await query(
      `SELECT latitude, longitude, recorded_at FROM delivery_locations
       WHERE delivery_id=$1 ORDER BY recorded_at DESC LIMIT 1`, [req.params.id]
    );
    res.json({ location: r.rows[0] || null, sharing_enabled: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture position' });
  }
});

// ── TOGGLE PARTAGE POSITION ──────────────────────────────────
router.put('/:id/location/sharing', authClient, async (req, res) => {
  try {
    await query(`UPDATE deliveries SET location_sharing_client_enabled=$1 WHERE id=$2`, [!!req.body.enabled, req.params.id]);
    res.json({ success: true, sharing_enabled: !!req.body.enabled });
  } catch (err) {
    res.status(500).json({ error: 'Erreur partage position' });
  }
});

// ── CRÉER LIVRAISON (Admin) ──────────────────────────────────
router.post('/', authAdmin, async (req, res) => {
  try {
    const { order_id } = req.body;
    const dr = await query(`INSERT INTO deliveries (order_id,created_by_admin_id) VALUES ($1,$2) RETURNING *`, [order_id, req.admin.id]);
    await query(`UPDATE orders SET status='in_transit' WHERE id=$1`, [order_id]);
    await query(`INSERT INTO admin_session_actions (action_type,description,target_table,target_id) VALUES ('create_delivery',$1,'deliveries',$2)`,
      [`Livraison manuelle créée pour commande ${order_id}`, dr.rows[0].id]);
    res.json({ success: true, delivery: dr.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erreur création livraison' });
  }
});

// ── LISTE LIVRAISONS ADMIN ───────────────────────────────────
router.get('/admin/all', authAdmin, async (req, res) => {
  try {
    const { type, status, page=1 } = req.query;
    const limit=30, offset=(page-1)*limit;
    let where='WHERE 1=1'; const params=[];
    if (status) { params.push(status); where+=` AND d.status=$${params.length}`; }
    if (type==='manuel') where+=` AND d.created_by_admin_id IS NOT NULL`;
    if (type==='auto')   where+=` AND d.created_by_admin_id IS NULL`;
    const r = await query(
      `SELECT d.id,d.status,d.created_at,
              CASE WHEN d.created_by_admin_id IS NULL THEN 'automatique' ELSE 'manuel' END as origin,
              o.total_amount, p.name as product_name,
              uc.full_name as client_name, uc.phone_number as client_phone,
              ul.full_name as livreur_name,
              dl.latitude, dl.longitude, dl.recorded_at as last_gps
       FROM deliveries d JOIN orders o ON o.id=d.order_id
       JOIN product_variants pv ON pv.id=o.product_variant_id
       JOIN products p ON p.id=pv.product_id
       JOIN users uc ON uc.id=o.client_id
       LEFT JOIN users ul ON ul.id=d.delivery_person_id
       LEFT JOIN LATERAL (
         SELECT latitude,longitude,recorded_at FROM delivery_locations
         WHERE delivery_id=d.id ORDER BY recorded_at DESC LIMIT 1
       ) dl ON TRUE
       ${where} ORDER BY d.created_at DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params,limit,offset]
    );
    res.json({ deliveries: r.rows, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur liste livraisons' });
  }
});

// ── ACCEPTER / TERMINER LIVRAISON ────────────────────────────
router.post('/:id/accept', authClient, async (req, res) => {
  try {
    const r = await query(
      `UPDATE deliveries SET delivery_person_id=$1,status='in_progress' WHERE id=$2 AND delivery_person_id IS NULL RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!r.rows[0]) return res.status(409).json({ error: 'Livraison déjà prise en charge' });
    res.json({ success: true, delivery: r.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erreur acceptation' }); }
});

router.post('/:id/complete', authClient, async (req, res) => {
  try {
    const dr = await query(
      `SELECT d.*,o.client_id,p.name as product_name,uc.whatsapp_number as cwa,uc.phone_number as cp
       FROM deliveries d JOIN orders o ON o.id=d.order_id
       JOIN product_variants pv ON pv.id=o.product_variant_id
       JOIN products p ON p.id=pv.product_id
       JOIN users uc ON uc.id=o.client_id
       WHERE d.id=$1 AND d.delivery_person_id=$2`, [req.params.id, req.user.id]
    );
    if (!dr.rows[0]) return res.status(404).json({ error: 'Livraison introuvable' });
    const d = dr.rows[0];
    await query(`UPDATE deliveries SET status='delivered' WHERE id=$1`, [req.params.id]);
    await sendWhatsApp(d.cwa||d.cp,
      `[Message généré sur la base des informations fournies par le livreur]\n📦 Votre colis "${d.product_name}" est arrivé ! Confirmez la réception dans Play16 pour libérer le paiement.`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erreur complétion livraison' }); }
});

module.exports = router;
