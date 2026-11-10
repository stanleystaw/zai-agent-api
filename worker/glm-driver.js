/**
 * worker/glm-driver.js — pilotage de chat.z.ai par Chromium
 *
 * Ce fichier ne tourne PAS sur Vercel : il tourne sur une machine avec navigateur
 * (PC, Raspberry Pi, Termux, VPS avec xvfb).
 */
'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SEL = {
  input: '#chat-input',
  assistant: '.chat-assistant',
  user: '.chat-user',
  prose: '.markdown-prose, .prose',
  sendButtons: ['#send-message-button', 'button[type="submit"]', 'button[aria-label*="Send" i]'],
};

class GLMDriver {
  constructor({ profileDir, headless = true, chatUrl = 'https://chat.z.ai/', timeoutMs = 180000 }) {
    this.profileDir = profileDir;
    this.headless = headless;
    this.chatUrl = chatUrl;
    this.timeoutMs = timeoutMs;
    this.context = null;
    this.page = null;
  }

  async start() {
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      locale: 'fr-FR',
      viewport: { width: 1440, height: 960 },
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.page.setDefaultTimeout(30000);
    await this.open();
    return this;
  }

  /** Ouvre le chat, ou une conversation existante si une URL est fournie. */
  async open(zaiUrl = null) {
    const target = zaiUrl || this.chatUrl;
    for (let i = 1; i <= 3; i++) {
      try {
        await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.page.waitForSelector(SEL.input, { state: 'attached', timeout: 45000 });
        await this.page.waitForTimeout(1500);
        return target;
      } catch (e) {
        if (i === 3) throw e;
        await this.page.waitForTimeout(2500);
      }
    }
  }

  async captchaPresent() {
    try {
      const body = await this.page.innerText('body').catch(() => '');
      return /security verification|drag the slider to complete the puzzle|complete verification/i.test(body);
    } catch (_) {
      return false;
    }
  }

  async currentUrl() {
    return this.page.url();
  }

  /**
   * Envoie un message et renvoie la réponse.
   * @returns {Promise<{answer: string, durationMs: number, zaiUrl: string}>}
   */
  async ask(prompt) {
    const t0 = Date.now();
    const before = await this.page.locator(SEL.assistant).count();

    const box = this.page.locator(SEL.input);
    await box.click();
    await box.fill(prompt);
    await this.page.waitForTimeout(250);
    await box.press('Enter');

    await this.page.waitForTimeout(1200);
    if ((await this.page.locator(SEL.user).count()) === 0) {
      await this.clickSend();
    }

    // Le captcha peut apparaître juste après l'envoi
    for (let i = 0; i < 4; i++) {
      await this.page.waitForTimeout(1500);
      if (await this.captchaPresent()) {
        throw new Error(
          'CAPTCHA Z.ai : validation humaine requise. Lance « npm run setup » (worker/setup.js) une fois, puis relance le worker.'
        );
      }
    }

    const answer = await this.waitForAnswer(before);
    return { answer, durationMs: Date.now() - t0, zaiUrl: this.page.url() };
  }

  async clickSend() {
    for (const sel of SEL.sendButtons) {
      try {
        const btn = this.page.locator(sel).last();
        if ((await btn.count()) && (await btn.isVisible())) {
          await btn.click({ timeout: 5000 });
          return;
        }
      } catch (_) {
        /* suivant */
      }
    }
  }

  async waitForAnswer(previousCount) {
    const deadline = Date.now() + this.timeoutMs;
    let last = '';
    let stable = 0;

    while (Date.now() < deadline) {
      await this.page.waitForTimeout(1200);

      if (await this.captchaPresent()) {
        throw new Error('CAPTCHA Z.ai déclenché pendant la génération.');
      }

      const count = await this.page.locator(SEL.assistant).count();
      if (count <= previousCount) continue;

      const bubble = this.page.locator(SEL.assistant).last();
      let text = '';
      try {
        const prose = bubble.locator(SEL.prose).last();
        text = (await prose.count()) ? await prose.innerText() : await bubble.innerText();
      } catch (_) {
        text = '';
      }
      text = (text || '').trim();

      if (text && text === last) {
        stable++;
        if (stable >= 2) return this.clean(text);
      } else {
        stable = 0;
      }
      last = text || last;
    }

    if (last) return this.clean(last);
    throw new Error('Aucune réponse de GLM dans le délai imparti.');
  }

  clean(text) {
    return String(text || '')
      .replace(/^Copy\s*$/gim, '')
      .replace(/^Edit\s*$/gim, '')
      .replace(/\u200b/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async close() {
    if (this.context) await this.context.close();
  }
}

module.exports = { GLMDriver, SEL };
