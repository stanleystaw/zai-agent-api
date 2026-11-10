/**
 * dev-server.js — serveur local qui émule le routage Vercel
 *   npm run dev   →  http://localhost:3000
 */
'use strict';

require('dotenv').config();
const http = require('http');

const PORT = Number(process.env.PORT || 3000);

// Table de routage : [méthode regex, chemin regex, module, extracteur de params]
const routes = [
  { file: './api/index.js', path: /^\/api\/?$/, params: () => ({}) },
  { file: './api/v1/health.js', path: /^\/api\/v1\/health\/?$/, params: () => ({}) },
  { file: './api/v1/conversations/index.js', path: /^\/api\/v1\/conversations\/?$/, params: () => ({}) },
  {
    file: './api/v1/conversations/[id].js',
    path: /^\/api\/v1\/conversations\/([^/]+)\/?$/,
    params: (m) => ({ id: decodeURIComponent(m[1]) }),
  },
  {
    file: './api/v1/conversations/[id]/messages.js',
    path: /^\/api\/v1\/conversations\/([^/]+)\/messages\/?$/,
    params: (m) => ({ id: decodeURIComponent(m[1]) }),
  },
  { file: './api/v1/jobs/index.js', path: /^\/api\/v1\/jobs\/?$/, params: () => ({}) },
  {
    file: './api/v1/jobs/[id].js',
    path: /^\/api\/v1\/jobs\/([^/]+)\/?$/,
    params: (m) => ({ id: decodeURIComponent(m[1]) }),
  },
  { file: './api/v1/worker/claim.js', path: /^\/api\/v1\/worker\/claim\/?$/, params: () => ({}) },
  { file: './api/v1/worker/complete.js', path: /^\/api\/v1\/worker\/complete\/?$/, params: () => ({}) },
];

function makeRes(res) {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      res.writeHead(this.statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...this.headers });
      res.end(JSON.stringify(obj, null, 2));
    },
    send(body) {
      res.writeHead(this.statusCode, { 'Content-Type': 'text/plain; charset=utf-8', ...this.headers });
      res.end(String(body ?? ''));
    },
    end() {
      res.writeHead(this.statusCode, this.headers);
      res.end();
    },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  const route = routes.find((r) => r.path.test(pathname));
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: `Route inconnue : ${pathname}` } }));
    return;
  }

  const match = pathname.match(route.path);
  const query = Object.fromEntries(url.searchParams);
  // Sur Vercel, les paramètres dynamiques ([id]) arrivent fusionnés dans req.query.
  Object.assign(req, { query: { ...query, ...route.params(match) } });

  // Corps JSON
  if (req.method === 'POST' || req.method === 'PATCH') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      req.body = raw ? JSON.parse(raw) : {};
    } catch (_) {
      req.body = {};
    }
  }

  try {
    const mod = require(route.file);
    const handler = typeof mod === 'function' ? mod : mod.default;
    await handler(req, makeRes(res));
  } catch (e) {
    console.error('Erreur handler :', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal', message: e.message } }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 GLM Agent API — http://0.0.0.0:${PORT}`);
  console.log(`   Documentation : http://localhost:${PORT}/api`);
  console.log(`   Santé         : http://localhost:${PORT}/api/v1/health\n`);
});
