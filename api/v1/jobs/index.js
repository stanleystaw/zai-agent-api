/**
 * /api/v1/jobs
 *   GET  → liste les jobs (filtré par conversationId si fourni)
 *   POST → crée un job sans passer par /conversations/:id/messages
 */
'use strict';

const { ok, fail, readJson, preflight } = require('../../../lib/http');
const { authenticate } = require('../../../lib/auth');
const { newJob, composePrompt } = require('../../../lib/agent');
const store = require('../../../lib/store');
const indexStore = require('../../../lib/index-store');
const views = require('../../../lib/views');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  const auth = authenticate(req);
  if (!auth.ok) return fail(res, 401, 'unauthorized', auth.reason);

  if (req.method === 'GET') {
    const convFilter = req.query?.conversationId || null;

    // On part des conversations de l'utilisateur : chaque conversation
    // garde la liste de ses jobs (conv.jobIds), ce qui reste valable en KV.
    const convIds = convFilter ? [convFilter] : await indexStore.load(auth.name);
    const jobs = [];
    for (const cid of convIds) {
      const conv = await store.getConversation(cid);
      if (!conv || !Array.isArray(conv.jobIds)) continue;
      for (const jid of conv.jobIds.slice(-50)) {
        const j = await store.getJob(jid);
        if (j) jobs.push(views.job(j));
      }
    }
    jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const limit = Math.min(Number(req.query?.limit) || 50, 200);

    return ok(res, {
      backend: store.backend,
      queueLength: await store.queueLength(),
      count: jobs.length,
      jobs: jobs.slice(0, limit),
    });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const convId = body.conversationId;
    const message = String(body.message || body.prompt || '').trim();
    if (!convId) return fail(res, 400, 'missing_conversation', 'conversationId est requis.');
    if (!message) return fail(res, 400, 'missing_message', 'Le champ « message » est requis.');

    const conv = await store.getConversation(convId);
    if (!conv) return fail(res, 404, 'conversation_not_found', 'Conversation introuvable.');

    const job = newJob({
      conversationId: convId,
      prompt: message,
      options: {
        zaiUrl: conv.zaiUrl || null,
        system: conv.system || null,
        composedPrompt: composePrompt(conv, message),
        model: body.model || null,
      },
    });
    await store.saveJob(job);

    conv.jobIds = [...(conv.jobIds || []), job.id].slice(-100);
    conv.stats.jobs = (conv.stats.jobs || 0) + 1;
    await store.saveConversation(conv);

    await store.enqueue(job.id);

    return ok(res, { jobId: job.id, status: job.status, pollUrl: `/api/v1/jobs/${job.id}` }, 202);
  }

  return fail(res, 405, 'method_not_allowed', 'Utilise GET ou POST.');
};
