/**
 * lib/http.js — utilitaires HTTP communs à toutes les routes
 */
'use strict';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
}

function send(res, status, body) {
  cors(res);
  res.status(status).json(body);
}

function fail(res, status, code, message, extra = {}) {
  return send(res, status, { error: { code, message, ...extra } });
}

function ok(res, data, status = 200) {
  return send(res, status, data);
}

/** Lit le corps JSON quelle que soit la façon dont l'hébergeur le fournit. */
async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }
  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString('utf8'));
    } catch (_) {
      return {};
    }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** Extrait le jeton porteur. */
function bearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function preflight(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = { send, ok, fail, readJson, bearer, preflight, cors };
