#!/usr/bin/env node
/**
 * Browser test runner: node tests/browser/run.mjs [filter]
 *
 * Runs every tests/browser/*.spec.mjs in headless Chromium against the
 * local GitHub-Pages-like server. A spec exports `tests`: an array of
 * { name, run({ browser, url, srv, pw, report }) }. Results, measured
 * timings and screenshots go to test-results/ (not committed).
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startServer } from '../serve.mjs';
import { loadPlaywright, OUT } from './harness.mjs';

const DIR = join(fileURLToPath(import.meta.url), '..');
const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;

const pw = await loadPlaywright();
const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const results = [];
const metrics = {};
let failed = 0;

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.spec.mjs')).sort()) {
  const mod = await import(pathToFileURL(join(DIR, file)).href);
  for (const t of mod.tests) {
    const name = `${file.replace('.spec.mjs', '')} › ${t.name}`;
    if (filter && !filter.test(name)) continue;
    const overrides = new Map();
    const srv = await startServer({ port: 0, overrides });
    srv.overrides = overrides;
    const started = Date.now();
    const report = (key, value) => {
      metrics[`${name} › ${key}`] = value;
    };
    try {
      await t.run({ browser, url: srv.url, srv, pw, report });
      if (srv.outside.length) throw new Error(`Requests outside /AxonSRS/: ${[...new Set(srv.outside)].join(', ')}`);
      results.push({ name, ok: true, ms: Date.now() - started });
      console.log(`ok   ${name} (${Date.now() - started} ms)`);
    } catch (err) {
      failed++;
      results.push({ name, ok: false, ms: Date.now() - started, error: String(err?.stack || err) });
      console.log(`FAIL ${name}\n     ${String(err?.message || err).split('\n').join('\n     ')}`);
    } finally {
      await srv.close();
    }
  }
}

await browser.close();
writeFileSync(join(OUT, 'browser-results.json'), JSON.stringify({ when: new Date().toISOString(), chromium: browser.version?.() ?? null, results, metrics }, null, 2));
if (Object.keys(metrics).length) {
  console.log('\nMeasurements:');
  for (const [k, v] of Object.entries(metrics)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
