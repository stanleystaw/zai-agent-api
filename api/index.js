/**
 * /api — page d'accueil de l'API : documentation lisible par un humain
 */
'use strict';

const { ok, preflight } = require('../lib/http');
const store = require('../lib/store');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  return ok(res, {
    name: 'GLM Agent API',
    version: '1.0.0',
    description:
      'API agentique pour GLM (chat.z.ai) : conversations persistantes, jobs asynchrones, reprise de conversations existantes.',
    storage: store.backend,
    endpoints: {
      'GET /api/v1/health': 'état du service et des composants',
      'GET /api/v1/conversations': 'lister les conversations',
      'POST /api/v1/conversations': 'créer une conversation',
      'GET /api/v1/conversations/:id': 'lire une conversation',
      'PATCH /api/v1/conversations/:id': 'renommer / lier une URL Z.ai',
      'DELETE /api/v1/conversations/:id': 'supprimer',
      'GET /api/v1/conversations/:id/messages': 'historique',
      'POST /api/v1/conversations/:id/messages': 'envoyer une demande (async ou sync)',
      'GET /api/v1/jobs': 'lister les jobs',
      'POST /api/v1/jobs': 'créer un job sans passer par la conversation',
      'GET /api/v1/jobs/:id': 'état du job',
      'DELETE /api/v1/jobs/:id': 'annuler un job en file',
      'POST /api/v1/worker/claim': 'réservé au worker (navigateur)',
      'POST /api/v1/worker/complete': 'réservé au worker (navigateur)',
    },
    auth: 'Authorization: Bearer <API_KEY>',
    docs: '/docs',
  });
};
