/**
 * lib/agent.js — cœur agentique : mémoire, plan, exécution
 *
 * Ce module tourne côté API (Vercel) et ne touche jamais au navigateur :
 * il décide QUOI faire. L'exécution (aller sur chat.z.ai) est confiée au worker
 * sous forme de « commandes » sérialisables.
 */
'use strict';

const crypto = require('crypto');

const MAX_CONTEXT_MESSAGES = 20;
const MAX_SUMMARY_CHARS = 1800;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function nowIso() {
  return new Date().toISOString();
}

/** Conversation vide conforme au schéma de l'API. */
function newConversation({ title = null, system = null, zaiUrl = null } = {}) {
  const ts = nowIso();
  return {
    id: newId('conv'),
    title: title || 'Nouvelle conversation',
    system: system || null,
    zaiUrl: zaiUrl || null,
    createdAt: ts,
    updatedAt: ts,
    messages: [],
    summary: null,
    stats: { turns: 0, jobs: 0, inputChars: 0, outputChars: 0 },
    meta: {},
  };
}

/**
 * Réduit l'historique pour ne garder que ce qui est utile au modèle.
 * Priorité : résumé compact + derniers messages.
 */
function buildContext(conversation) {
  const msgs = conversation.messages || [];
  const recent = msgs.slice(-MAX_CONTEXT_MESSAGES);
  const parts = [];
  if (conversation.summary) {
    parts.push({ role: 'system', content: `Résumé de la conversation jusqu'ici :\n${conversation.summary}` });
  }
  for (const m of recent) {
    parts.push({ role: m.role, content: m.content });
  }
  return parts;
}

/**
 * Compose le texte à envoyer dans le chat Z.ai.
 * La mémoire est réinjectée de façon compacte : le modèle retrouve le fil
 * même si la conversation Z.ai n'a pas suivie.
 */
function composePrompt(conversation, userText) {
  const msgs = conversation.messages || [];
  const isFirst = msgs.length === 0;
  if (isFirst && !conversation.summary && !conversation.system) return userText;

  const lines = [];
  if (conversation.system) lines.push(conversation.system);
  if (conversation.summary) lines.push(`Contexte déjà évoqué : ${conversation.summary}`);
  if (!isFirst) {
    const recent = msgs.slice(-6);
    const rewind = recent.map((m) => `${m.role === 'user' ? 'Moi' : 'Toi'} : ${truncate(m.content, 260)}`).join('\n');
    lines.push(`Rappel des derniers échanges :\n${rewind}`);
  }
  lines.push(`Nouvelle demande :\n${userText}`);
  return lines.filter(Boolean).join('\n\n');
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Titre lisible déduit de la première demande. */
function deriveTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Nouvelle conversation';
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

/**
 * Plan d'action minimal mais réel : on découpe les demandes multi-étapes
 * en sous-tâches explicites, ce que le worker exécutera dans l'ordre.
 */
function planSteps(text) {
  const t = String(text || '');
  const multi = /\n\s*[-*\d]/.test(t) || (t.match(/[.;]\s*(ensuite|puis|après|then|next)/gi) || []).length > 0;
  if (!multi) return [{ index: 1, instruction: t, done: false }];

  const pieces = t
    .split(/\n|(?<=[.;])\s+(?=(ensuite|puis|après|then|next)\b)/i)
    .map((s) => s.replace(/^\s*[-*\d.)]+\s*/, '').trim())
    .filter((s) => s.length > 3);

  return (pieces.length > 1 ? pieces : [t]).map((instruction, i) => ({
    index: i + 1,
    instruction,
    done: false,
  }));
}

function newJob({ conversationId, prompt, options = {} }) {
  const ts = nowIso();
  return {
    id: newId('job'),
    conversationId,
    prompt,
    status: 'queued', // queued | running | done | error | canceled
    steps: planSteps(prompt),
    options,
    result: null,
    error: null,
    attempt: 0,
    createdAt: ts,
    updatedAt: ts,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * Enregistre la réponse du modèle dans la conversation et met à jour les compteurs.
 */
function recordTurn(conversation, { prompt, answer, model = null, durationMs = 0 }) {
  const ts = nowIso();
  conversation.messages.push({ role: 'user', content: prompt, at: ts });
  conversation.messages.push({ role: 'assistant', content: answer, at: ts, model, durationMs });
  conversation.stats.turns += 1;
  conversation.stats.inputChars += prompt.length;
  conversation.stats.outputChars += answer.length;

  if (conversation.messages.length > 80) {
    const older = conversation.messages.slice(0, -40);
    conversation.summary = summarize(older, conversation.summary);
    conversation.messages = conversation.messages.slice(-40);
  }
  // Le titre est déduit du premier message, sauf si l'utilisateur en a imposé un.
  if (!conversation.titleAuto && (!conversation.title || conversation.title === 'Nouvelle conversation')) {
    conversation.title = deriveTitle(prompt);
    conversation.titleAuto = true;
  }
  conversation.updatedAt = ts;
  return conversation;
}

/** Résumé cumulatif très simple (sans appel LLM) pour borner le contexte. */
function summarize(messages, previous) {
  const lines = messages
    .filter((m) => m.role === 'user')
    .map((m) => `- ${truncate(m.content.replace(/\s+/g, ' '), 120)}`);
  const merged = [previous, ...lines].filter(Boolean).join('\n');
  return truncate(merged, MAX_SUMMARY_CHARS);
}

module.exports = {
  newId,
  newConversation,
  newJob,
  buildContext,
  composePrompt,
  deriveTitle,
  planSteps,
  recordTurn,
  summarize,
  truncate,
  MAX_CONTEXT_MESSAGES,
};
