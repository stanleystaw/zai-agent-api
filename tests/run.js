/**
 * tests/run.js — suite complète, sans navigateur ni réseau externe
 * Le worker est simulé : on teste le contrat API de bout en bout.
 */
'use strict';

process.env.API_KEYS = 'test-key-123';
process.env.WORKER_TOKEN = 'worker-secret';
process.env.SYNC_WAIT_MS = '4000';
process.env.ALLOW_ANONYMOUS = '0';

const assert = require('assert');
const http = require('http');

const PORT = 4321 + Math.floor(Math.random() * 100);
process.env.PORT = String(PORT);

const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'test-key-123';
const WORKER = 'worker-secret';

let ok = 0;
let ko = 0;
async function test(name, fn) {
  try {
    await fn();
    ok++;
    console.log('  ✓', name);
  } catch (e) {
    ko++;
    console.error('  ✗', name, '\n     ', e.message);
  }
}

async function api(method, path, { body, key = KEY, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Démarrage du serveur de dev
  const { spawn } = require('child_process');
  const server = spawn('node', ['dev-server.js'], {
    cwd: require('path').resolve(__dirname, '..'),
    env: { ...process.env },
    stdio: 'ignore',
  });
  server.unref();

  // Attente du démarrage
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${BASE}/api/v1/health`);
      break;
    } catch (_) {
      await sleep(250);
    }
  }

  console.log('\n[1] Authentification');
  const noKey = await api('GET', '/api/v1/conversations', { key: null });
  await test('refuse sans clé', () => assert.equal(noKey.status, 401));

  const badKey = await api('GET', '/api/v1/conversations', { key: 'faux' });
  await test('refuse une clé invalide', () => assert.equal(badKey.status, 401));

  const health = await api('GET', '/api/v1/health');
  await test('santé accessible avec la clé', () => {
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
  });

  console.log('\n[2] Conversations');
  const created = await api('POST', '/api/v1/conversations', {
    body: { title: 'Ma première conversation', system: 'Tu es un assistant francophone.' },
  });
  await test('création', () => {
    assert.equal(created.status, 201);
    assert.ok(created.body.id.startsWith('conv_'));
    assert.equal(created.body.title, 'Ma première conversation');
  });
  const convId = created.body.id;

  const listed = await api('GET', '/api/v1/conversations');
  await test('elle apparaît dans la liste', () => {
    assert.equal(listed.status, 200);
    assert.ok(listed.body.conversations.some((c) => c.id === convId));
  });

  const detail = await api('GET', `/api/v1/conversations/${convId}`);
  await test('lecture du détail', () => {
    assert.equal(detail.status, 200);
    assert.equal(detail.body.messageCount, 0);
    assert.equal(detail.body.system, 'Tu es un assistant francophone.');
  });

  const patched = await api('PATCH', `/api/v1/conversations/${convId}`, {
    body: { zaiUrl: 'https://chat.z.ai/c/abc123' },
  });
  await test('réutilisation d\'une conversation Z.ai existante', () => {
    assert.equal(patched.status, 200);
    assert.equal(patched.body.zaiUrl, 'https://chat.z.ai/c/abc123');
  });

  const on404 = await api('GET', '/api/v1/conversations/conv_inexistant');
  await test('404 sur une conversation inconnue', () => assert.equal(on404.status, 404));

  console.log('\n[3] Envoi d\'une demande (mode async + worker simulé)');
  const sent = await api('POST', `/api/v1/conversations/${convId}/messages`, {
    body: { message: 'Rédige un planning de la semaine pour un freelance.' },
  });
  await test('202 + jobId renvoyé', () => {
    assert.equal(sent.status, 202);
    assert.ok(sent.body.jobId.startsWith('job_'));
  });
  const jobId = sent.body.jobId;

  const missing = await api('POST', `/api/v1/conversations/${convId}/messages`, { body: {} });
  await test('400 si le message est vide', () => assert.equal(missing.status, 400));

  const workerNoToken = await api('POST', '/api/v1/worker/claim', { key: null });
  await test('le worker sans jeton est refusé', () => assert.equal(workerNoToken.status, 401));

  // Le worker réclame la tâche
  const claimed = await api('POST', '/api/v1/worker/claim', { key: null, token: WORKER });
  await test('le worker récupère la tâche', () => {
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.job.id, jobId);
    assert.ok(claimed.body.job.composedPrompt.includes('planning'), 'le prompt composé est transmis');
  });

  const empty = await api('POST', '/api/v1/worker/claim', { key: null, token: WORKER });
  await test('204 quand la file est vide', () => assert.equal(empty.status, 204));

  const done = await api('POST', '/api/v1/worker/complete', {
    key: null,
    token: WORKER,
    body: {
      jobId,
      answer: 'Voici ton planning : lundi (client A), mardi (client B)…',
      model: 'GLM-5.3-Flash',
      durationMs: 4200,
      zaiUrl: 'https://chat.z.ai/c/abc123',
    },
  });
  await test('le résultat est enregistré', () => {
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'done');
  });

  const jobView = await api('GET', `/api/v1/jobs/${jobId}`);
  await test('le job expose la réponse', () => {
    assert.equal(jobView.status, 200);
    assert.equal(jobView.body.status, 'done');
    assert.ok(jobView.body.result.answer.includes('planning'));
    assert.equal(jobView.body.durationMs, 4200);
  });

  const afterTurn = await api('GET', `/api/v1/conversations/${convId}`);
  await test('la conversation a mémorisé les 2 messages', () => {
    assert.equal(afterTurn.body.messageCount, 2);
    assert.equal(afterTurn.body.messages[0].role, 'user');
    assert.equal(afterTurn.body.messages[1].role, 'assistant');
    assert.equal(afterTurn.body.stats.turns, 1);
  });

  await test('le titre imposé à la création est conservé', () => {
    assert.equal(afterTurn.body.title, 'Ma première conversation');
  });

  // Une conversation créée sans titre doit s'auto-titrer au premier message.
  const autoConv = await api('POST', '/api/v1/conversations', { body: {} });
  const autoSent = await api('POST', `/api/v1/conversations/${autoConv.body.id}/messages`, {
    body: { message: 'Prépare un budget prévisionnel pour un élevage de poulets.' },
  });
  const autoClaim = await api('POST', '/api/v1/worker/claim', { key: null, token: WORKER });
  await api('POST', '/api/v1/worker/complete', {
    key: null,
    token: WORKER,
    body: { jobId: autoClaim.body.job.id, answer: 'Budget estimé.' },
  });
  const autoView = await api('GET', `/api/v1/conversations/${autoConv.body.id}`);
  await test('une conversation sans titre s\'auto-titre', () => {
    assert.ok(autoSent.status === 202);
    assert.ok(autoView.body.title.toLowerCase().includes('budget'), `titre = ${autoView.body.title}`);
  });

  console.log('\n[4] Mémoire réinjectée dans le prompt suivant');
  const second = await api('POST', `/api/v1/conversations/${convId}/messages`, {
    body: { message: 'Ajoute une révision le dimanche.' },
  });
  const claimed2 = await api('POST', '/api/v1/worker/claim', { key: null, token: WORKER });
  await test('le contexte précédent est bien transmis', () => {
    assert.equal(second.status, 202);
    assert.equal(claimed2.status, 200);
    const prompt = claimed2.body.job.composedPrompt;
    assert.ok(prompt.includes('Rappel des derniers échanges'), 'un rappel est présent');
    assert.ok(prompt.includes('planning'), 'le tour précédent est inclus');
    assert.ok(prompt.includes('dimanche'), 'la nouvelle demande est présente');
  });
  await api('POST', '/api/v1/worker/complete', {
    key: null,
    token: WORKER,
    body: { jobId: claimed2.body.job.id, answer: 'Ajouté au dimanche.' },
  });

  console.log('\n[5] Mode synchrone');
  const syncCall = api('POST', `/api/v1/conversations/${convId}/messages`, {
    body: { message: 'Résume en une phrase.', mode: 'sync' },
  });

  // Simuler un worker qui répond vite
  (async () => {
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const c = await api('POST', '/api/v1/worker/claim', { key: null, token: WORKER });
      if (c.status === 200) {
        await api('POST', '/api/v1/worker/complete', {
          key: null,
          token: WORKER,
          body: { jobId: c.body.job.id, answer: 'Résumé : planning hebdomadaire freelance.' },
        });
        return;
      }
    }
  })();

  const syncRes = await syncCall;
  await test('le mode sync renvoie la réponse directement', () => {
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.status, 'done');
    assert.ok(syncRes.body.answer.includes('Résumé'));
    assert.ok(syncRes.body.conversation);
  });

  console.log('\n[6] Gestion des jobs');
  const jobsList = await api('GET', `/api/v1/jobs?conversationId=${convId}`);
  await test('liste des jobs de la conversation', () => {
    assert.equal(jobsList.status, 200);
    assert.ok(jobsList.body.jobs.length >= 3);
  });

  const job404 = await api('GET', '/api/v1/jobs/job_inexistant');
  await test('404 sur un job inconnu', () => assert.equal(job404.status, 404));

  const cancelJob = await api('POST', `/api/v1/conversations/${convId}/messages`, {
    body: { message: 'Tâche à annuler.' },
  });
  const canceled = await api('DELETE', `/api/v1/jobs/${cancelJob.body.jobId}`);
  await test('annulation d\'un job en file', () => {
    assert.equal(canceled.status, 200);
    assert.equal(canceled.body.status, 'canceled');
  });

  console.log('\n[7] Suppression');
  const del = await api('DELETE', `/api/v1/conversations/${convId}`);
  await test('suppression de la conversation', () => assert.equal(del.status, 200));

  const gone = await api('GET', `/api/v1/conversations/${convId}`);
  await test('elle n\'existe plus', () => assert.equal(gone.status, 404));

  console.log('\n[8] Divers');
  const index = await api('GET', '/api');
  await test('la racine documente les endpoints', () => {
    assert.equal(index.status, 200);
    assert.ok(index.body.endpoints['POST /api/v1/conversations']);
  });

  const badMethod = await api('PUT', `/api/v1/conversations/${convId}`);
  await test('méthode non autorisée → 404 de route ou 405', () =>
    assert.ok([404, 405].includes(badMethod.status)));

  console.log(`\n${ko === 0 ? '✅' : '❌'} ${ok} réussis, ${ko} échoué(s)\n`);
  server.kill();
  process.exit(ko === 0 ? 0 : 1);
})();
