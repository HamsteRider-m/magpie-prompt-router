#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRouteAction, MODES, parseRouterConfig } from '../src/engine.js';
import { DEFAULT_TRACE_FILE, loadProjectPersona, PROJECT_CONFIG_FILENAME } from '../src/hooks.js';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'magpie', 'plugins.json');
const DEFAULT_SPEC = 'magpie-prompt-router';
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log(`magpie-prompt-router (mpr) — Terminal CLI for Magpie Prompt Router

Usage:
  mpr status [--recent] [--trace-file <path>] [--config <path>] [--cwd <dir>]
  mpr init-project [--dir <dir>] [--mode replace|strict|append|suffix|fallback] [--force]
  mpr persona list [--config <path>]
  mpr persona add <id> (--template <text> | --file <path>) [--name <name>] [--config <path>]
  mpr persona rm <id> [--config <path>]
  mpr rule list [--config <path>]
  mpr rule add --persona <id> [--mode replace] [--cwd <glob>] [--model <glob>] [--agent <glob>] [--protocol <p>] [--keywords k1,k2] [--config <path>]
  mpr rule rm <1-based-index> [--config <path>]
  mpr bind-cwd <personaId> [--mode replace] [--cwd <dir>] [--config <path>]
  mpr set-default [--mode off|replace|strict|fallback|append|suffix] [--persona <id>] [--auto-project on|off] [--trace on|off] [--config <path>]
  mpr export [--out <file>] [--config <path>]
  mpr import <file> [--config <path>]
  mpr test [--cwd <dir>] [--model <m>] [--agent <a>] [--protocol chat] [--user <text>] [--system <text>] [--config <path>]
`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function readPluginsFile(configPath) {
  if (!fs.existsSync(configPath)) return { plugins: [] };
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.plugins)) {
    throw new Error(`Invalid Magpie plugins config at ${configPath}: expected { "plugins": [...] }`);
  }
  return raw;
}

function writePluginsFile(configPath, data) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, configPath);
}

