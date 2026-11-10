/**
 * worker/setup.js — à lancer UNE fois pour valider le captcha Z.ai
 *
 *   node worker/setup.js
 *
 * Ouvre un Chromium VISIBLE, tu glisses le captcha, tu envoies un message,
 * la session est enregistrée dans worker-profile/ et le worker la réutilisera.
 */
'use strict';

require('dotenv').config();
const path = require('path');
const { GLMDriver } = require('./glm-driver');

const PROFILE = process.env.GLM_PROFILE_DIR || path.join(__dirname, '..', 'worker-profile');
const CHAT = process.env.ZAI_CHAT_URL || 'https://chat.z.ai/';

(async () => {
  console.log('\n╭───────────────────────────────────────────────╮');
  console.log('│  Validation du captcha Z.ai (une seule fois)  │');
  console.log('╰───────────────────────────────────────────────╯\n');
  console.log(`Profil : ${PROFILE}\n`);
  console.log('1. Une fenêtre Chromium va s\'ouvrir.');
  console.log('2. Glisse le curseur du puzzle si demandé.');
  console.log('3. Envoie « bonjour » et attends la réponse.\n');

  const driver = new GLMDriver({ profileDir: PROFILE, headless: false, chatUrl: CHAT });
  await driver.start();

  console.log('Fenêtre ouverte — en attente d\'une réponse de GLM (10 min max)…\n');

  const deadline = Date.now() + 10 * 60 * 1000;
  let detected = false;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await driver.captchaPresent()) {
      console.log('   … captcha toujours affiché, glisse le curseur.');
      continue;
    }
    const count = await driver.page.locator('.chat-assistant').count();
    if (count > 0) {
      const text = (await driver.page.locator('.chat-assistant').last().innerText()).trim();
      if (text.length > 5) {
        console.log(`\n✅ Réponse détectée (${text.length} car.) :\n\n${text.slice(0, 300)}\n`);
        detected = true;
        break;
      }
    }
  }

  await new Promise((r) => setTimeout(r, 1500));
  await driver.close();

  if (detected) {
    console.log('✅ Session enregistrée. Tu peux lancer le worker :\n\n   node worker/index.js\n');
  } else {
    console.log('⚠️  Aucune réponse détectée. Relance et valide bien le captcha.');
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
