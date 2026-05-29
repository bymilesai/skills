#!/usr/bin/env node

import { createHash } from 'crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'payload-manifest.json');
const checkOnly = process.argv.includes('--check');

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function payloadFiles() {
  const files = [];

  function walk(relativeDir) {
    const absoluteDir = join(repoRoot, relativeDir);
    for (const name of readdirSync(absoluteDir).sort()) {
      const absolutePath = join(absoluteDir, name);
      const relativePath = relative(repoRoot, absolutePath);
      const stats = statSync(absolutePath);

      if (stats.isDirectory()) {
        walk(relativePath);
        continue;
      }

      files.push({
        path: relativePath,
        size: stats.size,
        sha256: sha256File(absolutePath),
      });
    }
  }

  walk('miles');
  return files;
}

function buildManifest() {
  const version = JSON.parse(
    readFileSync(join(repoRoot, 'version.json'), 'utf8'),
  ).version;
  const files = payloadFiles();

  return {
    name: 'miles',
    version,
    root: 'miles',
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files,
  };
}

const next = `${JSON.stringify(buildManifest(), null, 2)}\n`;

if (checkOnly) {
  const current = existsSync(manifestPath)
    ? readFileSync(manifestPath, 'utf8')
    : '';

  if (current !== next) {
    console.error(
      'payload-manifest.json is stale. Run: /opt/homebrew/bin/node scripts/generate-payload-manifest.mjs',
    );
    process.exit(1);
  }

  console.log('payload-manifest.json is up to date.');
} else {
  writeFileSync(manifestPath, next);
  console.log('Wrote payload-manifest.json');
}
