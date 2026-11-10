# GLM Agent API

API REST **agentique** pour GLM (chat.z.ai) : conversations persistantes, mémoire,
jobs asynchrones, reprise de conversations Z.ai existantes.

> **Aucun navigateur sur Vercel.** L'API décide ; un *worker* Chromium exécute
> sur ta machine (PC, Raspberry Pi, Termux, VPS). C'est ce qui rend le
> déploiement serveur possible et gratuit.

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

## Démarrage

```bash
BASE=https://TON-PROJET.vercel.app
KEY=ta-cle-api

# 1. Créer une conversation
CONV=$(curl -s -X POST "$BASE/api/v1/conversations" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"title":"Projet Alpha","system":"Tu es un assistant francophone."}' | jq -r .id)

# 2. Envoyer une demande (réponse directe, max 25 s)
curl -s -X POST "$BASE/api/v1/conversations/$CONV/messages" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"message":"Rédige un planning de la semaine.","mode":"sync"}' | jq

# 3. Ou en asynchrone + sondage
JOB=$(curl -s -X POST "$BASE/api/v1/conversations/$CONV/messages" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"message":"Analyse ce marché."}' | jq -r .jobId)
curl -s "$BASE/api/v1/jobs/$JOB" -H "Authorization: Bearer $KEY" | jq
```

---

## Endpoints

Base `/api/v1` · en-tête `Authorization: Bearer <API_KEY>`

### Conversations

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/conversations` | liste (triée par activité) |
| `POST` | `/conversations` | crée (`title`, `system`, `zaiUrl`) |
| `GET` | `/conversations/:id` | détail + messages |
| `PATCH` | `/conversations/:id` | renommer / `system` / lier un `zaiUrl` |
| `DELETE` | `/conversations/:id` | supprime |
| `GET` | `/conversations/:id/messages` | historique |
| `POST` | `/conversations/:id/messages` | **envoyer une demande** |

### Jobs

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/jobs` | liste (`?conversationId=`) |
| `POST` | `/jobs` | crée un job |
| `GET` | `/jobs/:id` | état + réponse |
| `DELETE` | `/jobs/:id` | annule un job en file |

### Worker (réservé au navigateur)

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/worker/claim` | réserve la tâche suivante (204 si vide) |
| `POST` | `/worker/complete` | renvoie le résultat ou l'erreur |

### Divers

`GET /api/v1/health` — état, stockage, longueur de file.

---

## Envoyer une demande

```jsonc
POST /api/v1/conversations/:id/messages
{
  "message": "Rédige un devis pour 3 chaises.",
  "mode": "async",                          // ou "sync"
  "zaiUrl": "https://chat.z.ai/c/abc123",   // optionnel : reprise
  "system": "Tu es un expert-comptable."    // optionnel : change le prompt système
}
```

- **async** (défaut) → `202 { jobId, pollUrl }`, puis `GET /jobs/:id` jusqu'à `status: "done"`.
- **sync** → attend jusqu'à 25 s et renvoie `{ status: "done", answer, conversation }`.
  Au-delà, renvoie `202` : la tâche continue, il suffit de sonder.

`GET /jobs/:id` renvoie :

```json
{
  "status": "done",
  "result": { "answer": "…", "model": "GLM-5.3-Flash", "durationMs": 8123 },
  "durationMs": 8123,
  "error": null
}
```

---

## Réutiliser une conversation Z.ai existante

```bash
# à la création
-d '{"title":"Reprise","zaiUrl":"https://chat.z.ai/c/abc123"}'

# ou plus tard
curl -X PATCH "$BASE/api/v1/conversations/$CONV" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"zaiUrl":"https://chat.z.ai/c/abc123"}'

# ou au moment de l'envoi
-d '{"message":"…","zaiUrl":"https://chat.z.ai/c/abc123"}'
```

Le worker détecte l'URL (`/c/<id>`) et **ouvre cette conversation** au lieu d'en créer
une neuve. Après chaque réponse, l'URL réellement utilisée est enregistrée : les tours
suivants reprennent au même endroit.

---

## Mémoire

À chaque tour, le prompt envoyé réinjecte :

1. le **prompt système** de la conversation,
2. un **résumé cumulatif** (les anciens messages sont compactés au-delà de 80),
3. les **6 derniers échanges** (« Moi : … / Toi : … »),
4. la **nouvelle demande**.

Le fil est donc conservé même si la session Z.ai expire ou change de machine.

---

## Déployer

1. **Vercel** → projet `zai-agent-api` (déjà déployé).
   Variables d'environnement :

| Variable | Rôle |
|---|---|
| `API_KEYS` | clés clients, séparées par des virgules — `openssl rand -hex 32` |
| `WORKER_TOKEN` | secret partagé avec le worker |
| `KV_REST_API_URL` | persistance Upstash (gratuit) |
| `KV_REST_API_TOKEN` | idem |
| `SYNC_WAIT_MS` | 25000 par défaut |

> Sans les variables KV, le stockage est **en mémoire** : les conversations
> disparaissent au redémarrage de la fonction. Upstash : https://upstash.com → Redis → REST API.

2. **Worker**, sur la machine avec navigateur :

```bash
cd worker
npm install playwright
npx playwright install chromium
cp .env.example .env        # API_BASE, WORKER_TOKEN
node setup.js               # ✋ une fois : valide le captcha Z.ai
node index.js               # démarre le worker
```

---

## Sécurité

- `API_KEYS` vide et `ALLOW_ANONYMOUS≠1` → **tout est refusé**.
- Comparaison des clés à temps constant (`crypto.timingSafeEqual`).
- `WORKER_TOKEN` distinct des clés clients : un client ne peut ni se faire passer
  pour le worker ni vider la file.
- Le worker ne reçoit qu'un texte à envoyer à chat.z.ai : jamais de code arbitraire.

---

## Limites assumées

1. **Le captcha Z.ai exige une validation humaine une fois** (`node setup.js`).
   C'est le rempart anti-robot du site ; la session validée est réutilisée ensuite.
2. **Le worker doit tourner quelque part** : un serveur ne peut pas garder un
   Chromium persistant. PC, Raspberry Pi, Termux ou VPS avec `xvfb`.
3. **Un job à la fois par worker** — lance plusieurs workers (profils distincts)
   pour paralléliser.
4. **Latence** de 5 à 30 s selon la longueur de la réponse (génération réelle).
