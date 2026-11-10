/**
 * /api/v1/conversations
 *   GET  → liste les conversations de l'utilisateur
 *   POST → crée une conversation
 */
'use strict';

const { ok, fail, readJson, preflight } = require('../../../lib/http');
const { authenticate } = require('../../../lib/auth');
const { newConversation } = require('../../../lib/agent');
const store = require('../../../lib/store');
const indexStore = require('../../../lib/index-store');
const views = require('../../../lib/views');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  const auth = authenticate(req);
  if (!auth.ok) return fail(res, 401, 'unauthorized', auth.reason);
  const userId = auth.name;

  if (req.method === 'GET') {
    const ids = await indexStore.load(userId);
    const items = [];
    for (const id of ids) {
      const c = await store.getConversation(id);
      if (c) items.push(views.conversationSummary(c));
    }
    items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

    const limit = Math.min(Number(req.query?.limit) || 50, 200);
    return ok(res, {
      backend: store.backend,
      count: items.length,
      conversations: items.slice(0, limit),
    });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (body.title && String(body.title).length > 200) {
      return fail(res, 400, 'invalid_title', 'Le titre ne doit pas dépasser 200 caractères.');
    }
    const conv = newConversation({
      title: body.title || null,
      system: body.system || null,
      zaiUrl: body.zaiUrl || body.zai_url || null,
    });
    await store.saveConversation(conv);
    await indexStore.add(userId, conv.id);
    return ok(res, views.conversation(conv), 201);
  }

  return fail(res, 405, 'method_not_allowed', 'Utilise GET ou POST.');
};
