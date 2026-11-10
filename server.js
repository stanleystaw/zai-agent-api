/**
 * server.js — point d'entrée pour Render (et tout hébergeur classique)
 *
 * Réutilise exactement le même routeur que la version Vercel :
 *   api/[...path].js
 *
 *   node server.js        → http://localhost:10000
 *
 * Render fournit le port via la variable PORT et attend un écoute sur 0.0.0.0.
 */
'use strict';

const http = require('http');
const handler = require('./api/[...path]');

const PORT = Number(process.env.PORT || 10000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = Object.fromEntries(url.searchParams);

  // Émule le catch-all : /api/v1/conversations/xxx → path = ['conversations','xxx']
  const rawPath = url.pathname;
  if (rawPath.startsWith('/api/v1/')) {
    query.path = rawPath.slice('/api/v1/'.length).split('/').filter(Boolean);
  } else if (rawPath === '/api' || rawPath === '/api/') {
    query.path = [];
  } else if (rawPath !== '/healthz') {
    // racine : on affiche l'index de l'API
    query.path = [];
  }

  Object.assign(req, { query });

  // Corps JSON
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      req.body = raw ? JSON.parse(raw) : {};
    } catch (_) {
      req.body = {};
    }
  }

  const res2 = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) {
      const body = JSON.stringify(o, null, 2);
      res.writeHead(this.statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...this.headers,
      });
      res.end(body);
    },
    send(b) {
      res.writeHead(this.statusCode, { 'Content-Type': 'text/plain; charset=utf-8', ...this.headers });
      res.end(String(b == null ? '' : b));
    },
    end() {
      res.writeHead(this.statusCode, this.headers);
      res.end();
    },
  };

  try {
    await handler(req, res2);
  } catch (e) {
    console.error('[server] erreur :', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal', message: e.message } }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`GLM Agent API en écoute sur http://0.0.0.0:${PORT}`);
  console.log(`  Santé : /api/v1/health`);
  console.log(`  Index : /api`);
});

// Arrêt propre (Render envoie SIGTERM)
process.on('SIGTERM', () => {
  console.log('SIGTERM reçu — arrêt.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
});
