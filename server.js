// ============================================================
// PLAY16 — Serveur v4.1 + Interface Admin intégrée
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');
const rateLimit = require('express-rate-limit');
const { ensureCatalogSeeded }  = require('./integrationRegistry');
const { seedDefaultSettings }  = require('./routesSettings');
const { seedFeatureFlags, requireFeature } = require('./routesFeatures');
const { query } = require('./pool');

const app = express();

// CORS — accepte tout (fichier local + app mobile + web)
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50mb' }));
app.use(rateLimit({ windowMs:15*60*1000, max:300, standardHeaders:true }));

// ── INTERFACE ADMIN (servie directement par Railway) ─────────
app.get('/admin', (req, res) => {
  res.send(getAdminHTML());
});

// ── HEALTH ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status:'ok', service:'play16-backend', version:'4.1', time:new Date().toISOString() });
});

// ── ROUTES API ───────────────────────────────────────────────
app.use('/api/auth',             require('./routesAuth'));
app.use('/api/features',         require('./routesFeatures').router);
app.use('/api/products',         require('./routesProducts'));
app.use('/api/settings',         require('./routesSettings').router);
app.use('/api/orders',           require('./routesOrders'));
app.use('/api/deliveries',       require('./routesDeliveries'));
app.use('/api/cashwork',         requireFeature('cash_work_system'), require('./routesCashWork'));
app.use('/api/external-payments',requireFeature('external_payment_escrow'), require('./routesExternalPayments'));
app.use('/api/superadmin',       require('./routesSuperAdmin'));
app.use('/api/disputes',         require('./routesDisputes'));
app.use('/api/reports',          require('./routesReports'));
app.use('/api/security',         require('./routesSecurity'));

// ── ERREURS ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Erreur interne.' });
});

const PORT = process.env.PORT || 3000;

async function seedSecurityDefaults() {
  const defaults = [
    ['otp_max_attempts','5'],['otp_block_duration_min','30'],['otp_per_hour_limit','3'],
    ['jwt_expiry_days','30'],['gps_max_speed_kmh','200'],['gps_update_interval_sec','5'],
    ['gps_cameroon_bbox_strict','true'],['video_min_duration_sec','30'],['video_max_size_mb','500'],
    ['cashback_min_delay_after_delivery_min','30'],['cashwork_invoice_max_fcfa','500000'],
    ['payment_token_expiry_hours','48'],['alert_on_foreign_ip','true'],
    ['payment_idempotency_ttl_min','10'],['escrow_timeout_alert_hours','48'],
  ];
  for (const [k,v] of defaults) {
    await query(`INSERT INTO security_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`,[k,v]).catch(()=>{});
  }
}

async function start() {
  try {
    await ensureCatalogSeeded();
    await seedDefaultSettings();
    await seedFeatureFlags();
    await seedSecurityDefaults();
    console.log('[Boot] Play16 v4.1 — tous modules initialisés.');
  } catch (err) {
    console.error('[Boot] Erreur init:', err.message);
  }
  app.listen(PORT, () => console.log(`[Boot] Play16 démarré sur le port ${PORT}`));
}

start();
module.exports = app;

