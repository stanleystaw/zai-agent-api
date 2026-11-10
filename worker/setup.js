/**
 * worker/setup.js — à lancer UNE fois pour valider le captcha Z.ai
 *
 *   node setup.js
 *
 * Ouvre un Chromium visible, tu glisses le curseur, tu envoies un message.
 * La session est enregistrée dans worker-profile/ et réutilisée ensuite.
 */
'use strict';

try { require('dotenv').config(); } catch (_) { /* dotenv optionnel */ }
const path = require('path');
const { chromium } = require('playwright');

const PROFILE = process.env.GLM_PROFILE_DIR || path.join(__dirname, 'worker-profile');
const CHAT = process.env.ZAI_CHAT_URL || 'https://chat.z.ai/';

(async () => {
  console.log('\n╭───────────────────────────────────────────────╮');
  console.log('│  Validation du captcha Z.ai (une seule fois)  │');
  console.log('╰───────────────────────────────────────────────╯\n');
  console.log('Profil : ' + PROFILE + '\n');
  console.log('1. Une fenêtre Chromium va s\'ouvrir.');
  console.log('2. Glisse le curseur du puzzle si demandé.');
  console.log('3. Envoie « bonjour » et attends la réponse.\n');

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    locale: 'fr-FR',
    viewport: { width: 1440, height: 960 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(CHAT, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#chat-input', { state: 'attached', timeout: 60000 });

  console.log('Fenêtre ouverte — en attente d\'une réponse de GLM (10 min max)…\n');

  const deadline = Date.now() + 10 * 60 * 1000;
  let detected = false;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const body = await page.innerText('body').catch(() => '');
    if (/security verification|drag the slider/i.test(body)) {
      console.log('   … captcha affiché, glisse le curseur dans la fenêtre.');
      continue;
    }
    const n = await page.locator('.chat-assistant').count();
    if (n > 0) {
      const text = (await page.locator('.chat-assistant').last().innerText()).trim();
      if (text.length > 5) {
        console.log('\n✅ Réponse détectée (' + text.length + ' car.) :\n\n' + text.slice(0, 300) + '\n');
        detected = true;
        break;
      }
    }
  }

  await new Promise((r) => setTimeout(r, 1500));
  await ctx.close();

  if (detected) {
    console.log('✅ Session enregistrée. Lance maintenant :\n\n   node index.js\n');
  } else {
    console.log('⚠️  Aucune réponse détectée. Relance et valide bien le captcha.');
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
