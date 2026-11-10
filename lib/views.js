/**
 * lib/views.js — vues publiques (ce que l'API renvoie)
 */
'use strict';

function conversation(c) {
  if (!c) return null;
  return {
    id: c.id,
    title: c.title,
    system: c.system || null,
    zaiUrl: c.zaiUrl || null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    stats: c.stats || { turns: 0, jobs: 0, inputChars: 0, outputChars: 0 },
    summary: c.summary || null,
    messageCount: (c.messages || []).length,
    messages: c.messages || [],
  };
}

/** Version courte pour les listes. */
function conversationSummary(c) {
  const msgs = c.messages || [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    turns: c.stats?.turns || 0,
    zaiUrl: c.zaiUrl || null,
    lastMessage: last ? String(last.content).slice(0, 140) : null,
  };
}

function job(j) {
  if (!j) return null;

  // Durée : on privilégie la mesure du worker (temps réel de génération GLM),
  // et à défaut l'écart entre début et fin côté serveur.
  let durationMs = null;
  if (j.result && typeof j.result.durationMs === 'number') {
    durationMs = j.result.durationMs;
  } else if (j.startedAt && j.finishedAt) {
    durationMs = new Date(j.finishedAt) - new Date(j.startedAt);
  }

  return {
    id: j.id,
    conversationId: j.conversationId,
    status: j.status,
    prompt: j.prompt,
    steps: j.steps,
    result: j.result,
    error: j.error,
    attempt: j.attempt,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    durationMs,
  };
}

module.exports = { conversation, conversationSummary, job };
