// Spec 12.15–12.16: GitHub Pages relative paths; offline shell completeness;
// versioned cache name; .nojekyll; no secrets committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shippedFiles, precacheFromSw } from '../../tools/update-precache.mjs';
import { CACHE_NAME, APP_VERSION } from '../../js/config.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir, out = []) {
  for (const n of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, n);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

test('.nojekyll exists at the repository root', () => {
  assert.ok(existsSync(join(ROOT, '.nojekyll')));
});

test('index.html uses only relative URLs', () => {
  const html = read('index.html');
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 6);
  for (const u of urls) assert.ok(u.startsWith('./') || u.startsWith('#'), `relative: ${u}`);
});

test('manifest start_url, scope, id and icons are relative', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.id, './');
  assert.equal(m.display, 'standalone');
  for (const icon of m.icons) {
    assert.ok(icon.src.startsWith('./'));
    assert.ok(existsSync(join(ROOT, icon.src)), `${icon.src} exists`);
  }
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
});

test('service worker registration and pre-cache list are relative and complete', () => {
  assert.match(read('js/ui/pwa.js'), /register\('\.\/sw\.js', \{ scope: '\.\/' \}\)/);
  const sw = read('sw.js');
  const list = precacheFromSw(sw);
  for (const p of list) {
    assert.ok(p.startsWith('./'), `relative: ${p}`);
    if (p !== './') assert.ok(existsSync(join(ROOT, p)), `pre-cached file exists: ${p}`);
  }
  assert.deepEqual([...list].sort(), [...shippedFiles()].sort(), 'every shipped file is pre-cached (run node tools/update-precache.mjs)');
});

test('cache name is versioned and matches js/config.js', () => {
  const m = /const CACHE_NAME = '([^']+)'/.exec(read('sw.js'));
  assert.ok(m);
  assert.equal(m[1], CACHE_NAME);
  assert.match(CACHE_NAME, /^axon-v\d+$/);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+/);
  assert.match(read('sw.js'), /n\.startsWith\('axon-'\) && n !== CACHE_NAME/, 'only Axon caches are cleaned up');
  assert.equal(/indexedDB/i.test(read('sw.js').replace(/\/\*[\s\S]*?\*\//g, '')), false, 'service worker never touches IndexedDB');
});

test('no absolute root paths or remote script/style origins in shipped code', () => {
  const files = [...walk('js'), 'sw.js', 'css/app.css'];
  for (const f of files) {
    const src = read(f);
    assert.equal(/(?:import|from)\s*\(?\s*['"]\/(?!\/)/.test(src), false, `${f}: absolute import`);
    assert.equal(/url\(['"]?\/(?!\/)/.test(src), false, `${f}: absolute CSS url`);
    assert.equal(/<script[^>]+src=["']https?:/i.test(src), false, `${f}: remote script`);
  }
  // Static imports between modules are relative
  for (const f of walk('js')) {
    for (const m of read(f).matchAll(/from '([^']+)'/g)) assert.ok(m[1].startsWith('.'), `${f} imports ${m[1]}`);
  }
});

test('the only network origin used by the app is the GitHub API for optional sync', () => {
  const hits = new Set();
  for (const f of walk('js')) for (const m of read(f).matchAll(/https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) hits.add(m[1].toLowerCase());
  const allowed = new Set(['api.github.com', 'gist.githubusercontent.com', 'gist.github.com', 'github.com']);
  for (const h of hits) assert.ok(allowed.has(h), `unexpected host ${h}`);
});

test('no tokens or secrets are committed', () => {
  const files = [...walk('js'), ...walk('tests'), 'index.html', 'manifest.json', 'sw.js', 'package.json'];
  for (const f of files) {
    const src = read(f);
    assert.equal(/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/.test(src), false, `${f} contains something that looks like a GitHub token`);
  }
});