function isLocalPackageSpec(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return false;
  try {
    const resolved = path.resolve(spec);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return false;
    const realSpec = fs.realpathSync(resolved);
    const realRoot = fs.existsSync(PACKAGE_ROOT) ? fs.realpathSync(PACKAGE_ROOT) : PACKAGE_ROOT;
    if (realSpec === realRoot) return true;
    const pkgPath = path.join(resolved, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg?.name === 'magpie-prompt-router';
  } catch {
    return false;
  }
}

function findPluginEntry(data, specOverride) {
  if (specOverride) {
    return data.plugins.find((item) => item && item.spec === specOverride) || null;
  }
  return (
    data.plugins.find((item) => typeof item?.spec === 'string' && item.spec.includes('magpie-prompt-router')) ||
    data.plugins.find((item) => typeof item?.spec === 'string' && item.spec.includes('prompt-router')) ||
    data.plugins.find((item) => isLocalPackageSpec(item?.spec)) ||
    null
  );
}

function ensurePluginEntry(data, specOverride) {
  let entry = findPluginEntry(data, specOverride);
  if (!entry) {
    entry = {
      spec: specOverride || DEFAULT_SPEC,
      options: parseRouterConfig({})
    };
    data.plugins.push(entry);
  }
  if (!entry.options || typeof entry.options !== 'object') {
    entry.options = parseRouterConfig({});
  }
  if (!Array.isArray(entry.options.personas)) entry.options.personas = [];
  if (!Array.isArray(entry.options.rules)) entry.options.rules = [];
  return entry;
}

function die(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function run() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...rest] = positionals;
  if (!cmd || cmd === 'help' || flags.help) {
    usage();
    return;
  }

  const configPath = path.resolve(flags.config || DEFAULT_CONFIG_PATH);

  if (cmd === 'init-project') {
    const dir = path.resolve(flags.dir || process.cwd());
    const mode = String(flags.mode || 'replace').toLowerCase();
    if (!['strict', 'replace', 'fallback', 'append', 'suffix'].includes(mode)) {
      die(`Invalid mode "${mode}". Expected one of: strict, replace, fallback, append, suffix`);
    }
    const target = path.join(dir, PROJECT_CONFIG_FILENAME);
    if (fs.existsSync(target) && !flags.force) {
      die(`${target} already exists. Pass --force to overwrite.`);
    }
    const starter = `---
mode: ${mode}
keepCwd: true
enabled: true
---
You are working in {{cwd}}.
Answer directly, follow repository conventions, and keep changes focused.
`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, starter, 'utf8');
    console.log(`Created ${target} (mode: ${mode})`);
    return;
  }

  if (cmd === 'status') {
    const data = readPluginsFile(configPath);
    const entry = findPluginEntry(data, flags.spec);
    const cwd = path.resolve(flags.cwd || process.cwd());
    const projectRoute = loadProjectPersona(cwd);
    const cfg = parseRouterConfig(entry?.options || {});
    const out = {
      configPath,
      installed: Boolean(entry),
      spec: entry?.spec || null,
      pluginOff: Boolean(entry?.off),
      enabled: cfg.enabled,
      defaultMode: cfg.defaultMode,
      defaultPersonaId: cfg.defaultPersonaId,
      autoDiscoverProjectFile: cfg.autoDiscoverProjectFile,
      traceLog: cfg.traceLog,
      excludedModelGlobs: cfg.excludedModelGlobs,
      personaCount: cfg.personas.length,
      ruleCount: cfg.rules.length,
      cwd,
      projectFile: projectRoute ? { path: projectRoute.persona.filePath, mode: projectRoute.mode } : null
    };
    if (flags.recent) {
      const tracePath = path.resolve(flags['trace-file'] || cfg.traceFile || DEFAULT_TRACE_FILE);
      try {
        out.recentDecisions = fs.existsSync(tracePath) ? JSON.parse(fs.readFileSync(tracePath, 'utf8')) : [];
      } catch {
        out.recentDecisions = [];
      }
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'persona') {
    const data = readPluginsFile(configPath);
    if (sub === 'list') {
      const entry = findPluginEntry(data, flags.spec);
      const personas = parseRouterConfig(entry?.options || {}).personas;
      console.log(JSON.stringify(personas, null, 2));
      return;
    }
    if (sub === 'add') {
      const id = rest[0];
      if (!id) die('persona add requires <id>');
      if (!flags.template && !flags.file) die('persona add requires --template <text> or --file <path>');
      const entry = ensurePluginEntry(data, flags.spec);
      const persona = {
        id,
        name: typeof flags.name === 'string' ? flags.name : id,
        ...(flags.template ? { template: String(flags.template) } : {}),
        ...(flags.file ? { filePath: path.resolve(String(flags.file)) } : {})
      };
      const idx = entry.options.personas.findIndex((p) => p?.id === id);
      if (idx >= 0) entry.options.personas[idx] = persona;
      else entry.options.personas.push(persona);
      writePluginsFile(configPath, data);
      console.log(`Saved persona "${id}" in ${configPath}`);
      return;
    }
    if (sub === 'rm') {
      const id = rest[0];
      if (!id) die('persona rm requires <id>');
      const entry = ensurePluginEntry(data, flags.spec);
      const before = entry.options.personas.length;
      entry.options.personas = entry.options.personas.filter((p) => p?.id !== id);
      if (entry.options.personas.length === before) die(`Persona "${id}" not found`);
      writePluginsFile(configPath, data);
      console.log(`Removed persona "${id}" from ${configPath}`);
      return;
    }
    die(`Unknown persona subcommand "${sub || ''}"`);
  }

  if (cmd === 'rule') {
    const data = readPluginsFile(configPath);
    if (sub === 'list') {
      const entry = findPluginEntry(data, flags.spec);
      const rules = parseRouterConfig(entry?.options || {}).rules;
      console.log(JSON.stringify(rules, null, 2));
      return;
    }
    if (sub === 'add') {
      const mode = String(flags.mode || 'replace').toLowerCase();
      if (!MODES.has(mode)) die(`Invalid mode "${mode}"`);
      const entry = ensurePluginEntry(data, flags.spec);
      const rule = {
        enabled: true,
        mode,
        ...(flags.persona ? { personaId: String(flags.persona) } : {}),
        ...(flags.cwd ? { workspaceGlob: String(flags.cwd) } : {}),
        ...(flags.model ? { modelGlob: String(flags.model) } : {}),
        ...(flags.agent ? { agentGlob: String(flags.agent) } : {}),
        ...(flags.protocol ? { protocol: String(flags.protocol) } : {}),
        ...(flags.keywords ? { userKeywords: String(flags.keywords).split(',').map((s) => s.trim()).filter(Boolean) } : {})
      };
      entry.options.rules.push(rule);
      writePluginsFile(configPath, data);
      console.log(`Added rule #${entry.options.rules.length} in ${configPath}`);
      return;
    }
    if (sub === 'rm') {
      const index = Number(rest[0]);
      if (!Number.isInteger(index) || index < 1) die('rule rm requires a 1-based integer index');
      const entry = ensurePluginEntry(data, flags.spec);
      if (index > entry.options.rules.length) die(`Rule #${index} does not exist`);
      entry.options.rules.splice(index - 1, 1);
      writePluginsFile(configPath, data);
      console.log(`Removed rule #${index} from ${configPath}`);
      return;
    }
    die(`Unknown rule subcommand "${sub || ''}"`);
  }

  if (cmd === 'bind-cwd') {
    const personaId = sub;
    if (!personaId) die('bind-cwd requires <personaId>');
    const mode = String(flags.mode || 'replace').toLowerCase();
    if (!MODES.has(mode)) die(`Invalid mode "${mode}"`);
    const dir = path.resolve(flags.cwd || process.cwd()).replace(/\\/g, '/');
    const workspaceGlob = dir.endsWith('*') ? dir : `${dir}*`;
    const data = readPluginsFile(configPath);
    const entry = ensurePluginEntry(data, flags.spec);
    entry.options.rules.push({ enabled: true, workspaceGlob, personaId, mode });
    writePluginsFile(configPath, data);
    console.log(`Bound "${workspaceGlob}" -> persona "${personaId}" (${mode}) in ${configPath}`);
    return;
  }

  if (cmd === 'set-default') {
    const data = readPluginsFile(configPath);
    const entry = ensurePluginEntry(data, flags.spec);
    if (flags.mode !== undefined) {
      const mode = String(flags.mode).toLowerCase();
      if (!MODES.has(mode)) die(`Invalid mode "${mode}"`);
      entry.options.defaultMode = mode;
    }
    if (flags.persona !== undefined) entry.options.defaultPersonaId = String(flags.persona);
    if (flags['auto-project'] !== undefined) {
      entry.options.autoDiscoverProjectFile = String(flags['auto-project']).toLowerCase() !== 'off' && String(flags['auto-project']).toLowerCase() !== 'false';
    }
    if (flags.trace !== undefined) {
      entry.options.traceLog = String(flags.trace).toLowerCase() === 'on' || String(flags.trace).toLowerCase() === 'true';
    }
    writePluginsFile(configPath, data);
    console.log(`Updated defaults in ${configPath}`);
    return;
  }

  if (cmd === 'export') {
    const data = readPluginsFile(configPath);
    const entry = findPluginEntry(data, flags.spec);
    const payload = JSON.stringify(parseRouterConfig(entry?.options || {}), null, 2);
    if (flags.out) {
      const outPath = path.resolve(String(flags.out));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${payload}
`, 'utf8');
      console.log(`Exported options to ${outPath}`);
    } else {
      console.log(payload);
    }
    return;
  }

  if (cmd === 'import') {
    const inFile = sub;
    if (!inFile) die('import requires <file>');
    const imported = parseRouterConfig(JSON.parse(fs.readFileSync(path.resolve(inFile), 'utf8')));
    const data = readPluginsFile(configPath);
    const entry = ensurePluginEntry(data, flags.spec);
    entry.options = imported;
    writePluginsFile(configPath, data);
    console.log(`Imported ${imported.personas.length} persona(s) and ${imported.rules.length} rule(s) into ${configPath}`);
    return;
  }

  if (cmd === 'test') {
    const data = readPluginsFile(configPath);
    const entry = findPluginEntry(data, flags.spec);
    const config = parseRouterConfig(entry?.options || {});
    const cwd = path.resolve(flags.cwd || process.cwd());
    const userText = String(flags.user || 'Hello');
    const envelope = {
      protocol: String(flags.protocol || 'chat'),
      model: String(flags.model || 'claude-sonnet-4'),
      agent: String(flags.agent || 'claude-code'),
      cwd,
      systemText: String(flags.system || ''),
      userText,
      userTurns: [userText]
    };
    let action = decideRouteAction(envelope, config);
    if (config.autoDiscoverProjectFile && action.mode === 'off' && action.reason === 'default' && cwd) {
      const projectRoute = loadProjectPersona(cwd);
      if (projectRoute) {
        action = { ...action, mode: projectRoute.mode, personaId: projectRoute.persona.id, reason: 'project-file', persona: projectRoute.persona };
      }
    }
    console.log(JSON.stringify({
      mode: action.mode,
      personaId: action.personaId,
      reason: action.reason,
      cwd,
      model: envelope.model,
      agent: envelope.agent,
      protocol: envelope.protocol
    }, null, 2));
    return;
  }

  die(`Unknown command "${cmd}". Run "mpr --help" for usage.`);
}

run();
