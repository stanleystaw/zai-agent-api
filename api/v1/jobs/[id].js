/**
 * /api/v1/jobs/:id
 *   GET    → état du job (+ réponse si terminé)
 *   DELETE → annuler si encore en file
 */
'use strict';

const { ok, fail, preflight } = require('../../../lib/http');
const { authenticate } = require('../../../lib/auth');
const store = require('../../../lib/store');
const views = require('../../../lib/views');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  const auth = authenticate(req);
  if (!auth.ok) return fail(res, 401, 'unauthorized', auth.reason);

  const id = req.query?.id;
  if (!id) return fail(res, 400, 'missing_id', 'Identifiant de job manquant.');

  const job = await store.getJob(id);
  if (!job) return fail(res, 404, 'not_found', 'Job introuvable (ou expiré après 3 jours).');

  if (req.method === 'GET') {
    const payload = views.job(job);
    payload.queuePosition =
      job.status === 'queued' ? await store.queueLength() : null;
    return ok(res, payload);
  }

  if (req.method === 'DELETE') {
    if (job.status === 'done' || job.status === 'error') {
      return fail(res, 409, 'already_finished', `Job déjà terminé (${job.status}).`);
    }
    job.status = 'canceled';
    job.finishedAt = new Date().toISOString();
    await store.saveJob(job);
    return ok(res, views.job(job));
  }

  return fail(res, 405, 'method_not_allowed', 'Utilise GET ou DELETE.');
};
