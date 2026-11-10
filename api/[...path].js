/**
 * GLM Agent API — routeur catch-all Vercel : /api/v1/* → ce fichier
 * (version mono-fichier, sans dépendance ni configuration JSON)
 */
'use strict';

const crypto = require('crypto');

// ── Stockage ────────────────────────────────────────────────────
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useKv = Boolean(KV_URL && KV_TOKEN);
const mem = globalThis.__S || (globalThis.__S = new Map());
const queue = globalThis.__Q || (globalThis.__Q = []);

async function kv(cmd) {
  const r = await fetch(KV_URL + '/' + cmd.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + KV_TOKEN },
  });
  if (!r.ok) throw new Error('kv');
  return (await r.json()).result;
}
async function get(key) {
  if (useKv) { try { const v = await kv(['GET', key]); if (v) return JSON.parse(v); } catch (_) {} }
  const v = mem.get(key);
  return v ? JSON.parse(v) : null;
}
async function set(key, val, ttl) {
  const s = JSON.stringify(val);
  if (useKv) { try { await kv(['SET', key, s, 'EX', String(ttl)]); return; } catch (_) {} }
  mem.set(key, s);
}
async function del(key) {
  if (useKv) { try { await kv(['DEL', key]); } catch (_) {} }
  mem.delete(key);
}
async function push(id) {
  if (useKv) { try { await kv(['LPUSH', 'queue:jobs', id]); return; } catch (_) {} }
  queue.push(id);
}
async function pop() {
  if (useKv) { try { return await kv(['RPOP', 'queue:jobs']); } catch (_) { return null; } }
  return queue.shift() || null;
}
async function qlen() {
  if (useKv) { try { return (await kv(['LLEN', 'queue:jobs'])) || 0; } catch (_) { return 0; } }
  return queue.length;
}

const TTL_CONV = 2592000;
const TTL_JOB = 259200;

// ── Modèle ──────────────────────────────────────────────────────
const nid = (p) => p + '_' + crypto.randomBytes(9).toString('base64url');
const now = () => new Date().toISOString();

function newConv(o) {
  const t = now();
  return {
    id: nid('conv'),
    title: o.title || 'Nouvelle conversation',
    system: o.system || null,
    zaiUrl: o.zaiUrl || null,
    createdAt: t, updatedAt: t,
    messages: [], summary: null, jobIds: [],
    stats: { turns: 0, jobs: 0, inputChars: 0, outputChars: 0 },
  };
}

function composePrompt(c, text) {
  const m = c.messages || [];
  if (!m.length && !c.summary && !c.system) return text;
  const out = [];
  if (c.system) out.push(c.system);
  if (c.summary) out.push('Contexte deja evoque : ' + c.summary);
  if (m.length) {
    const r = m.slice(-6).map((x) => (x.role === 'user' ? 'Moi' : 'Toi') + ' : ' + String(x.content).slice(0, 260));
    out.push('Rappel des derniers echanges :\n' + r.join('\n'));
  }
  out.push('Nouvelle demande :\n' + text);
  return out.join('\n\n');
}

function recordTurn(c, o) {
  const t = now();
  c.messages.push({ role: 'user', content: o.prompt, at: t });
  c.messages.push({ role: 'assistant', content: o.answer, at: t, model: o.model || null, durationMs: o.durationMs || 0 });
  c.stats.turns += 1;
  c.stats.inputChars += o.prompt.length;
  c.stats.outputChars += o.answer.length;
  if (!c.titleAuto && (!c.title || c.title === 'Nouvelle conversation')) {
    c.title = o.prompt.replace(/\s+/g, ' ').slice(0, 60);
    c.titleAuto = true;
  }
  c.updatedAt = t;
}

const convView = (c) => ({
  id: c.id, title: c.title, system: c.system || null, zaiUrl: c.zaiUrl || null,
  createdAt: c.createdAt, updatedAt: c.updatedAt, stats: c.stats,
  summary: c.summary || null, messageCount: (c.messages || []).length,
  messages: c.messages || [],
});

const convBrief = (c) => {
  const m = c.messages || [];
  const last = m.length ? m[m.length - 1] : null;
  return {
    id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
    turns: (c.stats && c.stats.turns) || 0, zaiUrl: c.zaiUrl || null,
    lastMessage: last ? String(last.content).slice(0, 140) : null,
  };
};

const jobView = (j) => {
  const d = j.result && typeof j.result.durationMs === 'number'
    ? j.result.durationMs
    : (j.startedAt && j.finishedAt ? new Date(j.finishedAt) - new Date(j.startedAt) : null);
  return {
    id: j.id, conversationId: j.conversationId, status: j.status, prompt: j.prompt,
    result: j.result, error: j.error, attempt: j.attempt,
    createdAt: j.createdAt, updatedAt: j.updatedAt,
    startedAt: j.startedAt, finishedAt: j.finishedAt, durationMs: d,
  };
};

