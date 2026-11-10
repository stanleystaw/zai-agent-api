/**
 * lib/auth.js — authentification par clé d'API
 *
 * En-tête attendu :  Authorization: Bearer <API_KEY>
 * Les clés sont fournies via la variable d'environnement API_KEYS
 * (plusieurs clés séparées par des virgules).
 */
'use strict';

const crypto = require('crypto');
const { bearer } = require('./http');

function configuredKeys() {
  return String(process.env.API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Comparaison à temps constant pour éviter les attaques temporelles. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @returns {{ok: true, key: string, name: string} | {ok: false}}
 */
function authenticate(req) {
  const keys = configuredKeys();
  if (keys.length === 0) {
    // Pas de clé configurée : on refuse tout (sauf si ALLOW_ANONYMOUS=1)
    if (process.env.ALLOW_ANONYMOUS === '1') return { ok: true, key: 'anonymous', name: 'anonymous' };
    return { ok: false, reason: 'API_KEYS non configurée' };
  }
  const token = bearer(req);
  if (!token) return { ok: false, reason: 'en-tête Authorization: Bearer manquant' };
  for (const [i, k] of keys.entries()) {
    if (safeEqual(token, k)) return { ok: true, key: k, name: `key-${i + 1}` };
  }
  return { ok: false, reason: 'clé API invalide' };
}

module.exports = { authenticate, configuredKeys };
