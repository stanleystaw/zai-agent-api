/**
 * /api/v1/worker/complete — le worker renvoie le résultat
 *
 *   POST /api/v1/worker/complete
 *   Authorization: Bearer <WORKER_TOKEN>
 *   {
 *     "jobId": "job_xxx",
 *     "answer": "texte de GLM",
 *     "model": "GLM-5.3-Flash",
 *     "durationMs": 8400,
 *     "zaiUrl": "https://chat.z.ai/c/<id>"   // facultatif : conversation utilisée
 *   }
 *
 *   ou en cas d'échec :  { "jobId": "...", "error": "message" }
 */
'use strict';

const { ok, fail, readJson, bearer, preflight } = require('../../../lib/http');
const store = require('../../../lib/store');
const { recordTurn } = require('../../../lib/agent');
const views = require('../../../lib/views');

function workerAuthorized(req) {
  const token = process.env.WORKER_TOKEN;
  if (!token) return false;
  return bearer(req) === token;
}

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Utilise POST.');

  if (!workerAuthorized(req)) {
    return fail(res, 401, 'unauthorized', 'WORKER_TOKEN invalide ou absent.');
  }

  const body = await readJson(req);
  const jobId = body.jobId || body.job_id;
  if (!jobId) return fail(res, 400, 'missing_job', 'jobId est requis.');

  const job = await store.getJob(jobId);
  if (!job) return fail(res, 404, 'not_found', 'Job introuvable.');

  const ts = new Date().toISOString();

  // ── Échec signalé par le worker ───────────────────────────────
  if (body.error) {
    job.status = 'error';
    job.error = String(body.error).slice(0, 2000);
    job.finishedAt = ts;
    await store.saveJob(job);
    return ok(res, { recorded: true, status: job.status });
  }

  // ── Succès ────────────────────────────────────────────────────
  const answer = String(body.answer || '').trim();
  if (!answer) return fail(res, 400, 'empty_answer', 'Le champ « answer » est vide.');

  job.status = 'done';
  job.result = {
    answer,
    model: body.model || null,
    durationMs: Number(body.durationMs) || null,
  };
  job.finishedAt = ts;
  await store.saveJob(job);

  const conv = await store.getConversation(job.conversationId);
  if (conv) {
    if (body.zaiUrl) conv.zaiUrl = String(body.zaiUrl);
    recordTurn(conv, {
      prompt: job.prompt,
      answer,
      model: body.model || null,
      durationMs: Number(body.durationMs) || 0,
    });
    await store.saveConversation(conv);
  }

  return ok(res, {
    recorded: true,
    status: job.status,
    job: views.job(job),
    conversationId: job.conversationId,
  });
};