// ── HTML INTERFACE ADMIN ─────────────────────────────────────
function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Play16 Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
:root{--p:#7C3AED;--pl:#F5F0FF;--pb:#DDD6FE;--g:#16A34A;--gl:#F0FDF4;--gold:#D97706;--goldl:#FFFBEB;--b:#2563EB;--bl:#EFF6FF;--r:#DC2626;--rl:#FEF2F2;--t:#0D0D14;--ts:#6B7280;--tl:#9CA3AF;--bd:#E4E6EA;--bg:#F5F6F8;--w:#fff;--sw:240px}
body{background:var(--bg);color:var(--t)}
#auth{display:flex;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#7C3AED,#5B21B6);padding:20px}
.ac{background:#fff;border-radius:20px;padding:32px;width:100%;max-width:400px;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.al{display:flex;align-items:center;gap:10px;margin-bottom:22px}
.ali{width:40px;height:40px;border-radius:11px;background:var(--p);display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;font-weight:900}
.alt{font-size:17px;font-weight:800}.alt span{color:var(--p)}
h2{font-size:17px;font-weight:800;margin-bottom:5px}
.sub{font-size:12px;color:var(--ts);margin-bottom:18px;line-height:1.5}
.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;display:block}
.inp{width:100%;padding:12px 13px;border:1.5px solid var(--bd);border-radius:10px;font-size:14px;color:var(--t);background:var(--bg);margin-bottom:13px;display:block}
.inp:focus{outline:none;border-color:var(--p);background:#fff}
.inpbig{font-size:24px;font-weight:800;letter-spacing:8px;text-align:center}
.btn{width:100%;padding:13px;background:var(--p);color:#fff;border:none;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer}
.btn:hover{background:#6D28D9}
.btn:disabled{opacity:.6;cursor:not-allowed}
.err{background:var(--rl);color:var(--r);border:1px solid rgba(220,38,38,.3);border-radius:10px;padding:11px;font-size:13px;margin-top:11px;display:none}
.info{background:var(--pl);color:var(--p);border:1px solid var(--pb);border-radius:10px;padding:11px;font-size:12px;margin-bottom:14px;line-height:1.7}
.sim{background:var(--goldl);color:var(--gold);border:1px solid rgba(217,119,6,.3);border-radius:10px;padding:11px;font-size:12px;margin-bottom:13px;display:none;line-height:1.6}
.bk{color:var(--p);font-size:13px;font-weight:600;cursor:pointer;display:inline-block;margin-bottom:14px}
#s2{display:none}
#app{display:none;min-height:100vh}
.sb{position:fixed;top:0;left:0;width:var(--sw);height:100vh;background:#fff;border-right:1px solid var(--bd);overflow-y:auto;display:flex;flex-direction:column;z-index:100}
.mn{margin-left:var(--sw);padding:22px;min-height:100vh}
@media(max-width:768px){.sb{transform:translateX(-100%);transition:.3s}.sb.open{transform:translateX(0)}.mn{margin-left:0}}
.sbh{padding:16px 13px;border-bottom:1px solid var(--bd)}
.sblo{display:flex;align-items:center;gap:8px}
.sbli{width:30px;height:30px;border-radius:9px;background:var(--p);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:14px}
.sblt{font-size:14px;font-weight:800}.sblt span{color:var(--p)}
.ap{margin:10px 11px;background:var(--pl);border-radius:11px;padding:11px 13px}
.apn{font-size:13px;font-weight:700}.apr{font-size:11px;color:var(--ts);margin-top:2px}
.ns{padding:6px 11px;margin-top:5px}
.nst{font-size:10px;font-weight:800;color:var(--tl);letter-spacing:1px;padding:0 4px;margin-bottom:4px}
.ni{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:10px;cursor:pointer;font-size:13px;font-weight:500;color:var(--ts);margin-bottom:2px;transition:.15s}
.ni:hover{background:var(--bg);color:var(--t)}
.ni.on{background:var(--pl);color:var(--p);font-weight:700}
.ic{font-size:15px;width:18px;text-align:center}
.sbf{margin-top:auto;padding:11px;border-top:1px solid var(--bd)}
.lo{display:flex;align-items:center;gap:7px;padding:9px 11px;border-radius:10px;cursor:pointer;font-size:13px;color:var(--r);font-weight:600}
.lo:hover{background:var(--rl)}
.tb{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.tbt{font-size:20px;font-weight:800}
.mt{display:none;background:none;border:none;cursor:pointer;font-size:22px;margin-right:10px}
@media(max-width:768px){.mt{display:block}}
.sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:13px;margin-bottom:20px}
.sc{background:#fff;border-radius:13px;padding:16px;border:1px solid var(--bd)}
.si{font-size:20px;margin-bottom:7px}.sv{font-size:20px;font-weight:800}.sl{font-size:12px;color:var(--ts);margin-top:3px}.ss{font-size:11px;color:var(--tl);margin-top:2px}
.cd{background:#fff;border-radius:13px;padding:16px;border:1px solid var(--bd);margin-bottom:16px}
.cdh{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px}
.cdt{font-size:14px;font-weight:700}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:9px 11px;font-size:11px;font-weight:700;color:var(--ts);text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--bd)}
td{padding:10px 11px;border-bottom:1px solid var(--bd)}
tr:hover td{background:var(--bg)}
tr:last-child td{border-bottom:none}
.bdg{display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700}
.bg{background:var(--gl);color:var(--g)}.bb{background:var(--bl);color:var(--b)}.br{background:var(--rl);color:var(--r)}.bo{background:var(--goldl);color:var(--gold)}.bp{background:var(--pl);color:var(--p)}.bgr{background:var(--bg);color:var(--ts)}
.bt{padding:7px 13px;border-radius:9px;font-size:12px;font-weight:600;cursor:pointer;border:none;transition:.2s}
.bt:hover{opacity:.85}
.bts{padding:5px 10px;font-size:11px}
.btp{background:var(--p);color:#fff}.btg{background:var(--g);color:#fff}.btr{background:var(--r);color:#fff}.btb{background:var(--b);color:#fff}.bto{background:transparent;border:1.5px solid var(--bd);color:var(--t)}
.al2{padding:11px 13px;border-radius:10px;font-size:12px;margin-bottom:13px;line-height:1.6}
.alw{background:var(--goldl);color:var(--gold);border:1px solid rgba(217,119,6,.3)}
.als{background:var(--gl);color:var(--g);border:1px solid rgba(22,163,74,.3)}
.ale{background:var(--rl);color:var(--r);border:1px solid rgba(220,38,38,.3)}
.ali2{background:var(--pl);color:var(--p);border:1px solid var(--pb)}
.mov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center;padding:20px}
.mov.open{display:flex}
.mo{background:#fff;border-radius:18px;padding:24px;width:100%;max-width:460px;max-height:90vh;overflow-y:auto}
.mot{font-size:16px;font-weight:800;margin-bottom:13px}
.mof{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.fg{margin-bottom:13px}
.fl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;display:block}
.fi{width:100%;padding:10px 12px;border:1.5px solid var(--bd);border-radius:10px;font-size:13px;color:var(--t);background:var(--bg)}
.fsel{width:100%;padding:9px 12px;border:1.5px solid var(--bd);border-radius:10px;font-size:13px;color:var(--t);background:var(--bg)}
.fta{width:100%;padding:10px 12px;border:1.5px solid var(--bd);border-radius:10px;font-size:13px;color:var(--t);background:var(--bg);resize:vertical;min-height:80px}
.tr2{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--bd)}
.tr2:last-child{border-bottom:none}
.tgl{position:relative;width:40px;height:22px;flex-shrink:0}
.tgl input{opacity:0;width:0;height:0}
.tgls{position:absolute;inset:0;background:var(--bd);border-radius:22px;cursor:pointer;transition:.3s}
.tgls:before{content:'';position:absolute;width:16px;height:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.3s}
.tgl input:checked+.tgls{background:var(--p)}
.tgl input:checked+.tgls:before{transform:translateX(18px)}
.srow{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--bd)}
.srow:last-child{border-bottom:none}
.sinp{width:100px;padding:6px 9px;border:1.5px solid var(--bd);border-radius:8px;font-size:12px;text-align:center}
.pg{display:none}.pg.on{display:block}
.es{text-align:center;padding:32px 20px;color:var(--ts)}
.ei{font-size:32px;margin-bottom:7px}
.sbanner{background:var(--gold);color:#fff;padding:9px 18px;text-align:center;font-size:12px;font-weight:700;position:sticky;top:0;z-index:200;display:none}
</style>
</head>
<body>
<div class="sbanner" id="sbanner">⚠️ MODE PUBLICATION STORE ACTIF — Fonctionnalités financières désactivées</div>

<!-- AUTH -->
<div id="auth">
  <div class="ac">
    <div class="al">
      <div class="ali">P</div>
      <div class="alt">PLAY <span>16</span> Admin</div>
    </div>
    <div id="s1">
      <h2>Connexion</h2>
      <p class="sub">Super Admin : connexion directe sans code.<br>Sous-admins : mot de passe + code WhatsApp.</p>
      <div class="info">ℹ️ Super Admin<br>Numéro : <strong>237655750369</strong><br>Mot de passe : <strong>aaaaaaaa</strong></div>
      <label class="lbl">Numéro WhatsApp</label>
      <input class="inp" type="tel" id="ph" value="237655750369">
      <label class="lbl">Mot de passe</label>
      <input class="inp" type="password" id="pw" value="aaaaaaaa">
      <button class="btn" id="btnL" onclick="doLogin()">Se connecter</button>
      <div class="err" id="e1"></div>
    </div>
    <div id="s2">
      <span class="bk" onclick="goBack()">‹ Retour</span>
      <h2>Code de vérification</h2>
      <p class="sub">Code WhatsApp envoyé sur votre numéro.</p>
      <div class="sim" id="simbox">⚠️ Mode simulation — Le code OTP est visible dans les logs Railway Console.<br>Va sur Railway → ton service → Console → cherche la ligne <strong>[OTP SIM]</strong></div>
      <label class="lbl">Code à 6 chiffres</label>
      <input class="inp inpbig" type="number" id="otp" placeholder="000000" maxlength="6">
      <button class="btn" id="btnO" onclick="doVerify()">Confirmer</button>
      <div class="err" id="e2"></div>
    </div>
  </div>
</div>

<!-- APP -->
<div id="app">
  <div class="sb" id="sb">
    <div class="sbh"><div class="sblo"><div class="sbli">P</div><div class="sblt">PLAY <span>16</span></div></div></div>
    <div class="ap"><div class="apn" id="sbn">—</div><div class="apr" id="sbr">—</div></div>
    <div id="nsuper" style="display:none">
      <div class="ns"><div class="nst">GÉNÉRAL</div>
        <div class="ni on" onclick="go('dash',this)"><span class="ic">📊</span>Dashboard</div>
        <div class="ni" onclick="go('admins',this)"><span class="ic">👥</span>Sous-admins</div>
        <div class="ni" onclick="go('search',this)"><span class="ic">🔍</span>Recherche</div>
      </div>
      <div class="ns"><div class="nst">FINANCES</div>
        <div class="ni" onclick="go('qrlots',this)"><span class="ic">🎲</span>QR Codes & Lots</div>
        <div class="ni" onclick="go('reports',this)"><span class="ic">📈</span>Rapports</div>
      </div>
      <div class="ns"><div class="nst">SYSTÈMES</div>
        <div class="ni" onclick="go('integrations',this)"><span class="ic">🔌</span>Intégrations</div>
        <div class="ni" onclick="go('features',this)"><span class="ic">🎛️</span>Fonctionnalités</div>
        <div class="ni" onclick="go('settings',this)"><span class="ic">⚙️</span>Paramètres</div>
        <div class="ni" onclick="go('security',this)"><span class="ic">🔐</span>Sécurité</div>
        <div class="ni" onclick="go('sessions',this)"><span class="ic">📋</span>Sessions</div>
        <div class="ni" onclick="go('cgu',this)"><span class="ic">📜</span>CGU</div>
      </div>
    </div>
    <div id="nventes" style="display:none">
      <div class="ns"><div class="nst">VENTES</div>
        <div class="ni on" onclick="go('dash',this)"><span class="ic">📊</span>Dashboard</div>
        <div class="ni" onclick="go('orders',this)"><span class="ic">🛒</span>Commandes</div>
        <div class="ni" onclick="go('deliveries',this)"><span class="ic">🚚</span>Livraisons</div>
        <div class="ni" onclick="go('boosts',this)"><span class="ic">⚡</span>Boost</div>
      </div>
    </div>
    <div id="ncw" style="display:none">
      <div class="ns"><div class="nst">CASH-WORK</div>
        <div class="ni on" onclick="go('dash',this)"><span class="ic">📊</span>Dashboard</div>
        <div class="ni" onclick="go('missions',this)"><span class="ic">💼</span>Missions</div>
        <div class="ni" onclick="go('security',this)"><span class="ic">🚨</span>Anomalies</div>
      </div>
    </div>
    <div id="next" style="display:none">
      <div class="ns"><div class="nst">PAIEMENTS EXTERNES</div>
        <div class="ni on" onclick="go('dash',this)"><span class="ic">📊</span>Dashboard</div>
        <div class="ni" onclick="go('extpay',this)"><span class="ic">💳</span>Transactions</div>
      </div>
    </div>
    <div class="sbf"><div class="lo" onclick="logout()">🚪 Se déconnecter</div></div>
  </div>

  <div class="mn">
    <div class="tb">
      <div style="display:flex;align-items:center">
        <button class="mt" onclick="document.getElementById('sb').classList.toggle('open')">☰</button>
        <div class="tbt" id="pgtitle">Dashboard</div>
      </div>
      <span class="bdg bp" id="rolebdg"></span>
    </div>

    <div class="pg on" id="pg-dash">
      <div class="sg" id="sgrid"><div class="sc"><div class="si">⏳</div><div class="sv">—</div><div class="sl">Chargement...</div></div></div>
    </div>

    <div class="pg" id="pg-admins">
      <div class="cd">
        <div class="cdh"><span class="cdt">👥 Sous-administrateurs</span><button class="bt btp bts" onclick="openM('madmin')">+ Créer</button></div>
        <div class="tw"><table><thead><tr><th>Nom</th><th>Rôle</th><th>WhatsApp</th><th>Statut</th><th>Accès étendu</th><th>Actions</th></tr></thead><tbody id="tbadmins"><tr><td colspan="6" style="text-align:center;padding:20px;color:var(--ts)">Chargement...</td></tr></tbody></table></div>
      </div>
    </div>

    <div class="pg" id="pg-orders">
      <div class="cd">
        <div class="cdh"><span class="cdt">🛒 Commandes</span><button class="bt btp bts" onclick="openM('mdel')">+ Livraison manuelle</button></div>
        <div style="display:flex;gap:7px;margin-bottom:13px;flex-wrap:wrap">
          <button class="bt bto bts" onclick="loadOrders()">Toutes</button>
          <button class="bt bto bts" onclick="loadOrders('paid')">Payées</button>
          <button class="bt bto bts" onclick="loadOrders('in_transit')">En transit</button>
          <button class="bt bto bts" onclick="loadOrders('delivered')">Livrées</button>
        </div>
        <div class="tw"><table><thead><tr><th>ID</th><th>Client</th><th>Produit</th><th>Montant</th><th>Statut</th><th>Origine</th><th>Date</th></tr></thead><tbody id="tborders"><tr><td colspan="7" style="text-align:center;padding:20px;color:var(--ts)">Chargement...</td></tr></tbody></table></div>
      </div>
    </div>

    <div class="pg" id="pg-deliveries">
      <div class="cd">
        <div class="cdh"><span class="cdt">🚚 Livraisons (GPS admin toujours visible)</span></div>
        <div style="display:flex;gap:7px;margin-bottom:13px">
          <button class="bt bto bts" onclick="loadDeliveries()">Toutes</button>
          <button class="bt bto bts" onclick="loadDeliveries('auto')">Auto</button>
          <button class="bt bto bts" onclick="loadDeliveries('manuel')">Manuelles</button>
        </div>
        <div class="tw"><table><thead><tr><th>ID</th><th>Client</th><th>Livreur</th><th>Statut</th><th>Origine</th><th>GPS</th><th>Action</th></tr></thead><tbody id="tbdel"><tr><td colspan="7" style="text-align:center;padding:20px;color:var(--ts)">Chargement...</td></tr></tbody></table></div>
      </div>
    </div>

    <div class="pg" id="pg-integrations">
      <div class="al2 ali2">🔌 Configurez vos partenaires ici. Sans configuration = mode simulation (aucun crash).</div>
      <div id="intlist"><div class="es"><div class="ei">⏳</div><p>Chargement...</p></div></div>
    </div>

    <div class="pg" id="pg-features">
      <div class="cd">
        <div class="cdh"><span class="cdt">🎛️ Fonctionnalités</span>
          <div s
