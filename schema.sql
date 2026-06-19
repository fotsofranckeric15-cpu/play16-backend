-- ============================================================
-- PLAY16 — SCHÉMA DE BASE DE DONNÉES (PostgreSQL)
-- Étape 1 : Fondations — version de travail pour validation
-- ============================================================

-- ─────────────────────────────────────────────
-- UTILISATEURS & RÔLES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    whatsapp_number VARCHAR(20),
    full_name VARCHAR(150),
    password_hash TEXT,                  -- NULL pour clients (OTP only)
    is_client BOOLEAN DEFAULT TRUE,
    is_supplier BOOLEAN DEFAULT FALSE,
    is_cash_worker BOOLEAN DEFAULT FALSE,
    supplier_verified BOOLEAN DEFAULT FALSE,
    identity_verification_status VARCHAR(20) DEFAULT 'none', -- none|pending|verified|re_requested
    two_fa_enabled BOOLEAN DEFAULT FALSE,
    cashback_balance INTEGER DEFAULT 0,   -- en FCFA
    trust_score INTEGER DEFAULT 100,      -- score anti-fraude
    cgu_accepted_version INTEGER DEFAULT 0,
    cgu_accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    deleted_at TIMESTAMPTZ                -- soft delete (droit à l'oubli)
);

CREATE TABLE IF NOT EXISTS admin_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(30) NOT NULL,            -- super_admin|admin_ventes|admin_cashwork|admin_externe
    whatsapp_number VARCHAR(20) NOT NULL, -- numéro perso pour 2FA/OTP
    password_hash TEXT NOT NULL,
    must_change_password BOOLEAN DEFAULT TRUE,
    extended_access BOOLEAN DEFAULT FALSE, -- accès étendu accordé par Super Admin
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Changement de mot de passe Super Admin (délai 32j configurable)
CREATE TABLE IF NOT EXISTS password_change_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES admin_accounts(id),
    new_password_hash TEXT NOT NULL,
    requested_at TIMESTAMPTZ DEFAULT now(),
    activates_at TIMESTAMPTZ NOT NULL,     -- requested_at + délai configuré
    delay_days INTEGER DEFAULT 32,
    status VARCHAR(20) DEFAULT 'pending',  -- pending|activated|cancelled
    requires_super_admin_validation BOOLEAN DEFAULT FALSE,
    validated_by UUID REFERENCES admin_accounts(id),
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Sessions admin (traçabilité par personne, pas juste par poste)
CREATE TABLE IF NOT EXISTS admin_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES admin_accounts(id),
    whatsapp_number_used VARCHAR(20) NOT NULL,
    started_at TIMESTAMPTZ DEFAULT now(),
    ended_at TIMESTAMPTZ,
    ip_address VARCHAR(45)
);

CREATE TABLE IF NOT EXISTS admin_session_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES admin_sessions(id),
    action_type VARCHAR(50) NOT NULL,     -- create_delivery|block_account|resolve_dispute|...
    description TEXT,
    target_table VARCHAR(50),
    target_id UUID,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Mode Supervision (Super Admin consulte l'écran d'un sous-admin)
CREATE TABLE IF NOT EXISTS supervision_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    super_admin_id UUID REFERENCES admin_accounts(id),
    viewed_admin_id UUID REFERENCES admin_accounts(id),
    started_at TIMESTAMPTZ DEFAULT now(),
    ended_at TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- CGU DYNAMIQUES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cgu_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_number INTEGER NOT NULL,
    content TEXT NOT NULL,                -- vide tant que Super Admin n'a pas édité
    module VARCHAR(30),                   -- marketplace|cashwork|external_payment|global
    published_at TIMESTAMPTZ DEFAULT now(),
    published_by UUID REFERENCES admin_accounts(id)
);

-- ─────────────────────────────────────────────
-- MARKETPLACE — PRODUITS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID REFERENCES users(id),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    base_price INTEGER NOT NULL,          -- FCFA
    discounted_price INTEGER,
    cashback_amount INTEGER DEFAULT 0,    -- 0 si fournisseur non vérifié
    is_active BOOLEAN DEFAULT TRUE,
    boost_level_requested INTEGER DEFAULT 0,   -- 0 à 10, proposé par fournisseur
    boost_level_active INTEGER DEFAULT 0,      -- 0 à 10, validé par Super Admin
    boost_status VARCHAR(20) DEFAULT 'none',   -- none|pending_validation|approved|rejected
    image_urls TEXT[],                    -- plusieurs résolutions générées (CDN)
    click_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES products(id),
    color VARCHAR(50),
    size VARCHAR(20),
    stock INTEGER DEFAULT 0
);

