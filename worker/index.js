/**
 * worker/index.js — exécute les tâches sur chat.z.ai via Chromium
 *
 *   cp .env.example .env      (API_BASE + WORKER_TOKEN)
 *   node setup.js             (une fois : captcha)
 *   node index.js             (démarre le worker)
 */
'use strict';

require('dotenv').config();
const path = require('path');
const { chromium } = require('playwright');

const API_BASE = (process.env.API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
const POLL_MS = Number(process.env.WORKER_POLL_MS || 3000);
const PROFILE = process.env.GLM_PROFILE_DIR || path.join(__dirname, 'worker-profile');
const HEADLESS = process.env.HEADLESS !== '0';
const DRY = process.env.DRY_RUN === '1';
const TIMEOUT = Number(process.env.ANSWER_TIMEOUT_MS || 180000);

const SEL = {
  input: '#chat-input',
  assistant: '.chat-assistant',
  user: '.chat-user',
  prose: '.markdown-prose, .prose',
};

const ts = () => new Date().toLocaleTimeString('fr-FR', { hour12: false });
const log = {
  info: (m) => console.log(ts() + ' · ' + m),
  ok: (m) => console.log(ts() + ' ✅ ' + m),
  warn: (m) => console.log(ts() + ' ⚠️  ' + m),
  err: (m) => console.log(ts() + ' ❌ ' + m),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path2, body) {
  const res = await fetch(API_BASE + path2, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + WORKER_TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(path2 + ' ' + res.status + ' : ' + text.slice(0, 200));
  return JSON.parse(text);
}

async function captchaPresent(page) {
  try {
    const body = await page.innerText('body');
    return /security verification|drag the slider to complete the puzzle|complete verification/i.test(body);
  } catch (_) {
    return false;
  }
}

async function openChat(page, url) {
  const target = url || process.env.ZAI_CHAT_URL || 'https://chat.z.ai/';
  for (let i = 1; i <= 3; i++) {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector(SEL.input, { state: 'attached', timeout: 45000 });
      await page.waitForTimeout(1500);
      return target;
    } catch (e) {
      if (i === 3) throw e;
      await page.waitForTimeout(2500);
    }
  }
}

async function ask(page, prompt) {
  const t0 = Date.now();
  const before = await page.locator(SEL.assistant).count();

  const box = page.locator(SEL.input);
  await box.click();
  await box.fill(prompt);
  await page.waitForTimeout(250);
  await box.press('Enter');
  await page.waitForTimeout(1200);

  if ((await page.locator(SEL.user).count()) === 0) {
    for (const sel of ['#send-message-button', 'button[type="submit"]', 'button[aria-label*="Send" i]']) {
      const btn = page.locator(sel).last();
      if ((await btn.count()) && (await btn.isVisible())) { await btn.click({ timeout: 5000 }); break; }
    }
  }

  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(1500);
    if (await captchaPresent(page)) {
      throw new Error('CAPTCHA Z.ai : validation humaine requise. Lance « node setup.js » une fois, puis relance le worker.');
    }
  }

  const deadline = Date.now() + TIMEOUT;
  let last = '';
  let stable = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(1200);
    if (await captchaPresent(page)) throw new Error('CAPTCHA Z.ai déclenché pendant la génération.');

    const n = await page.locator(SEL.assistant).count();
    if (n <= before) continue;

    const bubble = page.locator(SEL.assistant).last();
    let text = '';
    try {
      const prose = bubble.locator(SEL.prose).last();
      text = (await prose.count()) ? await prose.innerText() : await bubble.innerText();
    } catch (_) { text = ''; }
    text = (text || '').trim();

    if (text && text === last) {
      stable++;
      if (stable >= 2) break;
    } else {
      stable = 0;
    }
    last = text || last;
  }

  if (!last) throw new Error('Aucune réponse de GLM dans le délai imparti.');

  const clean = last.replace(/^Copy\s*$/gim, '').replace(/^Edit\s*$/gim, '').replace(/\u200b/g, '').trim();
  return { answer: clean, durationMs: Date.now() - t0, zaiUrl: page.url() };
}

(async () => {
  if (!WORKER_TOKEN) {
    log.err('WORKER_TOKEN manquant — copie worker/.env.example en worker/.env');
    process.exit(1);
  }

  log.info('Worker démarré — API : ' + API_BASE);
  log.info('Profil Chromium : ' + PROFILE);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    locale: 'fr-FR',
    viewport: { width: 1440, height: 960 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(30000);
  await openChat(page, null);
  log.ok('Navigateur prêt.' + (DRY ? ' (mode DRY RUN)' : ''));

  if (await captchaPresent(page)) {
    log.warn('Captcha présent : lance « node setup.js » une fois pour le valider.');
  }

  let idle = 0;
  for (;;) {
    let task = null;
    try {
      task = await api('/api/v1/worker/claim');
    } catch (e) {
      log.err(e.message);
      await sleep(POLL_MS * 2);
      continue;
    }

    if (!task) {
      idle++;
      if (idle % 20 === 0) log.info('Aucune tâche (' + Math.round((idle * POLL_MS) / 1000) + ' s d\'attente).');
      await sleep(POLL_MS);
      continue;
    }
    idle = 0;

    const job = task.job;
    log.info('Tâche ' + job.id + ' · ' + String(job.prompt).slice(0, 70));

    try {
      await openChat(page, job.zaiUrl || null);

      if (DRY) {
        await api('/api/v1/worker/complete', {
          jobId: job.id,
          answer: '[DRY RUN] reçu : ' + job.prompt,
          model: 'dry-run',
          durationMs: 1,
        });
        log.ok('Réponse simulée envoyée.');
        continue;
      }

      const r = await ask(page, job.composedPrompt || job.prompt);
      await api('/api/v1/worker/complete', {
        jobId: job.id,
        answer: r.answer,
        durationMs: r.durationMs,
        zaiUrl: r.zaiUrl,
      });
      log.ok('Terminé en ' + (r.durationMs / 1000).toFixed(1) + ' s — ' + r.answer.length + ' car.');
    } catch (e) {
      log.err('Tâche ' + job.id + ' : ' + e.message);
      try {
        await api('/api/v1/worker/complete', { jobId: job.id, error: e.message });
      } catch (e2) {
        log.err('Signalement impossible : ' + e2.message);
      }
    }
  }
})().catch((e) => {
  log.err(e.message);
  process.exit(1);
});
