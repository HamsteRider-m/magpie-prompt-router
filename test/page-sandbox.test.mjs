import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function sandbox(magpieOverride) {
  const elements = new Map();
  function element(tag) {
    const node = { tagName: tag.toUpperCase(), children: [], listeners: {}, style: {}, dataset: {}, value: '', checked: false, textContent: '', className: '', appendChild(child) { this.children.push(child); return child; }, addEventListener(name, handler) { this.listeners[name] = handler; }, dispatch(name, event = { target: this }) { if (this.listeners[name]) this.listeners[name](event); } };
    return node;
  }
  ['enabled', 'defaultMode', 'defaultPersona', 'defaultKeepCwd', 'bypassAuxiliary', 'excludedModelGlobs', 'personas', 'rules', 'save-status', 'sim-result', 'sim-model', 'sim-workspace', 'sim-agent', 'sim-protocol', 'sim-system', 'sim-message', 'add-persona', 'add-rule', 'simulate'].forEach((id) => { const node = element('div'); node.id = id; elements.set(id, node); });
  elements.get('sim-model').value = 'claude';
  elements.get('sim-workspace').value = '/workspace/app';
  elements.get('sim-message').value = 'audit auth';
  const writes = [];
  let pending;
  const document = { readyState: 'loading', documentElement: { dataset: {} }, getElementById: (id) => elements.get(id), createElement: element, addEventListener: (name, handler) => { if (name === 'DOMContentLoaded') document.ready = handler; } };
  const magpie = magpieOverride || { options: { get: () => ({ defaultMode: 'off', personas: [{ id: 'p', name: 'P', template: 'P' }], rules: [] }), set: (options) => writes.push(options) } };
  const context = { window: { magpie }, document, console, Promise, Date, JSON, RegExp, Set, clearTimeout: () => {}, setTimeout: (callback) => { pending = callback; return 1; }, performance };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8'), context);
  return { context, elements, writes, runSave: () => pending() };
}

function findNodes(root, predicate, out = []) {
  if (!root) return out;
  if (predicate(root)) out.push(root);
  if (Array.isArray(root.children)) {
    for (const child of root.children) findNodes(child, predicate, out);
  }
  return out;
}

test('page script is a classic script with no fetch dependency', () => {
  const html = fs.readFileSync(new URL('../page/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8');
  assert.match(html, /script src="\.\/app\.js"/);
  assert.doesNotMatch(app, /\bfetch\s*\(/);
  assert.doesNotMatch(app, /import\s+/);
});

test('sandbox loads options, routes a sample, mutates a persona, and debounces save', async () => {
  const fixture = sandbox();
  fixture.context.document.readyState = 'complete';
  fixture.context.window.PromptRouterPage.init();
  await Promise.resolve();
  assert.equal(fixture.context.window.PromptRouterPage.getOptions().personas[0].id, 'p');
  const route = fixture.context.window.PromptRouterPage.route({ model: 'claude', workspace: '/workspace/app', message: 'audit auth', protocol: 'chat' }, { defaultMode: 'strict', personas: [], rules: [{ workspaceGlob: '/workspace/*', userKeywords: ['audit'], mode: 'append', personaId: 'p' }] });
  assert.equal(route.mode, 'append');
  fixture.elements.get('add-persona').dispatch('click');
  assert.equal(fixture.context.window.PromptRouterPage.getOptions().personas.length, 2);
  fixture.runSave();
  assert.equal(fixture.writes.length, 1);
});

test('per-rule personaId select renders personas, shows missing fallback, updates rule, and persists via options.set', async () => {
  const writes = [];
  const fixture = sandbox({
    options: {
      get: () => ({
        defaultMode: 'off',
        defaultPersonaId: 'p1',
        personas: [
          { id: 'p1', name: 'Reviewer', template: 'Review strictly.' },
          { id: 'p2', name: 'Concise', template: 'Be concise.' }
        ],
        rules: [
          { enabled: true, workspaceGlob: '/workspace/*', mode: 'replace', personaId: 'p1' },
          { enabled: true, modelGlob: 'claude-*', mode: 'strict', personaId: 'deleted-persona' }
        ]
      }),
      set: (options) => writes.push(options)
    }
  });
  fixture.context.window.PromptRouterPage.init();
  await Promise.resolve();

  const personaSelects = findNodes(fixture.elements.get('rules'), (node) => node.tagName === 'SELECT' && node.dataset.field === 'personaId');
  assert.equal(personaSelects.length, 2);
  assert.deepEqual(personaSelects[0].children.map((opt) => opt.value), ['', 'p1', 'p2']);
  assert.equal(personaSelects[0].value, 'p1');
  assert.deepEqual(personaSelects[1].children.map((opt) => opt.value), ['', 'p1', 'p2', 'deleted-persona']);
  assert.match(personaSelects[1].children[3].textContent, /deleted-persona \(missing\)/);
  assert.equal(personaSelects[1].value, 'deleted-persona');

  personaSelects[0].value = 'p2';
  personaSelects[0].dispatch('change');
  assert.equal(fixture.context.window.PromptRouterPage.getOptions().rules[0].personaId, 'p2');

  fixture.runSave();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].rules[0].personaId, 'p2');

  // Adding and renaming personas keeps rule persona selectors synchronized
  fixture.elements.get('add-persona').dispatch('click');
  const updatedSelects = findNodes(fixture.elements.get('rules'), (node) => node.tagName === 'SELECT' && node.dataset.field === 'personaId');
  assert.equal(updatedSelects[0].children.length, 4);
  assert.equal(updatedSelects[0].value, 'p2');
});

test('routing bypasses excluded model globs and supports default mode', () => {
  const fixture = sandbox();
  const api = fixture.context.window.PromptRouterPage;
  assert.equal(api.route({ model: 'alma-nmem', workspace: '/tmp', message: 'hello' }, { enabled: true, excludedModelGlobs: ['*nmem*'], defaultMode: 'strict' }).mode, 'off');
  assert.equal(api.route({ model: 'claude', workspace: '/tmp', message: 'hello' }, { enabled: true, excludedModelGlobs: [], defaultMode: 'strict' }).mode, 'strict');
});

test('applies dark theme via magpie.ready and handles options.get rejection safely', async () => {
  const fixture = sandbox({
    ready: Promise.resolve({ dark: true, lang: 'en', tokens: {} }),
    onTheme: () => {},
    options: { get: () => Promise.reject(new Error('offline')), set: () => {} }
  });
  fixture.context.window.PromptRouterPage.init();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fixture.context.document.documentElement.dataset.theme, 'dark');
  assert.equal(fixture.context.window.PromptRouterPage.getOptions().defaultMode, 'off');
});