-- Historique des clics produit (analytics + anti-fraude)
CREATE TABLE IF NOT EXISTS product_clicks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES products(id),
    user_id UUID REFERENCES users(id),    -- NULL si visiteur non connecté
    ip_address VARCHAR(45),
    clicked_at TIMESTAMPTZ DEFAULT now()
);

-- Validation des demandes de boost par Super Admin
CREATE TABLE IF NOT EXISTS boost_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES products(id),
    requested_level INTEGER NOT NULL,
    requested_at TIMESTAMPTZ DEFAULT now(),
    status VARCHAR(20) DEFAULT 'pending', -- pending|approved|rejected
    reviewed_by UUID REFERENCES admin_accounts(id),
    reviewed_at TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- COMMANDES & LIVRAISONS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES users(id),
    supplier_id UUID REFERENCES users(id),
    product_variant_id UUID REFERENCES product_variants(id),
    total_amount INTEGER NOT NULL,
    status VARCHAR(30) DEFAULT 'pending', -- pending|paid|in_transit|delivered|cancelled|returned
    payment_method VARCHAR(20),           -- mobile_money|cash
    created_by_admin_id UUID REFERENCES admin_accounts(id), -- NULL si auto
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id),
    delivery_person_id UUID REFERENCES users(id),
    status VARCHAR(30) DEFAULT 'awaiting_pickup',
    location_sharing_client_enabled BOOLEAN DEFAULT FALSE, -- choix du livreur, client only
    created_by_admin_id UUID REFERENCES admin_accounts(id), -- NULL si auto (déclenché système)
    completed_at TIMESTAMPTZ
);

-- Position GPS du livreur — TOUJOURS visible admin/super admin
CREATE TABLE IF NOT EXISTS delivery_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id UUID REFERENCES deliveries(id),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    recorded_at TIMESTAMPTZ DEFAULT now()
    -- Pas de champ "visible_to_client" ici : la visibilité client
    -- est gérée par location_sharing_client_enabled sur deliveries.
    -- L'admin/super admin lit toujours cette table, sans filtre.
);

-- ─────────────────────────────────────────────
-- CASHBACK & PARRAINAGE
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cashback_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    order_id UUID REFERENCES orders(id),
    amount INTEGER NOT NULL,
    type VARCHAR(20) DEFAULT 'purchase',  -- purchase|referral_signup|referral_first_purchase|qr_reward
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID REFERENCES users(id),
    referred_id UUID REFERENCES users(id),
    signup_bonus_paid BOOLEAN DEFAULT FALSE,
    first_purchase_bonus_paid BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────
-- QR CODE — LOTS DE RÉCOMPENSES (sécurité tirage)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qr_lots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by_super_admin_id UUID REFERENCES admin_accounts(id) NOT NULL,
    target_buyer_count INTEGER NOT NULL,
    crypto_seed VARCHAR(128) NOT NULL,    -- seed cryptographique, généré serveur
    status VARCHAR(20) DEFAULT 'active',  -- active|completed
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS qr_lot_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    qr_lot_id UUID REFERENCES qr_lots(id),
    reward_type VARCHAR(50),              -- cash|item|credit
    reward_value VARCHAR(100),
    winner_count INTEGER NOT NULL
);

-- Tirage : assignation immuable une fois faite (audit trail)
CREATE TABLE IF NOT EXISTS qr_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    qr_lot_id UUID REFERENCES qr_lots(id),
    order_id UUID REFERENCES orders(id),  -- la commande qui a déclenché ce QR
    reward_id UUID REFERENCES qr_lot_rewards(id), -- NULL si pas gagnant
    is_winner BOOLEAN DEFAULT FALSE,
    activated_by_client BOOLEAN DEFAULT FALSE,
    scanned_at TIMESTAMPTZ,
    drawn_at TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────
