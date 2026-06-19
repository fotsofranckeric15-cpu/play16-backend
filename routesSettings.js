// ============================================================
// PLAY16 — Routes Paramètres Plateforme
// ============================================================
const express = require('express');
const router = express.Router();
const { query } = require('./pool');
const { authSuperAdmin } = require('./authMiddleware');

// Valeurs par défaut au premier démarrage
const DEFAULT_SETTINGS = [
  { key: 'cashback_withdrawal_threshold', value: '7500', description: 'Seuil de retrait cashback (FCFA)' },
  { key: 'cashback_per_purchase', value: '1000', description: 'Cashback par achat éligible (FCFA)' },
  { key: 'referral_signup_bonus', value: '500', description: 'Bonus parrainage inscription (FCFA)' },
  { key: 'referral_first_purchase_bonus', value: '1000', description: 'Bonus parrainage 1er achat (FCFA)' },
  { key: 'cashwork_commission_rate', value: '1.00', description: 'Commission Cash-Work (%)' },
  { key: 'external_payment_no_response_hours', value: '24', description: 'Délai avant remboursement auto externe (heures)' },
  { key: 'delivery_refusal_fee', value: '2000', description: 'Frais si refus à la livraison (FCFA)' },
  { key: 'return_refund_min_days', value: '32', description: 'Délai min remboursement retour (jours)' },
  { key: 'return_refund_max_days', value: '62', description: 'Délai max remboursement retour (jours)' },
  { key: 'payment_retry_attempts', value: '1', description: 'Tentatives paiement avant signalement (1-3)' },
  { key: 'password_change_delay_days', value: '32', description: 'Délai activation nouveau mdp Super Admin (jours, min 3)' },
  { key: 'supplier_verification_fee', value: '0', description: 'Frais de vérification fournisseur (FCFA)' },
  { key: 'show_refund_delay_notice_to_client', value: 'true', description: 'Afficher notice délai remboursement au client' },
  { key: 'show_return_policy_notice_to_client', value: 'true', description: 'Afficher politique de retour au client' },
  { key: 'cashwork_post_reminder_hours', value: '24', description: 'Délai relance annonce Cash-Work sans preneur (heures)' },
  { key: 'daily_transaction_limit', value: '5000000', description: 'Limite transaction journalière (FCFA)' },
  { key: 'two_fa_trigger_cashback_count', value: '2', description: 'Nombre de cashbacks avant proposition 2FA' },
];

async function seedDefaultSettings() {
  for (const s of DEFAULT_SETTINGS) {
    await query(
      `INSERT INTO platform_settings (key, value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [s.key, s.value, s.description]
    );
  }
}

// ── LIRE TOUS LES PARAMÈTRES (Super Admin) ─────────────────
// GET /api/settings
router.get('/', authSuperAdmin, async (req, res) => {
  try {
    await seedDefaultSettings();
    const result = await query(
      `SELECT key, value, description, updated_at FROM platform_settings ORDER BY key`
    );
    res.json({ settings: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture paramètres' });
  }
});

// ── MODIFIER UN PARAMÈTRE (Super Admin) ─────────────────────
// PUT /api/settings/:key
// Body: { value: "..." }
router.put('/:key', authSuperAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    // Validation spéciale pour certains paramètres critiques
    if (key === 'payment_retry_attempts') {
      const v = parseInt(value);
      if (v < 1 || v > 3) return res.status(400).json({ error: 'Valeur entre 1 et 3' });
    }
    if (key === 'password_change_delay_days') {
      const v = parseInt(value);
      if (v < 3) return res.status(400).json({ error: 'Délai minimum 3 jours' });
    }

    await query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE
       SET value = $2, updated_by = $3, updated_at = now()`,
      [key, value, req.admin.id]
    );

    res.json({ success: true, key, value });
  } catch (err) {
    res.status(500).json({ error: 'Erreur modification paramètre' });
  }
});

// ── LIRE UN PARAMÈTRE SPÉCIFIQUE (usage interne + clients) ──
// GET /api/settings/public/:key
// Seulement les paramètres autorisés à être lus par l'app cliente
const PUBLIC_SETTINGS = [
  'cashback_withdrawal_threshold',
  'cashback_per_purchase',
  'show_refund_delay_notice_to_client',
  'show_return_policy_notice_to_client',
  'supplier_verification_fee',
  'delivery_refusal_fee',
];

router.get('/public/:key', async (req, res) => {
  try {
    const { key } = req.params;
    if (!PUBLIC_SETTINGS.includes(key)) {
      return res.status(403).json({ error: 'Paramètre non public' });
    }
    const result = await query(
      `SELECT value FROM platform_settings WHERE key = $1`,
      [key]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Paramètre introuvable' });
    res.json({ key, value: result.rows[0].value });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lecture paramètre' });
  }
});

module.exports = { router, seedDefaultSettings };
