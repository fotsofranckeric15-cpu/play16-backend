// ============================================================
// PLAY16 — Routes Commandes & Séquestre
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('./pool');
const { authClient, authAdmin } = require('./authMiddleware');
const { charge } = require('./PaymentService');
const { sendWhatsApp, sendPush } = require('./NotificationService');
const { v4: uuidv4 } = require('uuid');

// ── CRÉER UNE COMMANDE ──────────────────────────────────────
// POST /api/orders
// Body: { product_variant_id, payment_method: "mobile_money"|"cash" }
router.post('/', authClient, async (req, res) => {
  try {
    const { product_variant_id, payment_method } = req.body;
    const clientId = req.user.id;

    // Vérifier le stock
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

    if (variantRes.rows.length === 0) {
      return res.status(404).json({ error: 'Produit introuvable ou inactif' });
    }

    const variant = variantRes.rows[0];
    if (variant.stock < 1) {
      return res.status(400).json({ error: 'Stock épuisé pour cette variante' });
    }

    const price = variant.discounted_price || variant.base_price;

    // Créer la commande
    const orderRes = await query(
      `INSERT INTO orders (client_id, supplier_id, product_variant_id, total_amount, status, payment_method)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING *`,
      [clientId, variant.supplier_id, product_variant_id, price, payment_method]
    );
    const order = orderRes.rows[0];

    // Décrémenter le stock
    await query(
      `UPDATE product_variants SET stock = stock - 1 WHERE id = $1`,
      [product_variant_id]
    );

    // Si paiement mobile money → initier le paiement + séquestre
    if (payment_method === 'mobile_money') {
      const clientRes = await query(`SELECT phone_number FROM users WHERE id = $1`, [clientId]);
      const phoneNumber = clientRes.rows[0].phone_number;

      const paymentResult = await charge({
        phoneNumber,
        amount: price,
        description: `Commande Play16 — ${variant.product_name}`,
        internalReference: order.id,
      });

      if (paymentResult.success || paymentResult.simulated) {
        await query(
          `UPDATE orders SET status = 'paid' WHERE id = $1`,
          [order.id]
        );

        // Notifier le fournisseur
        if (variant.supplier_whatsapp) {
          await sendWhatsApp(
            variant.supplier_whatsapp,
            `[Message généré sur la base des informations fournies par l'acheteur]\n🛍️ Nouvelle commande Play16 !\nProduit : ${variant.product_name}\nMontant : ${price} FCFA (séquestré)\nCommande #${order.id.slice(0,8).toUpperCase()}`
          );
        }
      } else {
        // Paiement échoué — remettre le stock
        await query(`UPDATE product_variants SET stock = stock + 1 WHERE id = $1`, [product_variant_id]);
        await query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [order.id]);
        return res.status(402).json({ error: 'Paiement échoué', requires_admin_review: paymentResult.requiresAdminReview });
      }
    }

    res.json({
      success: true,
      order: {
        id: order.id,
        status: payment_method === 'mobile_money' ? 'paid' : 'pending',
        total_amount: price,
        product_name: variant.product_name,
      },
    });
  } catch (err) {
    console.error('[Orders] Erreur création:', err.message);
    res.status(500).json({ error: 'Erreur création commande' });
  }
});

// ── MES COMMANDES ───────────────────────────────────────────
// GET /api/orders/my
router.get('/my', authClient, async (req, res) => {
  try {
    const clientId = req.user.id;
    const { status } = req.query;

    let whereClause = 'WHERE o.client_id = $1';
    const params = [clientId];

    if (status) {
      params.push(status);
      whereClause += ` AND o.status = $${params.length}`;
    }

    const result = await query(
      `SELECT
         o.id, o.status, o.total_amount, o.payment_method, o.created_at,
         p.name as product_name, p.image_urls,
         pv.color, pv.size,
         u.full_name as supplier_name,
         ct.amount as cashback_earned,
         d.status as delivery_status
       FROM orders o
       JOIN product_variants pv ON pv.id = o.product_variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN users u ON u.id = o.supplier_id
       LEFT JOIN cashback_transactions ct ON ct.order_id = o.id
       LEFT JOIN deliveries d ON d.order_id = o.id
       ${whereClause}
       ORDER BY o.created_at DESC`,
      params
    );

    // Lire le paramètre d'affichage de la politique de retour
    const settingRes = await query(
      `SELECT value FROM platform_settings WHERE key = 'show_return_policy_notice_to_client'`
    );
    const showReturnPolicy = settingRes.rows[0]?.value !== 'false';

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
    console.error('[Orders] Erreur liste:', err.message);
    res.status(500).json({ error: 'Erreur chargement commandes' });
  }
});

