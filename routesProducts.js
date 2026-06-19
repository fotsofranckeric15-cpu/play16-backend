// ============================================================
// PLAY16 — Routes Produits (Marketplace)
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('./pool');
const { authClient, authAdmin, authSuperAdmin } = require('./authMiddleware');

// ── LISTE DES PRODUITS (avec boost et filtre catégorie) ─────
// GET /api/products?category=chaussures&page=1
router.get('/', async (req, res) => {
  try {
    const { category, page = 1 } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE p.is_active = TRUE';
    const params = [];

    if (category) {
      params.push(category);
      whereClause += ` AND p.category = $${params.length}`;
    }

    // Notification vendeur non vérifié : inclus dans la réponse produit
    const result = await query(
      `SELECT
         p.id, p.name, p.base_price, p.discounted_price,
         p.cashback_amount, p.boost_level_active,
         p.image_urls, p.click_count,
         u.supplier_verified,
         u.full_name as supplier_name
       FROM products p
       JOIN users u ON u.id = p.supplier_id
       ${whereClause}
       ORDER BY p.boost_level_active DESC, p.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      products: result.rows.map(p => ({
        ...p,
        // Indique si une notification "non vérifié" doit s'afficher
        show_unverified_notice: !p.supplier_verified,
      })),
      page: parseInt(page),
      has_more: result.rows.length === limit,
    });
  } catch (err) {
    console.error('[Products] Erreur liste:', err.message);
    res.status(500).json({ error: 'Erreur chargement produits' });
  }
});

// ── DÉTAIL D'UN PRODUIT ─────────────────────────────────────
// GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT
         p.*,
         u.supplier_verified,
         u.full_name as supplier_name,
         u.whatsapp_number as supplier_whatsapp
       FROM products p
       JOIN users u ON u.id = p.supplier_id
       WHERE p.id = $1 AND p.is_active = TRUE`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produit introuvable' });
    }

    // Charger les variantes
    const variants = await query(
      `SELECT * FROM product_variants WHERE product_id = $1`,
      [id]
    );

    const product = result.rows[0];

    res.json({
      ...product,
      variants: variants.rows,
      show_unverified_notice: !product.supplier_verified,
      // Message de notification à afficher au client
      unverified_notice_text: !product.supplier_verified
        ? "Pour sécuriser votre achat chez ce vendeur non vérifié, préférez le paiement via Play16 (séquestre) ou le paiement à la livraison. Tout paiement effectué autrement échappe au contrôle de Play16."
        : null,
    });
  } catch (err) {
    console.error('[Products] Erreur détail:', err.message);
    res.status(500).json({ error: 'Erreur chargement produit' });
  }
});

// ── ENREGISTRER UN CLIC SUR UN PRODUIT ─────────────────────
// POST /api/products/:id/click
router.post('/:id/click', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id || null;

    await query(
      `INSERT INTO product_clicks (product_id, user_id, ip_address, clicked_at)
       VALUES ($1, $2, $3, now())`,
      [id, userId, req.ip]
    );

    await query(
      `UPDATE products SET click_count = click_count + 1 WHERE id = $1`,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur enregistrement clic' });
  }
});

// ── HISTORIQUE DES CLICS (Admin) ────────────────────────────
// GET /api/products/:id/clicks
router.get('/:id/clicks', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1 } = req.query;
    const limit = 50;
    const offset = (page - 1) * limit;

    const clicks = await query(
      `SELECT
         pc.clicked_at, pc.ip_address,
         u.phone_number, u.full_name
       FROM product_clicks pc
       LEFT JOIN users u ON u.id = pc.user_id
       WHERE pc.product_id = $1
       ORDER BY pc.clicked_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    const total = await query(
      `SELECT COUNT(*) as total FROM product_clicks WHERE product_id = $1`,
      [id]
    );

    const conversions = await query(
      `SELECT COUNT(*) as total FROM orders o
       JOIN product_variants pv ON pv.id = o.product_variant_id
       WHERE pv.product_id = $1`,
      [id]
    );

    res.json({
      clicks: clicks.rows,
      total_clicks: parseInt(total.rows[0].total),
      total_orders: parseInt(conversions.rows[0].total),
      conversion_rate: total.rows[0].total > 0
        ? ((conversions.rows[0].total / total.rows[0].total) * 100).toFixed(1) + '%'
        : '0%',
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur historique clics' });
  }
});

// ── DEMANDE DE BOOST (Fournisseur) ──────────────────────────
// POST /api/products/:id/boost-request
// Body: { level: 8 }
router.post('/:id/boost-request', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const { level } = req.body;
    const userId = req.user.id;

    if (level < 0 || level > 10) {
      return res.status(400).json({ error: 'Niveau de boost entre 0 et 10' });
    }

    // Vérifie que le produit appartient au fournisseur
    const productRes = await query(
      `SELECT * FROM products WHERE id = $1 AND supplier_id = $2`,
      [id, userId]
    );
    if (productRes.rows.length === 0) {
      return res.status(403).json({ error: 'Produit introuvable ou accès refusé' });
    }

    // Crée la demande de boost (pas encore appliqué — validation Super Admin requise)
    await query(
      `INSERT INTO boost_requests (product_id, requested_level)
       VALUES ($1, $2)`,
      [id, level]
    );

    await query(
      `UPDATE products SET boost_status = 'pending_validation', boost_level_requested = $1
       WHERE id = $2`,
      [level, id]
    );

    res.json({
      success: true,
      message: 'Demande de mise en avant soumise. En attente de validation par l\'administrateur.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur demande boost' });
  }
});

// ── VALIDER UN BOOST (Super Admin uniquement) ───────────────
// POST /api/products/boost-requests/:requestId/approve
router.post('/boost-requests/:requestId/approve', authSuperAdmin, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { approved } = req.body; // true ou false

    const reqRes = await query(
      `SELECT * FROM boost_requests WHERE id = $1`,
      [requestId]
    );
    if (reqRes.rows.length === 0) {
      return res.status(404).json({ error: 'Demande introuvable' });
    }

    const boostReq = reqRes.rows[0];

    await query(
      `UPDATE boost_requests
       SET status = $1, reviewed_by = $2, reviewed_at = now()
       WHERE id = $3`,
      [approved ? 'approved' : 'rejected', req.admin.id, requestId]
    );

    if (approved) {
      await query(
        `UPDATE products
         SET boost_level_active = $1, boost_status = 'approved'
         WHERE id = $2`,
        [boostReq.requested_level, boostReq.product_id]
      );
    } else {
      await query(
        `UPDATE products SET boost_status = 'rejected' WHERE id = $1`,
        [boostReq.product_id]
      );
    }

    res.json({
      success: true,
      message: approved ? 'Boost approuvé et appliqué.' : 'Boost refusé.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur validation boost' });
  }
});

module.exports = router;
