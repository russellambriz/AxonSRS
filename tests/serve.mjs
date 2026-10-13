#!/usr/bin/env node
/**
 * Local static server that mimics GitHub Pages project hosting: the app
 * is served only under /AxonSRS/. Any request outside that prefix gets a
 * 404 and is logged, which catches accidental absolute paths.
 *
 *   node tests/serve.mjs [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
export const BASE = '/AxonSRS/';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function startServer({ port = 0, onOutside = null, overrides = new Map() } = {}) {
  const outside = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(BASE)) {
      outside.push(url.pathname);
      if (onOutside) onOutside(url.pathname);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found (outside /AxonSRS/)');
      return;
    }
    let rel = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT) || rel.split('/').some((p) => p.startsWith('.') && p !== '.nojekyll') || rel.startsWith('node_modules') || rel.startsWith('tests/') && !rel.startsWith('tests/fixtures')) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      if (overrides.has(rel)) {
        const body = overrides.get(rel);
        res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(body);
        return;
      }
      const st = await stat(file);
      if (st.isDirectory()) throw new Error('dir');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({ server, url: `http://127.0.0.1:${p}${BASE}`, origin: `http://127.0.0.1:${p}`, outside, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 8080;
  startServer({ port, onOutside: (p) => console.warn(`[outside base] ${p}`) }).then(({ url }) => console.log(`Axon at ${url}`));
}
