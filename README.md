# GLM Agent API

API REST **agentique** pour GLM (chat.z.ai) : conversations persistantes, mémoire,
jobs asynchrones, reprise de conversations Z.ai existantes.

> **Aucun navigateur ne tourne sur Vercel.** L'API décide, un *worker* Chromium
> exécute sur ta machine. C'est ce qui rend le déploiement serveur possible et gratuit.

```
   Client (curl, app, n8n, Make…)
        │  REST
        ▼
   API sur Vercel  ──── file de jobs ────►  Worker Chromium (ta machine)
        ▲                                        │
        └──────────── résultat ◄─────────────────┘
                                          chat.z.ai (session persistante)
```

---

## Modèle mental en 3 objets

| Objet | Rôle | Durée de vie |
|---|---|---|
| **Conversation** | mémoire durable : messages, titre, prompt système, lien Z.ai | 30 jours |
| **Job** | une demande en cours d'exécution (file d'attente) | 3 jours |
| **Worker** | le navigateur qui va chercher les jobs et rend les réponses | tourne en continu |

---

## Démarrage rapide

```bash
# 1. API en local
npm install
cp .env.example .env          # mets tes clés
npm run dev                   # http://localhost:3000

# 2. Worker (autre terminal)
cd worker && npm install --prefix ..    # playwright est en devDependency
node ../worker/setup.js       # ✋ une fois : valide le captcha Z.ai
node ../worker/index.js       # démarre le worker
```

Dans un troisième terminal :

```bash
export API=https://ton-api.vercel.app
export KEY=ta-cle-client

# Créer une conversation
CONV=$(curl -s -X POST "$API/api/v1/conversations" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"title":"Projet Alpha","system":"Tu es un assistant francophone."}' \
  | jq -r .id)

# Envoyer une demande et lire la réponse (mode synchrone)
curl -s -X POST "$API/api/v1/conversations/$CONV/messages" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"message":"Rédige un planning de la semaine.","mode":"sync"}' | jq
```

---

## Endpoints

Base : `/api/v1` — en-tête `Authorization: Bearer <API_KEY>`

### Conversations

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/conversations` | liste (triée par dernière activité) |
| `POST` | `/conversations` | crée (`title`, `system`, `zaiUrl`) |
| `GET` | `/conversations/:id` | détail + messages |
| `PATCH` | `/conversations/:id` | renommer, changer `system`, lier un `zaiUrl` |
| `DELETE` | `/conversations/:id` | supprime |
| `GET` | `/conversations/:id/messages` | historique seul |
| `POST` | `/conversations/:id/messages` | **envoyer une demande** |

### Jobs

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/jobs` | liste (`?conversationId=`, `?limit=`) |
| `POST` | `/jobs` | crée un job sans passer par la conversation |
| `GET` | `/jobs/:id` | état + réponse |
| `DELETE` | `/jobs/:id` | annule un job encore en file |

### Worker (réservé)

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/worker/claim` | réserve la tâche suivante (204 si vide) |
| `POST` | `/worker/complete` | renvoie le résultat ou l'erreur |

### Divers

| Route | Description |
|---|---|
| `GET /api/v1/health` | état, stockage, longueur de file |
| `GET /api` | index des routes |

---

## Envoyer une demande

**Asynchrone (par défaut)** — renvoie `202` immédiatement :

```bash
curl -s -X POST "$API/api/v1/conversations/$CONV/messages" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"message":"Analyse ce marché."}'
# → { "jobId": "job_…", "status": "queued", "pollUrl": "/api/v1/jobs/job_…" }

curl -s "$API/api/v1/jobs/job_…" -H "Authorization: Bearer $KEY" | jq
# → { "status": "done", "result": { "answer": "…", "durationMs": 8123 } }
```

**Synchrone** — attend la réponse (max 25 s, configurable) :

```bash
-d '{"message":"…", "mode":"sync"}'
# → { "status":"done", "answer":"…", "conversation": { … } }
```

> Sur Vercel, une fonction est coupée à 30 s. Le mode sync attend 25 s maximum,
> puis renvoie `202` avec le `jobId` : la tâche continue, il suffit de sonder.

---

## Réutiliser une conversation Z.ai existante

Trois façons, cumulables :

```bash
# a) à la création
-d '{"title":"Reprise","zaiUrl":"https://chat.z.ai/c/abc123"}'

# b) en modifiant
curl -X PATCH "$API/api/v1/conversations/$CONV" \
  -d '{"zaiUrl":"https://chat.z.ai/c/abc123"}'

# c) au moment de l'envoi
-d '{"message":"…","zaiUrl":"https://chat.z.ai/c/abc123"}'
```

Le worker détecte l'URL (`/c/<id>`) et **ouvre cette conversation** au lieu d'en créer
une neuve. Après chaque réponse, l'API enregistre l'URL réellement utilisée :
les tours suivants reprennent au même endroit.

---

## Mémoire

À chaque tour, l'API compose le prompt en réinjectant :

1. le **prompt système** de la conversation,
2. un **résumé cumulatif** (au-delà de 80 messages, les anciens sont compactés),
3. les **6 derniers échanges** (« Moi : … / Toi : … »),
4. la **nouvelle demande**.

Résultat : le fil est conservé même si la session Z.ai change, expire ou est reprise
sur une autre machine.

---

## Déploiement Vercel

```bash
npm i -g vercel
vercel --prod
```

Puis **Settings → Environment Variables** :

| Variable | Rôle |
|---|---|
| `API_KEYS` | clés clients (virgules) — `openssl rand -hex 32` |
| `WORKER_TOKEN` | secret partagé avec le worker |
| `KV_REST_API_URL` | persistance (Upstash, gratuit) |
| `KV_REST_API_TOKEN` | idem |
| `SYNC_WAIT_MS` | 25000 par défaut |

Sans les variables KV, le stockage est en mémoire : **les conversations disparaissent
à chaque redémarrage de la fonction**. Va sur https://upstash.com, crée une base Redis,
copie l'URL REST et le token.

Puis lance le worker **sur ta machine** (pas sur Vercel) :

```bash
cd worker
API_BASE=https://ton-projet.vercel.app WORKER_TOKEN=… node index.js
```

---

## Sécurité

- `API_KEYS` vide et `ALLOW_ANONYMOUS=0` → **toutes les requêtes sont refusées**.
- Comparaison des clés à temps constant (`crypto.timingSafeEqual`).
- `WORKER_TOKEN` est distinct des clés clients : un client ne peut pas se faire passer
  pour le worker ni vider la file.
- Le worker ne prend que des tâches déjà enregistrées : il n'exécute jamais de code venu
  du client, seulement un texte envoyé à chat.z.ai.

---

## Tests

```bash
npm test
```

27 vérifications sans navigateur ni réseau externe : authentification, CRUD,
envoi async/sync, claim/complete du worker, mémoire réinjectée, annulation, suppression.

---

## Limites assumées

1. **Le captcha Z.ai exige une validation humaine une fois** (`node worker/setup.js`).
   C'est le rempart anti-robot du site ; la session validée est ensuite réutilisée.
2. **Le worker doit tourner quelque part** (PC, Raspberry Pi, VPS, Termux). C'est le prix
   du « tout navigateur » : un serveur ne peut pas ouvrir un Chromium persistant.
3. **Un seul job à la fois par worker** — pour aller plus vite, lance plusieurs workers
   avec des profils différents.
4. **Latence** : 5 à 30 s selon la longueur de la réponse (génération réelle sur le site).
