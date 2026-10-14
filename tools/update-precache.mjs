#!/usr/bin/env node
/**
 * Maintenance helper (not a build step): rewrites the PRECACHE list in
 * sw.js from the files that ship. Run after adding or removing a shipped
 * file:  node tools/update-precache.mjs
 * The test suite fails if the list and the files on disk disagree.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');

export function shippedFiles() {
  const out = ['./', './index.html', './manifest.json'];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir)).sort()) {
      const rel = join(dir, name);
      const st = statSync(join(root, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.(js|mjs|css|woff2|png|svg)$/.test(name)) out.push(`./${rel.split(sep).join('/')}`);
    }
  };
  for (const dir of ['css', 'js', 'vendor', 'icons']) walk(dir);
  return out;
}

export function precacheFromSw(text) {
  const m = /const PRECACHE = \[([\s\S]*?)\];/.exec(text);
  if (!m) throw new Error('PRECACHE list not found in sw.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') {
  const swPath = join(root, 'sw.js');
  const sw = readFileSync(swPath, 'utf8');
  const files = shippedFiles();
  const list = files.map((f) => `  '${f}',`).join('\n');
  const next = sw.replace(/const PRECACHE = \[[\s\S]*?\];/, `const PRECACHE = [\n${list}\n];`);
  if (process.argv.includes('--check')) {
    if (next !== sw) {
      console.error('sw.js precache list is out of date — run: node tools/update-precache.mjs');
      process.exit(1);
    }
    console.log(`sw.js precache list is current (${files.length} files)`);
  } else {
    writeFileSync(swPath, next);
    console.log(`sw.js precache list updated (${files.length} files)`);
  }
}
