// ============================================================
// PLAY16 — Routes Commandes (avec Feature Flags)
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('./pool');
const { authClient, authAdmin } = require('./authMiddleware');
const { charge } = require('./PaymentService');
const { sendWhatsApp } = require('./NotificationService');
const { isFeatureEnabled } = require('./routesFeatures');

// ── CRÉER UNE COMMANDE ──────────────────────────────────────
router.post('/', authClient, async (req, res) => {
  try {
    const { product_variant_id, payment_method } = req.body;
    const clientId = req.user.id;

    const variantRes = await query(
      `SELECT pv.*, p.base_price, p.discounted_price, p.cashback_amount,
              p.supplier_id, p.name as product_name,
              u.supplier_verified, u.whatsapp_number as supplier_whatsapp
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       JOIN users u ON u.id = p.supplier_id
       WHERE pv.id = $1 AND p.is_active = TRUE`,
      [product_variant_id]
    );

    if (variantRes.rows.length === 0) return res.status(404).json({ error: 'Produit introuvable' });
    const variant = variantRes.rows[0];
    if (variant.stock < 1) return res.status(400).json({ error: 'Stock épuisé' });

    const price = variant.discounted_price || variant.base_price;

    const orderRes = await query(
      `INSERT INTO orders (client_id, supplier_id, product_variant_id, total_amount, status, payment_method)
       VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING *`,
      [clientId, variant.supplier_id, product_variant_id, price, payment_method]
    );
    const order = orderRes.rows[0];

    await query(`UPDATE product_variants SET stock = stock - 1 WHERE id = $1`, [product_variant_id]);

    if (payment_method === 'mobile_money') {
      const clientRes = await query(`SELECT phone_number FROM users WHERE id = $1`, [clientId]);
      const paymentResult = await charge({
        phoneNumber: clientRes.rows[0].phone_number,
        amount: price,
        description: `Commande Play16 — ${variant.product_name}`,
        internalReference: order.id,
      });

      if (paymentResult.success || paymentResult.simulated) {
        await query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
        if (variant.supplier_whatsapp) {
          await sendWhatsApp(variant.supplier_whatsapp,
            `[Message généré sur la base des informations fournies par l'acheteur]\n🛍️ Nouvelle commande Play16 !\nProduit : ${variant.product_name}\nMontant : ${price} FCFA (séquestré)`);
        }
      } else {
        await query(`UPDATE product_variants SET stock = stock + 1 WHERE id = $1`, [product_variant_id]);
        await query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
        return res.status(402).json({ error: 'Paiement échoué' });
      }
    }

    res.json({ success: true, order: { id: order.id, status: 'paid', total_amount: price } });
  } catch (err) {
    console.error('[Orders] Erreur:', err.message);
    res.status(500).json({ error: 'Erreur création commande' });
  }
});

// ── MES COMMANDES ───────────────────────────────────────────
router.get('/my', authClient, async (req, res) => {
  try {
    const clientId = req.user.id;
    const { status } = req.query;
    let where = 'WHERE o.client_id = $1';
    const params = [clientId];
    if (status) { params.push(status); where += ` AND o.status = $${params.length}`; }

    const result = await query(
      `SELECT o.id, o.status, o.total_amount, o.payment_method, o.created_at,
              p.name as product_name, p.image_urls, pv.color, pv.size,
              u.full_name as supplier_name, d.status as delivery_status
       FROM orders o
       JOIN product_variants pv ON pv.id = o.product_variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN users u ON u.id = o.supplier_id
       LEFT JOIN deliveries d ON d.order_id = o.id
       ${where} ORDER BY o.created_at DESC`,
      params
    );

    // Politique de retour : affichage contrôlé par Super Admin
    const showReturn = await query(`SELECT value FROM platform_settings WHERE key = 'show_return_policy_notice_to_client'`);
    const showReturnPolicy = showReturn.rows[0]?.value !== 'false';

    res.json({
      orders: result.rows,
      return_policy: showReturnPolicy ? {
        show: true,
        cases: [
          "Produit livré → échange possible (frais à votre charge)",
          "Non encore livré → remboursement intégral",
          "Refus à la livraison → 2 000 FCFA déduits",
          "Retour après livraison → remboursement en 32 à 62 jours"
        ]
      } : { show: false },
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur chargement commandes' });
  }
});

// ── CONFIRMER LA RÉCEPTION ──────────────────────────────────
router.post('/:id/confirm-receipt', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = req.user.id;

    const orderRes = await query(
      `SELECT o.*, p.cashback_amount, u.supplier_verified
       FROM orders o
       JOIN product_variants pv ON pv.id = o.product_variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN users u ON u.id = o.supplier_id
       WHERE o.id = $1 AND o.client_id = $2`,
      [id, clientId]
    );
    if (orderRes.rows.length === 0) return res.status(404).json({ error: 'Commande introuvable' });
    const order = orderRes.rows[0];

    await query(`UPDATE orders SET status = 'delivered' WHERE id = $1`, [id]);
    await query(`UPDATE deliveries SET status = 'delivered', completed_at = now() WHERE order_id = $1`, [id]);

    // Cashback — uniquement si feature activée ET fournisseur vérifié
    const cashbackEnabled = await isFeatureEnabled('cashback_system');
    let cashbackCredited = 0;
    let propose2FA = false;

    if (cashbackEnabled && order.supplier_verified && order.cashback_amount > 0) {
      await query(
        `INSERT INTO cashback_transactions (user_id, order_id, amount, type) VALUES ($1, $2, $3, 'purchase')`,
        [clientId, id, order.cashback_amount]
      );
      await query(`UPDATE users SET cashback_balance = cashback_balance + $1 WHERE id = $2`, [order.cashback_amount, clientId]);
      cashbackCredited = order.cashback_amount;

      // Proposer 2FA après seuil
      const count = await query(`SELECT COUNT(*) as cnt FROM cashback_transactions WHERE user_id = $1 AND type = 'purchase'`, [clientId]);
      const threshold = await query(`SELECT value FROM platform_settings WHERE key = 'two_fa_trigger_cashback_count'`);
      propose2FA = parseInt(count.rows[0].cnt) >= parseInt(threshold.rows[0]?.value || '2');
    }

    res.json({
      success: true,
      cashback_credited: cashbackCredited,
      cashback_feature_enabled: cashbackEnabled,
      propose_2fa: propose2FA,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur confirmation livraison' });
  }
});

// ── TOUTES LES COMMANDES (Admin) ────────────────────────────
router.get('/admin/all', authAdmin, async (req, res) => {
  try {
    const { status, page = 1 } = req.query;
    const limit = 30;
    const offset = (page - 1) * limit;
    let where = 'WHERE 1=1';
    const params = [];
    if (status) { params.push(status); where += ` AND o.status = $${params.length}`; }

    const result = await query(
      `SELECT o.*, p.name as product_name,
              uc.full_name as client_name, uc.phone_number as client_phone,
              us.full_name as supplier_name, d.status as delivery_status,
              CASE WHEN o.created_by_admin_id IS NULL THEN 'auto' ELSE 'manuel' END as origin
       FROM orders o
       JOIN product_variants pv ON pv.id = o.product_variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN users uc ON uc.id = o.client_id
       JOIN users us ON us.id = o.supplier_id
       LEFT JOIN deliveries d ON d.order_id = o.id
       ${where} ORDER BY o.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ orders: result.rows, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur commandes admin' });
  }
});

module.exports = router;