-- CASH-WORK
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_work_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    posted_by_user_id UUID REFERENCES users(id), -- client, fournisseur, cash-worker, admin tous possibles
    description TEXT NOT NULL,
    category VARCHAR(50),                 -- auto-détectée
    location_lat DOUBLE PRECISION,
    location_lng DOUBLE PRECISION,
    status VARCHAR(20) DEFAULT 'open',    -- open|matched|expired_reminder_sent|cancelled
    last_reminder_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_work_missions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID REFERENCES cash_work_posts(id),
    client_id UUID REFERENCES users(id),
    worker_id UUID REFERENCES users(id),
    invoice_amount INTEGER,
    commission_rate NUMERIC(5,2) DEFAULT 1.00,
    status VARCHAR(30) DEFAULT 'pending_invoice', -- pending_invoice|escrowed|in_progress|submitted|validated|disputed
    escrowed_at TIMESTAMPTZ,
    validated_at TIMESTAMPTZ,
    location_tracking_active BOOLEAN DEFAULT FALSE, -- actif seulement pendant la mission
    off_platform_payment_flagged BOOLEAN DEFAULT FALSE, -- fraude déclarée
    off_platform_payment_flagged_by VARCHAR(20),        -- 'client' ou 'worker'
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_work_proof_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mission_id UUID REFERENCES cash_work_missions(id),
    media_type VARCHAR(20),               -- photo|video
    url TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────
-- PAIEMENT EXTERNE (hors plateforme, séquestre)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS external_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id UUID REFERENCES users(id),
    seller_whatsapp_number VARCHAR(20) NOT NULL,
    amount INTEGER NOT NULL,
    description_text TEXT,
    description_voice_url TEXT,           -- note vocale, stockée telle quelle
    expected_delivery_date DATE,
    travel_agency_estimate VARCHAR(150),
    requested_proofs TEXT,
    status VARCHAR(30) DEFAULT 'escrowed', -- escrowed|accepted|preparing|shipped|delivered|accepted_by_buyer|rejected_returning|completed|refunded
    seller_accepted_at TIMESTAMPTZ,
    buyer_expected_date DATE,
    seller_expected_date DATE,
    no_action_deadline TIMESTAMPTZ,        -- calculé après les 2 dates + 24h
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS external_payment_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_payment_id UUID REFERENCES external_payments(id),
    media_type VARCHAR(30),  -- packing_video|shipping_proof|reception_video|return_shipping_proof
    url TEXT,
    was_ignored BOOLEAN DEFAULT FALSE,    -- vendeur/acheteur a ignoré l'étape vidéo
    recorded_without_interruption BOOLEAN DEFAULT TRUE, -- pas de pause/téléchargement détecté
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ─────────────────────────────────────────────
-- LITIGES (tous modules)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module VARCHAR(20) NOT NULL,          -- sales|cashwork|external
    related_id UUID NOT NULL,             -- order_id / mission_id / external_payment_id
    handled_by_admin_id UUID REFERENCES admin_accounts(id),
    pv_content TEXT,
    resolution_type VARCHAR(30),          -- arrangement|non_conciliation|escalated
    escalated_to_super_admin BOOLEAN DEFAULT FALSE,
    attestation_pdf_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

-- ─────────────────────────────────────────────
-- BLOCAGE DE COMPTE (traçabilité permanente)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    blocked_by_admin_id UUID REFERENCES admin_accounts(id) NOT NULL,
    reason TEXT NOT NULL,
    resolution_attempts TEXT NOT NULL,
    blocked_at TIMESTAMPTZ DEFAULT now(),
    unblocked_at TIMESTAMPTZ,
    unblocked_by_super_admin_id UUID REFERENCES admin_accounts(id)
);

-- ─────────────────────────────────────────────
-- INTÉGRATIONS — "TIROIR SIM"
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_name VARCHAR(50) UNIQUE NOT NULL, -- campay|cinetpay|whatsapp_business|twilio|
                                                 -- firebase_push|sendgrid|google_maps|
                                                 -- storage_cdn|escrow_custom|deep_linking
    is_active BOOLEAN DEFAULT FALSE,
    config_json JSONB DEFAULT '{}',
    schema_version INTEGER DEFAULT 1,
    last_tested_at TIMESTAMPTZ,
    last_test_status VARCHAR(20) DEFAULT 'never'
);

-- ─────────────────────────────────────────────
-- PARAMÈTRES GLOBAUX CONFIGURABLES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_by UUID REFERENCES admin_accounts(id),
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- Exemples de lignes attendues (seed) :
-- cashback_withdrawal_threshold = 7500
-- cashback_per_purchase = 1000
-- referral_signup_bonus = 500
-- referral_first_purchase_bonus = 1000
-- cashwork_commission_rate = 1.00
-- external_payment_no_response_hours = 24
-- delivery_refusal_fee = 2000
-- return_refund_min_days = 32
-- return_refund_max_days = 62
-- payment_retry_attempts = 1
-- password_change_delay_days = 32
-- supplier_verification_fee = 0
-- show_refund_delay_notice_to_client = true   <- nouveau toggle demandé
-- show_return_policy_notice_to_client = true  <- nouveau toggle demandé
