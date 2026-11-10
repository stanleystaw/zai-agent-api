/**
 * /api/v1/worker/claim — le worker réclame la tâche suivante
 *
 * Le worker (navigateur Chromium, sur ta machine) appelle cette route en boucle :
 *   POST /api/v1/worker/claim   Authorization: Bearer <WORKER_TOKEN>
 *   → 200 { job, conversation }  ou  204 (rien à faire)
 *
 * Puis il exécute la tâche et renvoie le résultat sur /api/v1/worker/complete.
 */
'use strict';

const { ok, fail, preflight } = require('../../../lib/http');
const { bearer } = require('../../../lib/http');
const { authenticate } = require('../../../lib/auth');
const store = require('../../../lib/store');
const { composePrompt } = require('../../../lib/agent');

const LEASE_MS = 3 * 60 * 1000; // une tâche réclamée est réservée 3 minutes

function workerAuthorized(req) {
  const token = process.env.WORKER_TOKEN;
  if (!token) return false;
  return bearer(req) === token;
}

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Utilise POST.');

  // Le worker s'authentifie avec WORKER_TOKEN (et non les clés client)
  if (!workerAuthorized(req)) {
    // Tolérance : une clé API classique est également acceptée si ALLOW_CLIENT_AS_WORKER=1
    if (process.env.ALLOW_CLIENT_AS_WORKER === '1' && authenticate(req).ok) {
      /* autorisé */
    } else {
      return fail(res, 401, 'unauthorized', 'WORKER_TOKEN invalide ou absent.');
    }
  }

  // On sort un job de la file
  let jobId = await store.dequeue();
  let guard = 0;
  while (jobId && guard < 20) {
    const job = await store.getJob(jobId);
    if (job && job.status === 'queued') {
      const conv = await store.getConversation(job.conversationId);
      if (!conv) {
        job.status = 'error';
        job.error = 'Conversation supprimée.';
        job.finishedAt = new Date().toISOString();
        await store.saveJob(job);
        jobId = await store.dequeue();
        guard++;
        continue;
      }

      job.status = 'running';
      job.startedAt = new Date().toISOString();
      job.attempt += 1;
      job.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
      // On mémorise le prompt effectivement envoyé (utile pour le debug)
      job.options = job.options || {};
      job.options.composedPrompt = job.options.composedPrompt || composePrompt(conv, job.prompt);
      await store.saveJob(job);

      return ok(res, {
        job: {
          id: job.id,
          conversationId: job.conversationId,
          prompt: job.prompt,
          composedPrompt: job.options.composedPrompt,
          zaiUrl: job.options.zaiUrl || null,
          system: job.options.system || null,
          model: job.options.model || null,
          attempt: job.attempt,
        },
        conversation: {
          id: conv.id,
          title: conv.title,
          zaiUrl: conv.zaiUrl || null,
          messageCount: (conv.messages || []).length,
        },
      });
    }
    jobId = await store.dequeue();
    guard++;
  }

  res.status(204).end();
};
