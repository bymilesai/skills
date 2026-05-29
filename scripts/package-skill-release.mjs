#!/usr/bin/env node

import { createHash } from 'crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    version: null,
    outputDir: join(repoRoot, 'build', 'skill-release'),
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version') {
      args.version = argv[++index];
    } else if (arg === '--output-dir') {
      args.outputDir = resolve(argv[++index]);
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/package-skill-release.mjs [--version <version>] [--output-dir <dir>] [--json]

Creates a deterministic Miles skill release tarball and payload manifest asset.
The packaged version.json intentionally keeps sourceSha256 null so the archive
does not contain its own hash; the public trunk manifest is updated after the
release asset is created.`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function copyReleaseFiles(stagingRoot, version) {
  const packageName = `miles-skill-${version}`;
  const packageDir = join(stagingRoot, packageName);
  mkdirSync(packageDir, { recursive: true });

  for (const entry of [
    'install.sh',
    'payload-manifest.json',
    'README.md',
    'INSTALL_FOR_AGENTS.md',
    'INSTALL_SECURITY.md',
    'start.bymiles.ai.md',
    'miles',
  ]) {
    cpSync(join(repoRoot, entry), join(packageDir, entry), { recursive: true });
  }

  const manifest = readJson(join(repoRoot, 'version.json'));
  manifest.sourceSha256 = null;
  writeJson(join(packageDir, 'version.json'), manifest);

  return { packageName, packageDir };
}

function tarString(value, length) {
  const buffer = Buffer.alloc(length);
  buffer.write(value.slice(0, length), 0, 'utf8');
  return buffer;
}

function tarOctal(value, length) {
  const text = value.toString(8).padStart(length - 1, '0').slice(0, length - 1);
  const buffer = Buffer.alloc(length);
  buffer.write(text, 0, 'ascii');
  buffer[length - 1] = 0;
  return buffer;
}

function splitTarPath(path) {
  const normalized = path.replaceAll('\\', '/');
  if (Buffer.byteLength(normalized) <= 100) {
    return { name: normalized, prefix: '' };
  }

  const parts = normalized.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }

  throw new Error(`Release path is too long for ustar: ${path}`);
}

function tarHeader({ path, size, mode, type }) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(path);

  tarString(name, 100).copy(header, 0);
  tarOctal(mode, 8).copy(header, 100);
  tarOctal(0, 8).copy(header, 108);
  tarOctal(0, 8).copy(header, 116);
  tarOctal(size, 12).copy(header, 124);
  tarOctal(0, 12).copy(header, 136);
  Buffer.from('        ', 'ascii').copy(header, 148);
  header[156] = type.charCodeAt(0);
  tarString('ustar', 6).copy(header, 257);
  tarString('00', 2).copy(header, 263);
  tarString('root', 32).copy(header, 265);
  tarString('root', 32).copy(header, 297);
  tarString(prefix, 155).copy(header, 345);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  tarOctal(checksum, 8).copy(header, 148);
  return header;
}

function tarEntries(root, packageName) {
  const entries = [];

  function walk(relativePath) {
    const absolutePath = join(root, relativePath);
    const stats = statSync(absolutePath);
    const tarPath = relativePath.replaceAll('\\', '/');

    if (stats.isDirectory()) {
      entries.push({
        path: `${tarPath}/`,
        absolutePath,
        size: 0,
        mode: 0o755,
        type: '5',
      });
      for (const name of readdirSync(absolutePath).sort()) {
        walk(join(relativePath, name));
      }
      return;
    }

    entries.push({
      path: tarPath,
      absolutePath,
      size: stats.size,
      mode: stats.mode & 0o111 ? 0o755 : 0o644,
      type: '0',
    });
  }

  walk(packageName);
  return entries;
}

function createArchive(stagingRoot, packageName, archivePath) {
  const chunks = [];
  for (const entry of tarEntries(stagingRoot, packageName)) {
    chunks.push(tarHeader(entry));
    if (entry.type === '0') {
      const content = readFileSync(entry.absolutePath);
      chunks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  writeFileSync(archivePath, gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readJson(join(repoRoot, 'version.json'));
  const version = args.version || manifest.version;

  if (!version || manifest.version !== version) {
    throw new Error(
      `version.json version (${manifest.version || 'missing'}) does not match release version (${version || 'missing'})`,
    );
  }

  mkdirSync(args.outputDir, { recursive: true });
  const stagingRoot = mkdtempSync(join(tmpdir(), 'miles-skill-release-'));

  try {
    const { packageName } = copyReleaseFiles(stagingRoot, version);
    const archivePath = join(args.outputDir, `${packageName}.tar.gz`);
    const payloadManifestPath = join(
      args.outputDir,
      `payload-manifest-${version}.json`,
    );

    createArchive(stagingRoot, packageName, archivePath);
    cpSync(join(repoRoot, 'payload-manifest.json'), payloadManifestPath);

    const result = {
      version,
      archive: archivePath,
      archiveName: basename(archivePath),
      archiveSha256: sha256File(archivePath),
      payloadManifest: payloadManifestPath,
      payloadManifestName: basename(payloadManifestPath),
      payloadManifestSha256: sha256File(payloadManifestPath),
    };

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Packaged Miles skill ${version}`);
      console.log(`Archive: ${result.archive}`);
      console.log(`Archive SHA-256: ${result.archiveSha256}`);
      console.log(`Payload manifest: ${result.payloadManifest}`);
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
