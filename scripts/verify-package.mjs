#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

function fail(message) {
  console.error(`verify-package failed: ${message}`);
  process.exit(1);
}

// 1. Validate core package.json & Magpie manifest fields
if (!pkg.name || typeof pkg.name !== 'string') fail('package.json missing valid "name"');
if (!pkg.version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  fail(`package.json has invalid semver "version": ${pkg.version}`);
}
if (pkg.type !== 'module') fail('package.json must set "type": "module"');
if (!pkg.license) fail('package.json missing "license"');
if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
  fail('package.json must define a non-empty "files" whitelist for npm packaging');
}

const magpie = pkg.magpie;
if (!magpie || typeof magpie !== 'object') fail('package.json missing "magpie" manifest');
if (!magpie.hooks || !fs.existsSync(path.join(rootDir, magpie.hooks))) {
  fail(`magpie.hooks entry not found: ${magpie.hooks}`);
}
if (!magpie.page?.file || !fs.existsSync(path.join(rootDir, magpie.page.file))) {
  fail(`magpie.page.file entry not found: ${magpie.page?.file}`);
}
if (typeof magpie.icon !== 'string' || !magpie.icon.startsWith('data:image/svg+xml,')) {
  fail('magpie.icon must be an inline URL-encoded SVG data URI');
}
if (!magpie.options || typeof magpie.options !== 'object') {
  fail('magpie.options default schema is missing');
}
if (magpie.options.defaultMode !== 'off') {
  fail(`magpie.options.defaultMode should default to "off" (got ${magpie.options.defaultMode})`);
}

// 2. Verify zero legacy naming leaks in shipped/tested files
const legacyPattern = /\b(magpie-purge|dsh-purge|pi-purge|agent-purge|some-magic)\b|\/purge\b|@purge\b/i;
const scanTargets = ['package.json', 'README.md', 'README.zh-CN.md', 'docs', 'src', 'page', 'bin', 'skills', 'test'];

function walkFiles(target) {
  const full = path.join(rootDir, target);
  if (!fs.existsSync(full)) return [];
  const stat = fs.statSync(full);
  if (stat.isFile()) return [full];
  const entries = fs.readdirSync(full, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const next = path.join(target, entry.name);
    return entry.isDirectory() ? walkFiles(next) : [path.join(rootDir, next)];
  });
}

for (const target of scanTargets) {
  for (const file of walkFiles(target)) {
    const content = fs.readFileSync(file, 'utf8');
    const match = content.match(legacyPattern);
    if (match) {
      fail(`legacy reference "${match[0]}" found in ${path.relative(rootDir, file)}`);
    }
  }
}

// 3. Dry-run npm pack and inspect tarball file list
const packJson = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: rootDir,
  encoding: 'utf8'
});
const packInfo = JSON.parse(packJson);
const packedFiles = (packInfo[0]?.files || []).map((entry) => entry.path);
const requiredInPack = [
  'package.json',
  'src/hooks.js',
  'src/engine.js',
  'page/index.html',
  'page/app.js',
  'bin/magpie-prompt-router.mjs',
  'skills/magpie-prompt-router/SKILL.md',
  'README.md'
];
for (const req of requiredInPack) {
  if (!packedFiles.includes(req)) fail(`npm pack missing required file: ${req}`);
}
const forbiddenPrefixes = ['test/', '.github/', '.agents/', 'presets/'];
for (const file of packedFiles) {
  if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
    fail(`npm pack includes forbidden path: ${file}`);
  }
}

console.log(`verify-package ok: ${pkg.name}@${pkg.version} (${packedFiles.length} packed files)`);
