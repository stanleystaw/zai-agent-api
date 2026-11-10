/**
 * worker/index.js — le worker qui exécute les tâches sur chat.z.ai
 *
 *   API_BASE=https://ton-api.vercel.app
 *   WORKER_TOKEN=le-même-que-sur-vercel
 *   node worker/index.js
 *
 * Boucle :
 *   1. POST /api/v1/worker/claim  → récupère une tâche (ou 204)
 *   2. exécute dans Chromium
 *   3. POST /api/v1/worker/complete → renvoie la réponse
 */
'use strict';

require('dotenv').config();
const path = require('path');
const { GLMDriver } = require('./glm-driver');

const API_BASE = (process.env.API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const POLL_MS = Number(process.env.WORKER_POLL_MS || 3000);
const PROFILE = process.env.GLM_PROFILE_DIR || path.join(__dirname, '..', 'worker-profile');
const HEADLESS = process.env.HEADLESS !== '0';
const DRY = process.env.DRY_RUN === '1';

const t = () => new Date().toLocaleTimeString('fr-FR', { hour12: false });
const log = {
  info: (m) => console.log(`${t()} · ${m}`),
  ok: (m) => console.log(`${t()} ✅ ${m}`),
  warn: (m) => console.log(`${t()} ⚠️  ${m}`),
  err: (m) => console.log(`${t()} ❌ ${m}`),
};

function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${WORKER_TOKEN}`,
  };
}

async function claim() {
  const res = await fetch(`${API_BASE}/api/v1/worker/claim`, { method: 'POST', headers: headers() });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`claim ${res.status} : ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function complete(payload) {
  const res = await fetch(`${API_BASE}/api/v1/worker/complete`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`complete ${res.status} : ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function main() {
  if (!WORKER_TOKEN) {
    log.err('WORKER_TOKEN manquant. Ajoute-le dans worker/.env');
    process.exit(1);
  }
  if (!process.env.DRY_RUN) {
    /* rien */
  }

  log.info(`Worker démarré — API : ${API_BASE}`);
  log.info(`Profil Chromium : ${PROFILE}`);

  const driver = new GLMDriver({ profileDir: PROFILE, headless: HEADLESS });
  await driver.start();
  log.ok('Navigateur prêt.');

  if (await driver.captchaPresent()) {
    log.warn('Captcha présent : lance « node worker/setup.js » une fois pour le valider.');
  }

  let idleRounds = 0;
  // Boucle infinie volontaire : le worker est un démon.
  for (;;) {
    let task = null;
    try {
      task = await claim();
    } catch (e) {
      log.err(e.message);
      await sleep(POLL_MS * 2);
      continue;
    }

    if (!task) {
      idleRounds++;
      if (idleRounds % 20 === 0) log.info(`Aucune tâche (${idleRounds * (POLL_MS / 1000)} s d'attente).`);
      await sleep(POLL_MS);
      continue;
    }
    idleRounds = 0;

    const { job, conversation } = task;
    log.info(`Tâche ${job.id} · conversation ${conversation.id} · ${String(job.prompt).slice(0, 70)}…`);

    try {
      // Reprise d'une conversation Z.ai existante si elle est fournie
      if (job.zaiUrl) {
        log.info(`Ouverture de la conversation existante : ${job.zaiUrl}`);
        await driver.open(job.zaiUrl);
      } else {
        await driver.open(null);
      }

      if (DRY) {
        await complete({
          jobId: job.id,
          answer: `[DRY RUN] Le worker a bien reçu : « ${job.prompt} »`,
          model: 'dry-run',
          durationMs: 1,
        });
        log.ok('DRY RUN — réponse simulée envoyée.');
        continue;
      }

      const result = await driver.ask(job.composedPrompt || job.prompt);
      await complete({
        jobId: job.id,
        answer: result.answer,
        model: null,
        durationMs: result.durationMs,
        zaiUrl: result.zaiUrl,
      });
      log.ok(`Terminé en ${(result.durationMs / 1000).toFixed(1)} s — ${result.answer.length} car.`);
    } catch (e) {
      log.err(`Tâche ${job.id} : ${e.message}`);
      try {
        await complete({ jobId: job.id, error: e.message });
      } catch (e2) {
        log.err(`Impossible de signaler l'échec : ${e2.message}`);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

process.on('SIGINT', async () => {
  log.warn('Arrêt du worker.');
  process.exit(0);
});

main().catch((e) => {
  log.err(e.message);
  process.exit(1);
});
