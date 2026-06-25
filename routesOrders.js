// ============================================================
// PLAY16 — Routes Commandes (version sécurisée)
// Prix lu depuis DB, idempotence, cashback avec délai
// ============================================================
const express = require('express');
const router  = express.Router();
const { query }   = require('./pool');
const { authClient, authAdmin } = require('./authMiddleware');
const { charge }  = require('./PaymentService');
const { sendWhatsApp } = require('./NotificationService');
const { v4: uuidv4 } = require('uuid');
const {
  getProductPrice, checkIdempotency, saveIdempotencyResult,
  isFeatureEnabledFn, createFraudAlert, getSetting,
} = require('./securityMiddleware');
const { isFeatureEnabled } = require('./routesFeatures');

// ── CRÉER UNE COMMANDE (prix lu depuis DB) ───────────────────
router.post('/', authClient, async (req, res) => {
  try {
    const { product_variant_id, payment_method } = req.body;
    const clientId = req.user.id;

    // Clé d'idempotence (évite double commande)
    const idempotencyKey = `order-${clientId}-${product_variant_id}-${Date.now().toString().slice(0,-3)}`;
    const cached = await checkIdempotency(idempotencyKey);
    if (cached.duplicate) return res.status(cached.status).json(cached.result);

    // Prix LU DEPUIS LA DB — jamais depuis le body
    const product = await getProductPrice(product_variant_id);
    if (product.stock < 1) return res.status(400).json({ error: 'Stock épuisé' });

    const orderRes = await query(
      `INSERT INTO orders (client_id,supplier_id,product_variant_id,total_amount,status,payment_method)
       VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *`,
      [clientId, product.supplier_id, product_variant_id, product.price, payment_method]
    );
    const order = orderRes.rows[0];

    await query(`UPDATE product_variants SET stock=stock-1 WHERE id=$1`, [product_variant_id]);

    if (payment_method === 'mobile_money') {
      const clientRes = await query(`SELECT phone_number FROM users WHERE id=$1`, [clientId]);
      const payResult = await charge({
        phoneNumber: clientRes.rows[0].phone_number,
        amount: product.price,
        description: `Commande Play16 — ${product.name}`,
        internalReference: order.id,
      });

      if (payResult.success || payResult.simulated) {
        await query(`UPDATE orders SET status='paid' WHERE id=$1`, [order.id]);
        if (product.supplier_whatsapp) {
          await sendWhatsApp(product.supplier_whatsapp,
            `[Message généré sur la base des informations fournies par l'acheteur]\n🛍️ Nouvelle commande !\nProduit : ${product.name}\nMontant : ${product.price.toLocaleString()} FCFA (séquestré)`);
        }
      } else {
        await query(`UPDATE product_variants SET stock=stock+1 WHERE id=$1`, [product_variant_id]);
        await query(`UPDATE orders SET status='cancelled' WHERE id=$1`, [order.id]);
        const result = { error: 'Paiement échoué' };
        await saveIdempotencyResult(idempotencyKey, result, 402);
        return res.status(402).json(result);
      }
    }

    const result = { success:true, order:{ id:order.id, status:'paid', total_amount:product.price, product_name:product.name } };
    await saveIdempotencyResult(idempotencyKey, result, 200);
    res.json(result);
  } catch (err) {
    console.error('[Orders]', err.message);
    res.status(500).json({ error: 'Erreur création commande' });
  }
});

