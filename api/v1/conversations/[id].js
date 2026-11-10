/**
 * /api/v1/conversations/:id
 *   GET    → détail (messages inclus)
 *   PATCH  → renommer / changer le prompt système / lier une URL Z.ai
 *   DELETE → supprimer
 */
'use strict';

const { ok, fail, readJson, preflight } = require('../../../lib/http');
const { authenticate } = require('../../../lib/auth');
const store = require('../../../lib/store');
const indexStore = require('../../../lib/index-store');
const views = require('../../../lib/views');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  const auth = authenticate(req);
  if (!auth.ok) return fail(res, 401, 'unauthorized', auth.reason);

  const id = req.query?.id;
  if (!id) return fail(res, 400, 'missing_id', 'Identifiant de conversation manquant.');

  const conv = await store.getConversation(id);
  if (!conv) return fail(res, 404, 'not_found', 'Conversation introuvable.');

  if (req.method === 'GET') {
    const withMessages = req.query?.messages !== 'false';
    const payload = views.conversation(conv);
    if (!withMessages) {
      delete payload.messages;
      payload.messageCount = (conv.messages || []).length;
    }
    return ok(res, payload);
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (typeof body.title === 'string' && body.title.trim()) conv.title = body.title.trim().slice(0, 200);
    if (typeof body.system === 'string') conv.system = body.system;
    if (body.system === null) conv.system = null;
    if (typeof body.zaiUrl === 'string') conv.zaiUrl = body.zaiUrl;
    if (body.zaiUrl === null) conv.zaiUrl = null;
    await store.saveConversation(conv);
    return ok(res, views.conversation(conv));
  }

  if (req.method === 'DELETE') {
    await store.deleteConversation(id);
    await indexStore.remove(auth.name, id);
    return ok(res, { deleted: true, id });
  }

  return fail(res, 405, 'method_not_allowed', 'Utilise GET, PATCH ou DELETE.');
};
