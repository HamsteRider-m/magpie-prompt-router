import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { interpolatePersona } from '../src/engine.js';
import { onRequest, MAGPIE_IMMUTABLE_WIRE_KEYS } from '../src/hooks.js';
import {
  getPresetSearchDirs,
  getUserSomeMagicDir,
  listSomeMagicPresets,
  loadSomeMagicPresetMap,
  parsePersonaMarkdown,
  resolveSomeMagicFilePath
} from '../src/presets.js';
import { parseArgs, syncSomeMagic } from '../scripts/sync-some-magic.mjs';

function makeTempFixtureDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-purge-presets-'));
  const files = {
    'README.md': '# Ignored readme',
    'alpha.md': '---\nid: alpha-one\nname: Alpha One\ndescription: First test preset\norder: 10\nharness: ["*"]\nmodel: ["*"]\n---\n\nAlpha body prompt.',
    'beta.md': '---\nid: beta-two\nname: Beta Two\ndescription: Second test preset\norder: 2\n---\n\nBeta body prompt.\nWorking directory: {{cwd}}',
    'gamma.md': '---\nname: Gamma Fallback Id\norder: 10\n---\n\nGamma body prompt.'
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content, 'utf8');
  }
  return root;
}

test('parsePersonaMarkdown extracts frontmatter metadata and strips header from body', () => {
  const sample = [
    '---',
    'id: Custom_ID!',
    'name: "Quoted Name"',
    'description: \'Single quoted description\'',
    'harness: ["*"]',
    'model: ["*"]',
    'order: 12',
    '---',
    '',
    'First line of body.',
    'Second line of body.'
  ].join('\n');
  const parsed = parsePersonaMarkdown(sample, 'fallback');
  assert.equal(parsed.meta.id, 'custom_id');
  assert.equal(parsed.meta.name, 'Quoted Name');
  assert.equal(parsed.meta.description, 'Single quoted description');
  assert.equal(parsed.meta.order, 12);
  assert.deepEqual(parsed.meta.harness, ['*']);
  assert.deepEqual(parsed.meta.model, ['*']);
  assert.equal(parsed.body, 'First line of body.\nSecond line of body.');

  const plain = parsePersonaMarkdown('Plain body only', 'Plain_File');
  assert.equal(plain.meta.id, 'plain_file');
  assert.equal(plain.body, 'Plain body only');
});

