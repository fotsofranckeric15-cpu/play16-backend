// ============================================================
// PLAY16 — Routes Rapports Automatiques
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('./pool');
const { authAdmin, authSuperAdmin } = require('./authMiddleware');
const { sendWhatsApp } = require('./NotificationService');

// ── GÉNÉRER ET ENVOYER LE RAPPORT QUOTIDIEN ─────────────────
// POST /api/reports/daily (appelé par un cron chaque soir)
router.post('/daily', authSuperAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const reports = [];

    // Rapport Admin Ventes
    const salesData = await query(
      `SELECT
         COUNT(o.id) as orders_today,
         COALESCE(SUM(o.total_amount), 0) as revenue_today,
         COUNT(CASE WHEN o.status = 'delivered' THEN 1 END) as delivered,
         COUNT(CASE WHEN o.status = 'cancelled' THEN 1 END) as cancelled,
         COUNT(d.id) as deliveries_created
       FROM orders o
       LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.created_at::date = $1`,
      [today]
    );

    const salesReport = {
      role: 'admin_ventes',
      date: today,
      data: salesData.rows[0],
      message: formatReport('Admin Ventes', today, salesData.rows[0]),
    };
    reports.push(salesReport);

    // Rapport Admin Cash-Work
    const cwData = await query(
      `SELECT
         COUNT(cm.id) as missions_today,
         COUNT(CASE WHEN cm.status = 'validated' THEN 1 END) as validated,
         COALESCE(SUM(CASE WHEN cm.status = 'validated' THEN cm.invoice_amount END), 0) as revenue,
         COUNT(CASE WHEN cm.status = 'escrowed' THEN 1 END) as in_progress
       FROM cash_work_missions cm
       WHERE cm.created_at::date = $1`,
      [today]
    );

    const cwReport = {
      role: 'admin_cashwork',
      date: today,
      data: cwData.rows[0],
      message: formatReport('Admin Cash-Work', today, cwData.rows[0]),
    };
    reports.push(cwReport);

    // Rapport Admin Externe
    const extData = await query(
      `SELECT
         COUNT(ep.id) as transactions_today,
         COALESCE(SUM(ep.amount), 0) as total_amount,
         COUNT(CASE WHEN ep.status = 'completed' THEN 1 END) as completed,
         COUNT(CASE WHEN ep.status = 'refunded' THEN 1 END) as refunded,
         COUNT(CASE WHEN ep.status = 'escrowed' THEN 1 END) as pending
       FROM external_payments ep
       WHERE ep.created_at::date = $1`,
      [today]
    );

    const extReport = {
      role: 'admin_externe',
      date: today,
      data: extData.rows[0],
      message: formatReport('Admin Paiements Externes', today, extData.rows[0]),
    };
    reports.push(extReport);

    // Envoyer à chaque admin concerné
    const admins = await query(
      `SELECT whatsapp_number, phone_number, role, full_name
       FROM admin_accounts WHERE is_active = TRUE`
    );

    let sent = 0;
    for (const admin of admins.rows) {
      let reportMessage = null;

      if (admin.role === 'super_admin') {
        // Super Admin reçoit le rapport complet
        reportMessage =
          `📊 RAPPORT QUOTIDIEN PLAY16 — ${today}\n\n` +
          reports.map(r => r.message).join('\n\n') +
          `\n\nAccédez au tableau de bord pour plus de détails.`;
      } else if (admin.role === 'admin_ventes') {
        reportMessage = salesReport.message;
      } else if (admin.role === 'admin_cashwork') {
        reportMessage = cwReport.message;
      } else if (admin.role === 'admin_externe') {
        reportMessage = extReport.message;
      }

      if (reportMessage) {
        await sendWhatsApp(admin.whatsapp_number || admin.phone_number, reportMessage);
        sent++;
      }
    }

    res.json({ success: true, reports_sent: sent, reports });
  } catch (err) {
    console.error('[Reports] Erreur rapport quotidien:', err.message);
    res.status(500).json({ error: 'Erreur génération rapports' });
  }
});

// ── RAPPORT D'UN SOUS-ADMIN SPÉCIFIQUE ─────────────────────
// GET /api/reports/admin/:role
router.get('/admin/:role', authAdmin, async (req, res) => {
  try {
    const { role } = req.params;
    const { date } = req.query;
    const reportDate = date || new Date().toISOString().split('T')[0];

    let data = {};

    if (role === 'admin_ventes') {
      const result = await query(
        `SELECT COUNT(o.id) as orders, COALESCE(SUM(o.total_amount), 0) as revenue,
                COUNT(CASE WHEN o.status = 'delivered' THEN 1 END) as delivered
         FROM orders o WHERE o.created_at::date = $1`,
        [reportDate]
      );
      data = result.rows[0];
    } else if (role === 'admin_cashwork') {
      const result = await query(
        `SELECT COUNT(*) as missions,
                COUNT(CASE WHEN status = 'validated' THEN 1 END) as validated,
                COALESCE(SUM(CASE WHEN status = 'validated' THEN invoice_amount END), 0) as revenue
         FROM cash_work_missions WHERE created_at::date = $1`,
        [reportDate]
      );
      data = result.rows[0];
    } else if (role === 'admin_externe') {
      const result = await query(
        `SELECT COUNT(*) as transactions, COALESCE(SUM(amount), 0) as total,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed
         FROM external_payments WHERE created_at::date = $1`,
        [reportDate]
      );
      data = result.rows[0];
    }

    res.json({ role, date: reportDate, data });
  } catch (err) {
    res.status(500).json({ error: 'Erreur rapport admin' });
  }
});

// ── HELPER : formatage message rapport ──────────────────────
function formatReport(adminName, date, data) {
  const lines = [`📊 Rapport ${adminName} — ${date}`];

  Object.entries(data).forEach(([key, val]) => {
    const label = key.replace(/_/g, ' ');
    const value = typeof val === 'number' && val > 1000
      ? `${val.toLocaleString('fr-FR')} FCFA`
      : val;
    lines.push(`• ${label} : ${value}`);
  });

  return lines.join('\n');
}

module.exports = router;
