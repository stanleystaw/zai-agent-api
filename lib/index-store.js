/**
 * lib/index-store.js — index des conversations par utilisateur
 *
 * Séparé du store principal pour rester simple : une clé « index:<user> »
 * qui contient la liste ordonnée des identifiants de conversation.
 */
'use strict';

const store = require('./store');

const MAX_INDEX = 500;

async function load(userId) {
  const raw = await store.getConversation(`__index__${userId}`);
  return Array.isArray(raw?.ids) ? raw.ids : [];
}

async function add(userId, convId) {
  const ids = await load(userId);
  if (ids.includes(convId)) return ids;
  ids.push(convId);
  const trimmed = ids.slice(-MAX_INDEX);
  await store.saveConversation({
    id: `__index__${userId}`,
    ids: trimmed,
    createdAt: new Date().toISOString(),
  });
  return trimmed;
}

async function remove(userId, convId) {
  const ids = (await load(userId)).filter((i) => i !== convId);
  await store.saveConversation({
    id: `__index__${userId}`,
    ids,
    createdAt: new Date().toISOString(),
  });
  return ids;
}

module.exports = { load, add, remove };
