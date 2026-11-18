#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUserSomeMagicDir, listSomeMagicPresets, SOME_MAGIC_DIR } from '../src/presets.js';

export const DEFAULT_REPO = 'https://github.com/ZiChuanLan/some-magic.git';
export const DEFAULT_REF = 'main';
const SKIP_FILES = new Set(['readme.md', 'license.md']);

function printHelp() {
  console.log(`Usage: magpie-purge-presets [options]

Pull Markdown persona presets from ZiChuanLan/some-magic into local Magpie storage.

Options:
  --dir <path>         Write presets into a custom directory
  --local              Write presets into <plugin-root>/presets/some-magic
  --repo <url>         Git repository URL (default: ${DEFAULT_REPO})
  --ref <branch>       Git branch/tag (default: ${DEFAULT_REF})
  --source-dir <path>  Copy from a local directory instead of cloning
  --clean              Remove existing .md files in destination not in upstream
  --refresh-catalog    Also regenerate page/presets.js metadata from synced files
  -h, --help           Show this help message`);
}

export function parseArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    ref: DEFAULT_REF,
    dir: '',
    local: false,
    sourceDir: '',
    clean: false,
    refreshCatalog: false,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--local') options.local = true;
    else if (arg === '--clean') options.clean = true;
    else if (arg === '--refresh-catalog') options.refreshCatalog = true;
    else if (arg === '--dir' && argv[i + 1]) options.dir = argv[++i];
    else if (arg === '--repo' && argv[i + 1]) options.repo = argv[++i];
    else if (arg === '--ref' && argv[i + 1]) options.ref = argv[++i];
    else if (arg === '--source-dir' && argv[i + 1]) options.sourceDir = argv[++i];
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  return options;
}

function githubSlugFromRepo(repoUrl) {
  const match = String(repoUrl || '').match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i);
  return match ? match[1] : '';
}

async function fetchUpstreamToTemp(repo, ref, tempRoot) {
  const cloneDir = path.join(tempRoot, 'repo');
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', ref, repo, cloneDir], { stdio: 'pipe' });
    return cloneDir;
  } catch (gitErr) {
    const slug = githubSlugFromRepo(repo);
    if (!slug) throw gitErr;
    const archiveUrl = `https://codeload.github.com/${slug}/tar.gz/refs/heads/${encodeURIComponent(ref)}`;
    const response = await fetch(archiveUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${archiveUrl} (HTTP ${response.status}) after git clone failed: ${gitErr.message}`);
    }
    const tarPath = path.join(tempRoot, 'archive.tar.gz');
    fs.writeFileSync(tarPath, Buffer.from(await response.arrayBuffer()));
    fs.mkdirSync(cloneDir, { recursive: true });
    execFileSync('tar', ['-xzf', tarPath, '-C', cloneDir, '--strip-components=1'], { stdio: 'pipe' });
    return cloneDir;
  }
}

export async function syncSomeMagic(rawOptions = {}) {
  const options = {
    repo: DEFAULT_REPO,
    ref: DEFAULT_REF,
    dir: '',
    local: false,
    sourceDir: '',
    clean: false,
    refreshCatalog: false,
    ...rawOptions
  };
  const targetDir = options.dir
    ? path.resolve(options.dir)
    : options.local
      ? SOME_MAGIC_DIR
      : getUserSomeMagicDir();

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-purge-sync-'));
  try {
    const sourceDir = options.sourceDir
      ? path.resolve(options.sourceDir)
      : await fetchUpstreamToTemp(options.repo, options.ref, tempRoot);

    fs.mkdirSync(targetDir, { recursive: true });
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    const incomingNames = new Set();
    const syncedFiles = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || SKIP_FILES.has(entry.name.toLowerCase())) continue;
      incomingNames.add(entry.name);
      fs.copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
      syncedFiles.push(entry.name);
    }

    let removedFiles = [];
    if (options.clean) {
      for (const existing of fs.readdirSync(targetDir, { withFileTypes: true })) {
        if (existing.isFile() && existing.name.endsWith('.md') && !incomingNames.has(existing.name)) {
          fs.unlinkSync(path.join(targetDir, existing.name));
          removedFiles.push(existing.name);
        }
      }
    }

    if (options.refreshCatalog) {
      const catalog = listSomeMagicPresets(targetDir).map(({ id, name, description, order, filePath, source }) => ({
        id, name, description, order, filePath, source
      }));
      const catalogPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'page', 'presets.js');
      const content = `// Generated from some-magic preset metadata\nwindow.MAGPIE_PURGE_PRESETS = ${JSON.stringify(catalog, null, 2)};\n`;
      fs.writeFileSync(catalogPath, content, 'utf8');
    }

    return {
      targetDir,
      count: syncedFiles.length,
      files: syncedFiles.sort(),
      removed: removedFiles.sort()
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    const result = await syncSomeMagic(opts);
    console.log(`Synced ${result.count} some-magic presets into ${result.targetDir}`);
    if (result.removed.length) {
      console.log(`Removed ${result.removed.length} stale files.`);
    }
  } catch (err) {
    console.error(`Failed to sync some-magic presets: ${err.message}`);
    process.exit(1);
  }
}
