/**
 * lib/store.js — persistance des conversations et des jobs
 *
 * Deux modes, choisis automatiquement :
 *   1. KV REST (Upstash / Vercel KV) si KV_REST_API_URL + KV_REST_API_TOKEN
 *      → persistant, multi-instances, recommandé en production.
 *   2. Mémoire du processus sinon
 *      → pratique en local, mais perdu au redémarrage.
 *
 * Le stockage est volontairement minimal : des clés JSON, pas de schéma SQL.
 */
'use strict';

const KV_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
const KV_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
const useKv = Boolean(KV_URL && KV_TOKEN);

const memory = globalThis.__zaiStore || (globalThis.__zaiStore = new Map());

const TTL = {
  conversation: 60 * 60 * 24 * 30, // 30 jours
  job: 60 * 60 * 24 * 3, // 3 jours
};

async function kv(command) {
  const url = `${KV_URL}/${command.map((c) => encodeURIComponent(c)).join('/')}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!res.ok) throw new Error(`KV ${res.status}`);
  return (await res.json()).result;
}

async function getRaw(key) {
  if (useKv) {
    try {
      return await kv(['GET', key]);
    } catch (_) {
      /* repli mémoire */
    }
  }
  return memory.get(key) || null;
}

async function setRaw(key, value, ttl) {
  const payload = JSON.stringify(value);
  if (useKv) {
    try {
      await kv(['SET', key, payload, 'EX', String(ttl)]);
      return;
    } catch (_) {
      /* repli mémoire */
    }
  }
  memory.set(key, payload);
}

async function delRaw(key) {
  if (useKv) {
    try {
      await kv(['DEL', key]);
    } catch (_) {
      /* ignore */
    }
  }
  memory.delete(key);
}

async function getJSON(key) {
  const raw = await getRaw(key);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
}

// ── Conversations ───────────────────────────────────────────────
const convKey = (id) => `conv:${id}`;

async function getConversation(id) {
  return getJSON(convKey(id));
}

async function saveConversation(conv) {
  conv.updatedAt = new Date().toISOString();
  await setRaw(convKey(conv.id), conv, TTL.conversation);
  return conv;
}

async function deleteConversation(id) {
  await delRaw(convKey(id));
}

// ── Jobs ────────────────────────────────────────────────────────
const jobKey = (id) => `job:${id}`;

async function getJob(id) {
  return getJSON(jobKey(id));
}

async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  await setRaw(jobKey(job.id), job, TTL.job);
  return job;
}

async function deleteJob(id) {
  await delRaw(jobKey(id));
}

/** File d'attente simple : LPUSH côté API, RPOP côté worker. */
const QUEUE_KEY = 'queue:jobs';

async function enqueue(jobId) {
  if (useKv) {
    try {
      await kv(['LPUSH', QUEUE_KEY, jobId]);
      return;
    } catch (_) {
      /* ignore */
    }
  }
  const q = globalThis.__zaiQueue || (globalThis.__zaiQueue = []);
  q.push(jobId);
}

async function dequeue() {
  if (useKv) {
    try {
      return await kv(['RPOP', QUEUE_KEY]);
    } catch (_) {
      return null;
    }
  }
  const q = globalThis.__zaiQueue || [];
  return q.shift() || null;
}

async function queueLength() {
  if (useKv) {
    try {
      return (await kv(['LLEN', QUEUE_KEY])) || 0;
    } catch (_) {
      return 0;
    }
  }
  return (globalThis.__zaiQueue || []).length;
}

module.exports = {
  backend: useKv ? 'kv' : 'memory',
  getConversation,
  saveConversation,
  deleteConversation,
  getJob,
  saveJob,
  deleteJob,
  enqueue,
  dequeue,
  queueLength,
};
