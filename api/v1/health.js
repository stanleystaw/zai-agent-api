/**
 * /api/v1/health — diagnostic
 */
'use strict';

const { ok, preflight } = require('../../lib/http');
const store = require('../../lib/store');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  const queue = await store.queueLength();

  return ok(res, {
    status: 'ok',
    time: new Date().toISOString(),
    storage: store.backend,
    queueLength: queue,
    env: {
      API_KEYS: Boolean(process.env.API_KEYS),
      WORKER_TOKEN: Boolean(process.env.WORKER_TOKEN),
      KV: store.backend === 'kv',
      ALLOW_ANONYMOUS: process.env.ALLOW_ANONYMOUS === '1',
    },
    note:
      store.backend === 'memory'
        ? 'Stockage en mémoire : les données disparaissent au redémarrage de la fonction. Ajoute KV_REST_API_URL / KV_REST_API_TOKEN pour la persistance.'
        : 'Stockage KV persistant actif.',
  });
};