// ── MES COMMANDES ────────────────────────────────────────────
router.get('/my', authClient, async (req, res) => {
  try {
    const { status } = req.query;
    let where='WHERE o.client_id=$1'; const params=[req.user.id];
    if (status) { params.push(status); where+=` AND o.status=$${params.length}`; }
    const r = await query(
      `SELECT o.id,o.status,o.total_amount,o.payment_method,o.created_at,
              p.name as product_name,p.image_urls,pv.color,pv.size,
              u.full_name as supplier_name,d.status as delivery_status,
              ct.amount as cashback_earned
       FROM orders o
       JOIN product_variants pv ON pv.id=o.product_variant_id
       JOIN products p ON p.id=pv.product_id
       JOIN users u ON u.id=o.supplier_id
       LEFT JOIN deliveries d ON d.order_id=o.id
       LEFT JOIN cashback_transactions ct ON ct.order_id=o.id
       ${where} ORDER BY o.created_at DESC`, params
    );
    const showReturn = await query(`SELECT value FROM platform_settings WHERE key='show_return_policy_notice_to_client'`);
    res.json({
      orders: r.rows,
      return_policy: showReturn.rows[0]?.value!=='false' ? {
        show:true,
        cases:['Produit livré → échange possible (frais à votre charge)',
               'Non encore livré → remboursement intégral',
               'Refus à la livraison → 2 000 FCFA déduits',
               'Retour après livraison → remboursement en 32 à 62 jours']
      } : { show:false },
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur commandes' });
  }
});

// ── CONFIRMER RÉCEPTION (avec délai cashback sécurisé) ───────
router.post('/:id/confirm-receipt', authClient, async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = req.user.id;

    const orderRes = await query(
      `SELECT o.*,p.cashback_amount,u.supplier_verified,d.completed_at
       FROM orders o
       JOIN product_variants pv ON pv.id=o.product_variant_id
       JOIN products p ON p.id=pv.product_id
       JOIN users u ON u.id=o.supplier_id
       LEFT JOIN deliveries d ON d.order_id=o.id
       WHERE o.id=$1 AND o.client_id=$2`, [id, clientId]
    );
    if (!orderRes.rows[0]) return res.status(404).json({ error: 'Commande introuvable' });
    const order = orderRes.rows[0];

    await query(`UPDATE orders SET status='delivered' WHERE id=$1`, [id]);
    await query(`UPDATE deliveries SET status='delivered',completed_at=now() WHERE order_id=$1`, [id]);

    // Cashback avec vérification délai minimum
    const cashbackEnabled = await isFeatureEnabled('cashback_system');
    let cashbackCredited = 0, propose2FA = false;

    if (cashbackEnabled && order.supplier_verified && order.cashback_amount > 0) {
      const minDelayMin = parseInt(await getSetting('cashback_min_delay_after_delivery_min', '30'));
      const deliveredAt = order.completed_at ? new Date(order.completed_at) : new Date();
      const minsSinceDelivery = (Date.now() - deliveredAt.getTime()) / 60000;

      if (minsSinceDelivery < minDelayMin) {
        // Cashback sera crédité automatiquement après le délai
        // Pour l'instant on confirme juste la réception
      } else {
        await query(`INSERT INTO cashback_transactions (user_id,order_id,amount,type) VALUES ($1,$2,$3,'purchase')`,
          [clientId, id, order.cashback_amount]);
        await query(`UPDATE users SET cashback_balance=cashback_balance+$1 WHERE id=$2`, [order.cashback_amount, clientId]);
        cashbackCredited = order.cashback_amount;

        const cnt = await query(`SELECT COUNT(*) as c FROM cashback_transactions WHERE user_id=$1 AND type='purchase'`, [clientId]);
        const threshold = parseInt(await getSetting('two_fa_trigger_cashback_count', '2') || await query(`SELECT value FROM platform_settings WHERE key='two_fa_trigger_cashback_count'`).then(r=>r.rows[0]?.value||'2'));
        propose2FA = parseInt(cnt.rows[0].c) >= threshold;
      }
    }

    res.json({ success:true, cashback_credited:cashbackCredited, propose_2fa:propose2FA });
  } catch (err) {
    console.error('[Orders] confirm:', err.message);
    res.status(500).json({ error: 'Erreur confirmation' });
  }
});

// ── TOUTES LES COMMANDES ADMIN ───────────────────────────────
router.get('/admin/all', authAdmin, async (req, res) => {
  try {
    const { status, page=1 } = req.query;
    const limit=30, offset=(page-1)*limit;
    let where='WHERE 1=1'; const params=[];
    if (status) { params.push(status); where+=` AND o.status=$${params.length}`; }
    const r = await query(
      `SELECT o.*,p.name as product_name,
              uc.full_name as client_name,uc.phone_number as client_phone,
              us.full_name as supplier_name,d.status as delivery_status,
              CASE WHEN o.created_by_admin_id IS NULL THEN 'auto' ELSE 'manuel' END as origin
       FROM orders o
       JOIN product_variants pv ON pv.id=o.product_variant_id
       JOIN products p ON p.id=pv.product_id
       JOIN users uc ON uc.id=o.client_id
       JOIN users us ON us.id=o.supplier_id
       LEFT JOIN deliveries d ON d.order_id=o.id
       ${where} ORDER BY o.created_at DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params,limit,offset]
    );
    res.json({ orders:r.rows, page:parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur commandes admin' });
  }
});

module.exports = router;