// ── CONFIRMER LA RÉCEPTION ──────────────────────────────────
// POST /api/orders/:id/confirm-receipt
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

    if (orderRes.rows.length === 0) {
      return res.status(404).json({ error: 'Commande introuvable' });
    }

    const order = orderRes.rows[0];
    if (!['paid', 'in_transit'].includes(order.status)) {
      return res.status(400).json({ error: 'Statut commande invalide pour confirmation' });
    }

    // Mettre à jour le statut
    await query(`UPDATE orders SET status = 'delivered' WHERE id = $1`, [id]);
    await query(`UPDATE deliveries SET status = 'delivered', completed_at = now() WHERE order_id = $1`, [id]);

    // Créditer le cashback (uniquement si fournisseur vérifié)
    let cashbackCredited = 0;
    if (order.supplier_verified && order.cashback_amount > 0) {
      await query(
        `INSERT INTO cashback_transactions (user_id, order_id, amount, type)
         VALUES ($1, $2, $3, 'purchase')`,
        [clientId, id, order.cashback_amount]
      );
      await query(
        `UPDATE users SET cashback_balance = cashback_balance + $1 WHERE id = $2`,
        [order.cashback_amount, clientId]
      );
      cashbackCredited = order.cashback_amount;

      // Vérifier si 2FA doit être proposé
      const cashbackCount = await query(
        `SELECT COUNT(*) as cnt FROM cashback_transactions WHERE user_id = $1 AND type = 'purchase'`,
        [clientId]
      );
      const thresholdRes = await query(
        `SELECT value FROM platform_settings WHERE key = 'two_fa_trigger_cashback_count'`
      );
      const threshold = parseInt(thresholdRes.rows[0]?.value || '2');
      const shouldPropose2FA = parseInt(cashbackCount.rows[0].cnt) >= threshold;

      return res.json({
        success: true,
        cashback_credited: cashbackCredited,
        propose_2fa: shouldPropose2FA,
        message: `Livraison confirmée ! ${cashbackCredited > 0 ? cashbackCredited + ' FCFA de cashback crédités.' : ''}`,
      });
    }

    res.json({
      success: true,
      cashback_credited: 0,
      propose_2fa: false,
      message: 'Livraison confirmée !',
    });
  } catch (err) {
    console.error('[Orders] Erreur confirmation:', err.message);
    res.status(500).json({ error: 'Erreur confirmation livraison' });
  }
});

// ── TOUTES LES COMMANDES (Admin) ────────────────────────────
// GET /api/orders/admin/all
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
              us.full_name as supplier_name,
              d.status as delivery_status,
              CASE WHEN o.created_by_admin_id IS NULL THEN 'auto' ELSE 'manuel' END as origin
       FROM orders o
       JOIN product_variants pv ON pv.id = o.product_variant_id
       JOIN products p ON p.id = pv.product_id
       JOIN users uc ON uc.id = o.client_id
       JOIN users us ON us.id = o.supplier_id
       LEFT JOIN deliveries d ON d.order_id = o.id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({ orders: result.rows, page: parseInt(page) });
  } catch (err) {
    console.error('[Orders] Erreur admin liste:', err.message);
    res.status(500).json({ error: 'Erreur chargement commandes admin' });
  }
});

module.exports = router;