test('loads and sorts presets from a local preset directory and misses gracefully when absent', () => {
  const missing = listSomeMagicPresets(path.join(os.tmpdir(), `missing-${Date.now()}`));
  assert.deepEqual(missing, []);

  const dir = makeTempFixtureDir();
  try {
    const presets = listSomeMagicPresets(dir);
    assert.equal(presets.length, 3);
    assert.deepEqual(presets.map((item) => item.id), ['beta-two', 'alpha-one', 'gamma']);
    assert.equal(presets[0].filePath, 'presets/some-magic/beta.md');
    const map = loadSomeMagicPresetMap(dir);
    assert.equal(map['alpha-one'].template, 'Alpha body prompt.');
    assert.equal(map.gamma.name, 'Gamma Fallback Id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolves preset search dirs and relative some-magic file paths via XDG_CONFIG_HOME / env override', () => {
  const xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-purge-xdg-'));
  try {
    const env = { XDG_CONFIG_HOME: xdgRoot };
    const userDir = getUserSomeMagicDir(env);
    assert.equal(userDir, path.join(xdgRoot, 'magpie', 'magpie-purge', 'presets', 'some-magic'));
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'delta.md'), '---\nid: delta\n---\n\nDelta body', 'utf8');
    const resolved = resolveSomeMagicFilePath('presets/some-magic/delta.md', env);
    assert.equal(resolved, path.join(userDir, 'delta.md'));
    assert.equal(getPresetSearchDirs(null, { MAGPIE_PURGE_PRESETS_DIR: userDir }).length, 1);
  } finally {
    fs.rmSync(xdgRoot, { recursive: true, force: true });
  }
});

test('page/presets.js is a valid classic script catalog with metadata only', () => {
  const script = fs.readFileSync(new URL('../page/presets.js', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /\bfetch\s*\(/);
  assert.doesNotMatch(script, /import\s+/);
  const context = { window: {} };
  vm.runInNewContext(script, context);
  const pagePresets = context.window.MAGPIE_PURGE_PRESETS;
  assert.equal(Array.isArray(pagePresets), true);
  assert.equal(pagePresets.length, 20);
  for (const item of pagePresets) {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.filePath, 'string');
    assert.equal(item.filePath.startsWith('presets/some-magic/'), true);
    assert.equal(item.source, 'some-magic');
    assert.equal('template' in item, false);
  }
});

test('onRequest resolves synced presets via MAGPIE_PURGE_PRESETS_DIR, directives, fallback, and overrides', () => {
  const dir = makeTempFixtureDir();
  const prevEnv = process.env.MAGPIE_PURGE_PRESETS_DIR;
  process.env.MAGPIE_PURGE_PRESETS_DIR = dir;
  try {
    const presets = loadSomeMagicPresetMap();
    const onceReq = {
      model: 'claude-sonnet',
      tools: [{ name: 'read_file' }],
      stream: true,
      messages: [
        { role: 'system', content: 'Host prompt' },
        { role: 'user', content: '/purge once alpha-one strict Inspect this' }
      ]
    };
    const onceRes = onRequest(onceReq, { protocol: 'chat', options: { defaultMode: 'off' } });
    assert.ok(onceRes);
    assert.equal(onceRes.messages[0].content, interpolatePersona(presets['alpha-one'].template, ''));
    assert.equal(onceRes.messages[1].content, 'Inspect this');
    for (const key of MAGPIE_IMMUTABLE_WIRE_KEYS) assert.deepEqual(onceRes[key], onceReq[key], key);

    const fallbackReq = {
      model: 'qwen-37',
      messages: [{ role: 'system', content: 'You are Qwen.' }, { role: 'user', content: 'hello' }]
    };
    const fallbackRes = onRequest(fallbackReq, {
      protocol: 'chat',
      options: { defaultMode: 'fallback', defaultPersonaId: 'beta-two' }
    });
    assert.ok(fallbackRes);
    assert.equal(fallbackRes.messages[0].content.includes('Beta body prompt.'), true);

    const overrideRes = onRequest(
      { model: 'gpt', messages: [{ role: 'system', content: 'host' }, { role: 'user', content: 'hello' }] },
      {
        protocol: 'chat',
        options: {
          defaultMode: 'strict',
          defaultPersonaId: 'beta-two',
          personas: [{ id: 'beta-two', template: 'Custom override template' }]
        }
      }
    );
    assert.equal(overrideRes.messages[0].content, 'Custom override template');

    const relativeFileRes = onRequest(
      { model: 'gpt', messages: [{ role: 'system', content: 'host' }, { role: 'user', content: 'hello' }] },
      {
        protocol: 'chat',
        options: {
          defaultMode: 'strict',
          defaultPersonaId: 'rel-test',
          personas: [{ id: 'rel-test', filePath: 'presets/some-magic/alpha.md' }]
        }
      }
    );
    assert.equal(relativeFileRes.messages[0].content, 'Alpha body prompt.');
  } finally {
    if (prevEnv === undefined) delete process.env.MAGPIE_PURGE_PRESETS_DIR;
    else process.env.MAGPIE_PURGE_PRESETS_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncSomeMagic copies markdown presets, skips README, and cleans stale files when --clean is set', async () => {
  const sourceDir = makeTempFixtureDir();
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-purge-sync-dst-'));
  try {
    fs.writeFileSync(path.join(targetDir, 'stale.md'), 'old', 'utf8');
    const parsed = parseArgs(['--dir', targetDir, '--clean', '--local']);
    assert.equal(parsed.dir, targetDir);
    assert.equal(parsed.clean, true);
    assert.equal(parsed.local, true);

    const res = await syncSomeMagic({ sourceDir, dir: targetDir, clean: true });
    assert.equal(res.count, 3);
    assert.deepEqual(res.files, ['alpha.md', 'beta.md', 'gamma.md']);
    assert.deepEqual(res.removed, ['stale.md']);
    assert.equal(fs.existsSync(path.join(targetDir, 'README.md')), false);
    assert.equal(fs.existsSync(path.join(targetDir, 'stale.md')), false);
    assert.equal(listSomeMagicPresets(targetDir).length, 3);
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('page sandbox integrates page/presets.js for routing and adding presets', async () => {
  const elements = new Map();
  function element(tag) {
    return {
      tagName: tag.toUpperCase(),
      children: [],
      listeners: {},
      style: {},
      dataset: {},
      value: '',
      checked: false,
      textContent: '',
      className: '',
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      dispatch(name, event = { target: this }) { if (this.listeners[name]) this.listeners[name](event); }
    };
  }
  [
    'enabled', 'defaultMode', 'defaultPersona', 'defaultKeepCwd', 'bypassAuxiliary',
    'excludedModelGlobs', 'personas', 'rules', 'save-status', 'sim-result',
    'sim-model', 'sim-workspace', 'sim-agent', 'sim-protocol', 'sim-system',
    'sim-message', 'add-persona', 'add-rule', 'simulate', 'preset-select', 'add-preset'
  ].forEach((id) => {
    const node = element('div');
    node.id = id;
    elements.set(id, node);
  });
  const writes = [];
  let pending;
  const document = {
    readyState: 'complete',
    documentElement: { dataset: {} },
    getElementById: (id) => elements.get(id),
    createElement: element,
    addEventListener: () => {}
  };
  const context = {
    window: {
      magpie: {
        options: {
          get: () => ({ defaultMode: 'off', personas: [], rules: [] }),
          set: (options) => writes.push(options)
        }
      }
    },
    document,
    console,
    Promise,
    Date,
    JSON,
    RegExp,
    Set,
    clearTimeout: () => {},
    setTimeout: (cb) => { pending = cb; return 1; }
  };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync(new URL('../page/presets.js', import.meta.url), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8'), context);
  await Promise.resolve();

  const presetSelect = elements.get('preset-select');
  assert.equal(presetSelect.children.length, 20);
  presetSelect.value = 'eni-opus-5';
  elements.get('add-preset').dispatch('click');
  const savedPersonas = context.window.PurgePage.getOptions().personas;
  assert.equal(savedPersonas.length, 1);
  assert.equal(savedPersonas[0].id, 'eni-opus-5');
  assert.equal(savedPersonas[0].filePath, 'presets/some-magic/eni-opus-5.md');
  pending();
  assert.equal(writes.length, 1);

  const simRoute = context.window.PurgePage.route(
    { model: 'claude', workspace: '/app', message: '/purge once qwen-37 fallback hello', protocol: 'chat' },
    { defaultMode: 'off', personas: [] }
  );
  assert.equal(simRoute.mode, 'replace');
  assert.equal(simRoute.personaId, 'qwen-37');
});
