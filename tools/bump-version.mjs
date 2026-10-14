#!/usr/bin/env node
/**
 * Prepare a release: bump the service-worker cache name (axon-vN → N+1)
 * in sw.js and js/config.js, optionally set APP_VERSION, and refresh the
 * pre-cache list. Installed apps only pick up a new release when the
 * cache name changes.
 *
 *   node tools/bump-version.mjs            # cache name only
 *   node tools/bump-version.mjs 1.1.0      # also APP_VERSION
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const swPath = join(root, 'sw.js');
const configPath = join(root, 'js', 'config.js');
const sw = readFileSync(swPath, 'utf8');
const config = readFileSync(configPath, 'utf8');
const current = /const CACHE_NAME = 'axon-v(\d+)';/.exec(sw);
if (!current) throw new Error('CACHE_NAME not found in sw.js');
const next = `axon-v${Number(current[1]) + 1}`;
let nextConfig = config.replace(/export const CACHE_NAME = 'axon-v\d+';/, `export const CACHE_NAME = '${next}';`);
const version = process.argv[2];
if (version) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error(`Not a semantic version: ${version}`);
  nextConfig = nextConfig.replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${version}';`);
}
writeFileSync(swPath, sw.replace(current[0], `const CACHE_NAME = '${next}';`));
writeFileSync(configPath, nextConfig);
execFileSync(process.execPath, [join(root, 'tools', 'update-precache.mjs')], { stdio: 'inherit' });
console.log(`Cache name: axon-v${current[1]} → ${next}${version ? `; APP_VERSION → ${version}` : ''}`);
