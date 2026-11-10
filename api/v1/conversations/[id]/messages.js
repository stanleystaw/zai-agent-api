/**
 * /api/v1/conversations/:id/messages
 *   GET  → historique complet
 *   POST → envoie une demande (mode synchrone ou asynchrone)
 *
 * Corps accepté :
 * {
 *   "message": "texte",
 *   "mode": "async" | "sync",   // async par défaut
 *   "zaiUrl": "https://chat.z.ai/c/<id>"  // optionnel : réutiliser une conversation existante
 * }
 *
 *   async → renvoie 202 + un job à interroger sur /api/v1/jobs/:id
 *   sync  → attend la réponse du worker (max ~25 s) ; au-delà renvoie le job
 */
'use strict';

const { ok, fail, readJson, preflight } = require('../../../../lib/http');
const { authenticate } = require('../../../../lib/auth');
const { newJob, composePrompt, planSteps } = require('../../../../lib/agent');
const store = require('../../../../lib/store');
const views = require('../../../../lib/views');

const SYNC_WAIT_MS = Number(process.env.SYNC_WAIT_MS || 25000);
const POLL_MS = 700;

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  const auth = authenticate(req);
  if (!auth.ok) return fail(res, 401, 'unauthorized', auth.reason);

  const id = req.query?.id;
  if (!id) return fail(res, 400, 'missing_id', 'Identifiant de conversation manquant.');

  const conv = await store.getConversation(id);
  if (!conv) return fail(res, 404, 'not_found', 'Conversation introuvable.');

  if (req.method === 'GET') {
    return ok(res, {
      conversationId: conv.id,
      count: (conv.messages || []).length,
      messages: conv.messages || [],
      summary: conv.summary || null,
    });
  }

  if (req.method !== 'POST') {
    return fail(res, 405, 'method_not_allowed', 'Utilise GET ou POST.');
  }

  const body = await readJson(req);
  const userMessage = String(body.message || body.prompt || '').trim();
  if (!userMessage) return fail(res, 400, 'missing_message', 'Le champ « message » est requis.');
  if (userMessage.length > 20000) {
    return fail(res, 400, 'message_too_long', 'Message limité à 20 000 caractères.');
  }

  // Réutilisation d'une conversation Z.ai existante
  if (body.zaiUrl || body.zai_url) {
    conv.zaiUrl = String(body.zaiUrl || body.zai_url);
  }
  if (body.system !== undefined && body.system !== null) {
    conv.system = String(body.system);
  }
  await store.saveConversation(conv);

  const mode = body.mode === 'sync' ? 'sync' : 'async';

  const job = newJob({
    conversationId: conv.id,
    prompt: userMessage,
    options: {
      zaiUrl: conv.zaiUrl || null,
      system: conv.system || null,
      composedPrompt: composePrompt(conv, userMessage),
      model: body.model || null,
    },
  });
  job.mode = mode;
  await store.saveJob(job);

  conv.jobIds = [...(conv.jobIds || []), job.id].slice(-100);
  conv.stats.jobs += 1;
  await store.saveConversation(conv);

  await store.enqueue(job.id);

  if (mode === 'async') {
    return ok(
      res,
      {
        jobId: job.id,
        status: job.status,
        conversationId: conv.id,
        steps: job.steps,
        pollUrl: `/api/v1/jobs/${job.id}`,
        hint: 'Interroge pollUrl toutes les 1-2 s jusqu\'à status = done.',
      },
      202
    );
  }

  // Mode synchrone : on attend que le worker termine (borné)
  const deadline = Date.now() + SYNC_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const current = await store.getJob(job.id);
    if (!current) break;
    if (current.status === 'done') {
      const updated = await store.getConversation(conv.id);
      return ok(res, {
        status: 'done',
        jobId: job.id,
        conversationId: conv.id,
        answer: current.result?.answer || null,
        model: current.result?.model || null,
        durationMs: current.result?.durationMs || null,
        conversation: views.conversation(updated),
      });
    }
    if (current.status === 'error') {
      return fail(res, 502, 'worker_error', current.error || 'Le worker a échoué.', {
        jobId: job.id,
        conversationId: conv.id,
      });
    }
  }

  return ok(
    res,
    {
      status: 'pending',
      jobId: job.id,
      conversationId: conv.id,
      pollUrl: `/api/v1/jobs/${job.id}`,
      message:
        'Le worker n\'a pas répondu dans le délai imparti. La tâche reste en file : interroge pollUrl.',
    },
    202
  );
};