// ── HTTP ────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
}
const send = (res, code, b) => { cors(res); res.status(code).json(b); };
const ok = (res, b, c) => send(res, c || 200, b);
const fail = (res, c, code, msg, extra) => send(res, c, { error: Object.assign({ code: code, message: msg }, extra || {}) });

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return {}; } }
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function bearer(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function authClient(req) {
  const keys = String(process.env.API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!keys.length) {
    return process.env.ALLOW_ANONYMOUS === '1'
      ? { ok: true, name: 'anonymous' }
      : { ok: false, reason: 'API_KEYS non configuree' };
  }
  const t = bearer(req);
  if (!t) return { ok: false, reason: 'Authorization: Bearer manquant' };
  for (let i = 0; i < keys.length; i++) {
    const a = Buffer.from(t), b = Buffer.from(keys[i]);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true, name: 'key-' + (i + 1) };
  }
  return { ok: false, reason: 'cle API invalide' };
}

const authWorker = (req) => Boolean(process.env.WORKER_TOKEN) && bearer(req) === process.env.WORKER_TOKEN;

const idxKey = (u) => 'index:' + u;
async function idxLoad(u) {
  const r = await get(idxKey(u));
  return r && Array.isArray(r.ids) ? r.ids : [];
}
async function idxAdd(u, id) {
  const ids = await idxLoad(u);
  if (ids.indexOf(id) === -1) ids.push(id);
  await set(idxKey(u), { ids: ids.slice(-500) }, TTL_CONV);
}

