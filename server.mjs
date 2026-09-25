import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createEngine } from './lib/engine.mjs';

const WEB = new URL('./web/', import.meta.url);
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
}

async function bodyJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Content-Type must be application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) throw new Error('Request body exceeds 32 KiB.');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request must be a JSON object.');
  return value;
}

export function createApp(engine = createEngine()) {
  const ready = engine.init();
  // Let static files load even if native initialization fails; API exposes error.
  ready.catch(error => console.error('Engine startup:', error.message));
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && STATIC.has(path)) {
        const [name, type] = STATIC.get(path);
        const contents = await readFile(new URL(name, WEB));
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(contents);
        return;
      }
      if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (!path.startsWith('/api/')) { sendJson(response, 404, { error: 'Not found' }); return; }
      await ready;
      if (request.method === 'GET' && path === '/api/state') {
        sendJson(response, 200, engine.snapshot());
      } else if (request.method === 'POST' && path === '/api/action') {
        if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
          sendJson(response, 403, { error: 'Cross-origin actions are not accepted.' }); return;
        }
        sendJson(response, 200, await engine.act(await bodyJson(request)));
      } else if (request.method === 'GET' && path.startsWith('/api/evidence/')) {
        try { sendJson(response, 200, await engine.evidence(decodeURIComponent(path.slice('/api/evidence/'.length)))); }
        catch (error) { sendJson(response, 404, { error: error.message }); }
      } else if (request.method === 'GET' && path === '/api/export') {
        const result = await engine.exportRun();
        sendJson(response, 200, result, { 'Content-Disposition': `attachment; filename="veri-watch-${result.run_id}.json"` });
      } else if (request.method === 'GET' && path === '/api/analytics') {
        sendJson(response, 200, await engine.analytics());
      } else sendJson(response, 404, { error: 'Unknown API route or method.' });
    } catch (error) {
      let state;
      try { state = engine.snapshot(); } catch { /* startup failure has no snapshot */ }
      sendJson(response, state ? 400 : 503, { error: error.message, ...(state ? { state } : {}) });
    }
  });
  server.requestTimeout = 180_000;
  return { server, engine, ready };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535.');
  const { server } = createApp();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`VERI/WATCH listening on http://${host}:${port}`));
}
