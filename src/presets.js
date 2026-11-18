import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOME_MAGIC_DIR = path.join(PLUGIN_ROOT, 'presets', 'some-magic');
const SKIP_FILES = new Set(['readme.md', 'license.md']);
const presetCache = new Map();

export function getUserSomeMagicDir(env = process.env) {
  const configBase = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configBase, 'magpie', 'magpie-purge', 'presets', 'some-magic');
}

export function getPresetSearchDirs(presetsDir = null, env = process.env) {
  if (presetsDir) return [path.resolve(presetsDir)];
  const envDir = typeof env.MAGPIE_PURGE_PRESETS_DIR === 'string' && env.MAGPIE_PURGE_PRESETS_DIR.trim()
    ? path.resolve(env.MAGPIE_PURGE_PRESETS_DIR.trim())
    : '';
  if (envDir) return [envDir];
  return [...new Set([SOME_MAGIC_DIR, getUserSomeMagicDir(env)])];
}

export function resolveSomeMagicFilePath(rawPath, env = process.env) {
  const resolved = path.resolve(rawPath);
  if (fs.existsSync(resolved) || path.isAbsolute(rawPath)) return resolved;
  const pluginRelative = path.resolve(PLUGIN_ROOT, rawPath);
  if (fs.existsSync(pluginRelative)) return pluginRelative;
  const normalized = String(rawPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('presets/some-magic/')) {
    const fileName = normalized.slice('presets/some-magic/'.length);
    for (const dir of getPresetSearchDirs(null, env)) {
      const candidate = path.resolve(dir, fileName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return resolved;
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseListValue(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [stripQuotes(trimmed)].filter(Boolean);
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((item) => stripQuotes(item))
    .filter(Boolean);
}

function normalizeId(rawId, fallbackId = '') {
  const clean = String(rawId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return clean || String(fallbackId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/** Parse YAML frontmatter and prompt body from a persona Markdown file. */
export function parsePersonaMarkdown(rawText, fallbackId = '') {
  const text = typeof rawText === 'string' ? rawText : '';
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return {
      meta: { id: normalizeId('', fallbackId), name: fallbackId, description: '', order: Infinity, harness: ['*'], model: ['*'] },
      body: text.trim()
    };
  }
  const meta = { id: '', name: '', description: '', order: Infinity, harness: ['*'], model: ['*'] };
  for (const line of match[1].split(/\r?\n/)) {
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!entry) continue;
    const key = entry[1].toLowerCase();
    const rawValue = entry[2];
    if (key === 'id') meta.id = normalizeId(stripQuotes(rawValue));
    else if (key === 'name') meta.name = stripQuotes(rawValue);
    else if (key === 'description') meta.description = stripQuotes(rawValue);
    else if (key === 'order') {
      const parsed = Number(stripQuotes(rawValue));
      if (Number.isFinite(parsed)) meta.order = parsed;
    } else if (key === 'harness') meta.harness = parseListValue(rawValue);
    else if (key === 'model') meta.model = parseListValue(rawValue);
  }
  meta.id = meta.id || normalizeId('', fallbackId);
  meta.name = meta.name || meta.id;
  return {
    meta,
    body: text.slice(match[0].length).replace(/^\s+/, '')
  };
}

function readPresetsFromDir(resolvedDir) {
  let stat;
  let entries;
  try {
    stat = fs.statSync(resolvedDir);
    if (!stat.isDirectory()) return [];
    const cached = presetCache.get(resolvedDir);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.presets;
    entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
  } catch {
    presetCache.delete(resolvedDir);
    return [];
  }
  const presets = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || SKIP_FILES.has(entry.name.toLowerCase())) continue;
    const absolutePath = path.join(resolvedDir, entry.name);
    const fallbackId = entry.name.slice(0, -3);
    const { meta, body } = parsePersonaMarkdown(fs.readFileSync(absolutePath, 'utf8'), fallbackId);
    if (!meta.id || !body.trim()) continue;
    presets.push({
      id: meta.id,
      name: meta.name,
      description: meta.description,
      order: meta.order,
      harness: meta.harness,
      model: meta.model,
      filePath: `presets/some-magic/${entry.name}`,
      source: 'some-magic',
      preset: true,
      template: body
    });
  }
  presets.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  presetCache.set(resolvedDir, { mtimeMs: stat.mtimeMs, presets });
  return presets;
}

/** Load and sort all locally synced some-magic presets from disk. */
export function listSomeMagicPresets(presetsDir = null, env = process.env) {
  const dirs = getPresetSearchDirs(presetsDir, env);
  const byId = new Map();
  for (const dir of dirs) {
    for (const preset of readPresetsFromDir(dir)) {
      if (!byId.has(preset.id)) byId.set(preset.id, preset);
    }
  }
  return [...byId.values()].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

/** Return locally synced some-magic presets indexed by persona id. */
export function loadSomeMagicPresetMap(presetsDir = null, env = process.env) {
  const map = {};
  for (const preset of listSomeMagicPresets(presetsDir, env)) {
    map[preset.id] = preset;
  }
  return map;
}
