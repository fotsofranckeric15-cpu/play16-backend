# PLAY16 — Backend

Backend de l'application Play16 (Marketplace + Cash-Work), Cameroun.

## Stack
- Node.js + Express
- PostgreSQL (hébergé sur Railway)
- Architecture "tiroir SIM" : tous les services externes (paiement,
  notifications, cartes, stockage) sont configurables à chaud depuis
  Super Admin > Intégrations, sans jamais nécessiter de redéploiement.

## Déploiement sur Railway — étapes pour Franck

### 1. Créer le projet sur Railway
1. Va sur railway.app, connecte-toi
2. Clique **New Project** → **Deploy from GitHub repo**
   (il faudra d'abord pousser ce code sur un repo GitHub —
   je peux t'accompagner pour ça si besoin)
3. Railway détecte automatiquement Node.js

### 2. Ajouter une base de données PostgreSQL
1. Dans ton projet Railway → **New** → **Database** → **PostgreSQL**
2. Railway génère automatiquement une variable `DATABASE_URL`
3. Va dans l'onglet **Variables** du service backend → vérifie que
   `DATABASE_URL` est bien liée (Railway le fait souvent automatiquement
   via "Reference Variable")

### 3. Ajouter les variables d'environnement
Dans **Variables** du service backend, ajoute :
```
JWT_SECRET = (génère une longue chaîne aléatoire, ex: via
              https://generate-secret.vercel.app/64)
NODE_ENV = production
```
Ne mets JAMAIS les clés Campay/WhatsApp/etc. ici — elles se
configurent depuis l'interface Super Admin une fois l'app en ligne.

### 4. Lancer la migration (une seule fois, après le premier déploiement)
Railway propose un terminal directement dans l'interface
(**Settings** → **Service** → bouton terminal), ou tu peux utiliser
Railway CLI en local :
```
railway run npm run migrate
```

### 5. Vérifier que ça tourne
Une fois déployé, Railway donne une URL publique du type
`https://play16-backend.up.railway.app`. Visite :
```
https://play16-backend.up.railway.app/health
```
Tu dois voir : `{"status":"ok","service":"play16-backend",...}`

## Structure du projet
```
src/
├── server.js              → point d'entrée
├── db/
│   ├── pool.js             → connexion PostgreSQL
│   └── migrate.js          → applique schema.sql
├── services/                → "tiroir SIM" — abstraction des
│   ├── integrationRegistry.js   providers externes. Le reste de
│   ├── NotificationService.js   l'app n'appelle jamais un provider
│   └── PaymentService.js        directement.
├── routes/                 → endpoints API (à venir, Étape 2+)
├── middleware/              → auth, validation (à venir)
└── models/                  → requêtes structurées par table (à venir)
```

## Prochaine étape (Étape 2 du plan)
Routes API pour la Marketplace : produits, commandes, séquestre,
intégration réelle Campay/CinetPay.