/** Extrait les segments de chemin (compatible catch-all Vercel et ?path=). */
function segments(req) {
  const raw = req.query && req.query.path;
  let parts = [];
  if (Array.isArray(raw)) parts = raw;
  else if (typeof raw === 'string' && raw) parts = raw.split('/');
  else {
    const p = String(req.url || '').split('?')[0].replace(/^\/api\/?/, '');
    parts = p.split('/');
  }
  parts = parts.filter(Boolean);
  if (parts[0] === 'v1') parts = parts.slice(1);
  return parts;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { cors(res); return res.status(204).end(); }

  const seg = segments(req);

  // ── santé ────────────────────────────────────────────────────
  if (seg[0] === 'health' && req.method === 'GET') {
    return ok(res, {
      status: 'ok', time: now(), storage: useKv ? 'kv' : 'memory', queueLength: await qlen(),
      env: {
        API_KEYS: Boolean(process.env.API_KEYS),
        WORKER_TOKEN: Boolean(process.env.WORKER_TOKEN),
        KV: useKv,
      },
      note: useKv ? 'Stockage KV persistant actif.'
        : 'Stockage memoire : ajoute KV_REST_API_URL et KV_REST_API_TOKEN.',
    });
  }

  // ── worker ───────────────────────────────────────────────────
  if (seg[0] === 'worker') {
    if (!authWorker(req)) return fail(res, 401, 'unauthorized', 'WORKER_TOKEN invalide ou absent.');

    if (seg[1] === 'claim' && req.method === 'POST') {
      for (let i = 0; i < 20; i++) {
        const id = await pop();
        if (!id) break;
        const job = await get('job:' + id);
        if (!job || job.status !== 'queued') continue;
        const conv = await get('conv:' + job.conversationId);
        if (!conv) {
          job.status = 'error'; job.error = 'Conversation supprimee.';
          job.finishedAt = now();
          await set('job:' + id, job, TTL_JOB);
          continue;
        }
        job.status = 'running';
        job.startedAt = now();
        job.attempt = (job.attempt || 0) + 1;
        job.options = job.options || {};
        await set('job:' + id, job, TTL_JOB);
        return ok(res, {
          job: {
            id: job.id, conversationId: job.conversationId, prompt: job.prompt,
            composedPrompt: job.options.composedPrompt || composePrompt(conv, job.prompt),
            zaiUrl: job.options.zaiUrl || null, attempt: job.attempt,
          },
          conversation: {
            id: conv.id, title: conv.title, zaiUrl: conv.zaiUrl || null,
            messageCount: (conv.messages || []).length,
          },
        });
      }
      return res.status(204).end();
    }

    if (seg[1] === 'complete' && req.method === 'POST') {
      const b = await readBody(req);
      const id = b.jobId || b.job_id;
      if (!id) return fail(res, 400, 'missing_job', 'jobId est requis.');
      const job = await get('job:' + id);
      if (!job) return fail(res, 404, 'not_found', 'Job introuvable.');

      if (b.error) {
        job.status = 'error';
        job.error = String(b.error).slice(0, 2000);
        job.finishedAt = now();
        await set('job:' + id, job, TTL_JOB);
        return ok(res, { recorded: true, status: job.status });
      }

      const answer = String(b.answer || '').trim();
      if (!answer) return fail(res, 400, 'empty_answer', 'Le champ answer est vide.');
      job.status = 'done';
      job.result = { answer: answer, model: b.model || null, durationMs: Number(b.durationMs) || null };
      job.finishedAt = now();
      await set('job:' + id, job, TTL_JOB);

      const conv = await get('conv:' + job.conversationId);
      if (conv) {
        if (b.zaiUrl) conv.zaiUrl = String(b.zaiUrl);
        recordTurn(conv, { prompt: job.prompt, answer: answer, model: b.model, durationMs: Number(b.durationMs) });
        await set('conv:' + conv.id, conv, TTL_CONV);
      }
      return ok(res, { recorded: true, status: job.status, job: jobView(job), conversationId: job.conversationId });
    }

    return fail(res, 404, 'not_found', 'Route worker inconnue.');
  }

  // ── auth client ──────────────────────────────────────────────
  const a = authClient(req);
  if (!a.ok) return fail(res, 401, 'unauthorized', a.reason);
  const user = a.name;

  // ── conversations ────────────────────────────────────────────
  if (seg[0] === 'conversations') {
    if (seg.length === 1) {
      if (req.method === 'GET') {
        const items = [];
        const ids = await idxLoad(user);
        for (const id of ids) {
          const c = await get('conv:' + id);
          if (c) items.push(convBrief(c));
        }
        items.sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
        return ok(res, { backend: useKv ? 'kv' : 'memory', count: items.length, conversations: items.slice(0, 200) });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const c = newConv({ title: b.title, system: b.system, zaiUrl: b.zaiUrl || b.zai_url });
        await set('conv:' + c.id, c, TTL_CONV);
        await idxAdd(user, c.id);
        return ok(res, convView(c), 201);
      }
      return fail(res, 405, 'method_not_allowed', 'Utilise GET ou POST.');
    }

    const id = decodeURIComponent(seg[1]);
    const conv = await get('conv:' + id);
    if (!conv) return fail(res, 404, 'not_found', 'Conversation introuvable.');

    // /conversations/:id/messages
    if (seg[2] === 'messages') {
      if (req.method === 'GET') {
        return ok(res, {
          conversationId: conv.id, count: (conv.messages || []).length,
          messages: conv.messages || [], summary: conv.summary || null,
        });
      }
      if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Utilise GET ou POST.');

      const b = await readBody(req);
      const message = String(b.message || b.prompt || '').trim();
      if (!message) return fail(res, 400, 'missing_message', 'Le champ message est requis.');
      if (message.length > 20000) return fail(res, 400, 'message_too_long', 'Message limite a 20 000 caracteres.');

      if (b.zaiUrl || b.zai_url) conv.zaiUrl = String(b.zaiUrl || b.zai_url);
      if (typeof b.system === 'string') conv.system = b.system;
      await set('conv:' + conv.id, conv, TTL_CONV);

      const job = {
        id: nid('job'), conversationId: conv.id, prompt: message, status: 'queued',
        options: { zaiUrl: conv.zaiUrl || null, composedPrompt: composePrompt(conv, message) },
        result: null, error: null, attempt: 0,
        createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      };
      await set('job:' + job.id, job, TTL_JOB);
      conv.jobIds = (conv.jobIds || []).concat([job.id]).slice(-100);
      conv.stats.jobs += 1;
      await set('conv:' + conv.id, conv, TTL_CONV);
      await push(job.id);

      const mode = b.mode === 'sync' ? 'sync' : 'async';
      if (mode === 'async') {
        return ok(res, {
          jobId: job.id, status: 'queued', conversationId: conv.id,
          pollUrl: '/api/v1/jobs/' + job.id,
          hint: 'Interroge pollUrl toutes les 1-2 s.',
        }, 202);
      }

      const deadline = Date.now() + Number(process.env.SYNC_WAIT_MS || 25000);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 700));
        const cur = await get('job:' + job.id);
        if (!cur) break;
        if (cur.status === 'done') {
          const c2 = await get('conv:' + conv.id);
          return ok(res, {
            status: 'done', jobId: job.id,
            answer: cur.result ? cur.result.answer : null,
            model: cur.result ? cur.result.model : null,
            durationMs: cur.result ? cur.result.durationMs : null,
            conversation: convView(c2),
          });
        }
        if (cur.status === 'error') {
          return fail(res, 502, 'worker_error', cur.error || 'Le worker a echoue.', { jobId: job.id });
        }
      }
      return ok(res, {
        status: 'pending', jobId: job.id, pollUrl: '/api/v1/jobs/' + job.id,
        message: 'Tache toujours en file : interroge pollUrl.',
      }, 202);
    }

    if (req.method === 'GET') return ok(res, convView(conv));

    if (req.method === 'PATCH') {
      const b = await readBody(req);
      if (typeof b.title === 'string' && b.title.trim()) { conv.title = b.title.trim().slice(0, 200); conv.titleAuto = true; }
      if (typeof b.system === 'string') conv.system = b.system;
      if (b.system === null) conv.system = null;
      if (typeof b.zaiUrl === 'string') conv.zaiUrl = b.zaiUrl;
      if (b.zaiUrl === null) conv.zaiUrl = null;
      await set('conv:' + conv.id, conv, TTL_CONV);
      return ok(res, convView(conv));
    }

    if (req.method === 'DELETE') {
      await del('conv:' + conv.id);
      const ids = (await idxLoad(user)).filter((x) => x !== id);
      await set(idxKey(user), { ids: ids }, TTL_CONV);
      return ok(res, { deleted: true, id: id });
    }

    return fail(res, 405, 'method_not_allowed', 'Utilise GET, PATCH ou DELETE.');
  }

  // ── jobs ─────────────────────────────────────────────────────
  if (seg[0] === 'jobs') {
    if (seg.length === 1) {
      if (req.method === 'GET') {
        const filter = req.query && req.query.conversationId;
        const convIds = filter ? [filter] : await idxLoad(user);
        const jobs = [];
        for (const cid of convIds) {
          const c = await get('conv:' + cid);
          if (!c || !Array.isArray(c.jobIds)) continue;
          const slice = c.jobIds.slice(-50);
          for (const jid of slice) {
            const j = await get('job:' + jid);
            if (j) jobs.push(jobView(j));
          }
        }
        jobs.sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
        return ok(res, {
          backend: useKv ? 'kv' : 'memory', queueLength: await qlen(),
          count: jobs.length, jobs: jobs.slice(0, 200),
        });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (!b.conversationId) return fail(res, 400, 'missing_conversation', 'conversationId est requis.');
        const message = String(b.message || b.prompt || '').trim();
        if (!message) return fail(res, 400, 'missing_message', 'Le champ message est requis.');
        const conv = await get('conv:' + b.conversationId);
        if (!conv) return fail(res, 404, 'conversation_not_found', 'Conversation introuvable.');

        const job = {
          id: nid('job'), conversationId: conv.id, prompt: message, status: 'queued',
          options: { zaiUrl: conv.zaiUrl || null, composedPrompt: composePrompt(conv, message) },
          result: null, error: null, attempt: 0,
          createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
        };
        await set('job:' + job.id, job, TTL_JOB);
        conv.jobIds = (conv.jobIds || []).concat([job.id]).slice(-100);
        conv.stats.jobs += 1;
        await set('conv:' + conv.id, conv, TTL_CONV);
        await push(job.id);
        return ok(res, { jobId: job.id, status: 'queued', pollUrl: '/api/v1/jobs/' + job.id }, 202);
      }
      return fail(res, 405, 'method_not_allowed', 'Utilise GET ou POST.');
    }

    const id = decodeURIComponent(seg[1]);
    const job = await get('job:' + id);
    if (!job) return fail(res, 404, 'not_found', 'Job introuvable (ou expire).');

    if (req.method === 'GET') {
      const v = jobView(job);
      v.queuePosition = job.status === 'queued' ? await qlen() : null;
      return ok(res, v);
    }
    if (req.method === 'DELETE') {
      if (job.status === 'done' || job.status === 'error') {
        return fail(res, 409, 'already_finished', 'Job deja termine (' + job.status + ').');
      }
      job.status = 'canceled';
      job.finishedAt = now();
      await set('job:' + id, job, TTL_JOB);
      return ok(res, jobView(job));
    }
    return fail(res, 405, 'method_not_allowed', 'Utilise GET ou DELETE.');
  }

  // ── index ────────────────────────────────────────────────────
  if (!seg.length) {
    return ok(res, {
      name: 'GLM Agent API', version: '1.0.0', storage: useKv ? 'kv' : 'memory',
      endpoints: [
        'GET /api/v1/health',
        'GET|POST /api/v1/conversations',
        'GET|PATCH|DELETE /api/v1/conversations/:id',
        'GET|POST /api/v1/conversations/:id/messages',
        'GET|POST /api/v1/jobs',
        'GET|DELETE /api/v1/jobs/:id',
        'POST /api/v1/worker/claim',
        'POST /api/v1/worker/complete',
      ],
      auth: 'Authorization: Bearer <API_KEY>',
    });
  }

  return fail(res, 404, 'not_found', 'Route inconnue : /' + seg.join('/'));
};
