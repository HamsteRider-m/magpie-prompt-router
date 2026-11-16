import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function sandbox() {
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
  const context = { window: { magpie: { options: { get: () => ({ defaultMode: 'off', personas: [{ id: 'p', name: 'P', template: 'P' }], rules: [] }), set: (options) => writes.push(options) } } }, document, console, Promise, Date, JSON, RegExp, clearTimeout: () => {}, setTimeout: (callback) => { pending = callback; return 1; }, performance };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8'), context);
  return { context, elements, writes, runSave: () => pending() };
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
  fixture.context.window.PurgePage.init();
  await Promise.resolve();
  assert.equal(fixture.context.window.PurgePage.getOptions().personas[0].id, 'p');
  const route = fixture.context.window.PurgePage.route({ model: 'claude', workspace: '/workspace/app', message: 'audit auth', protocol: 'chat' }, { defaultMode: 'strict', personas: [], rules: [{ workspaceGlob: '/workspace/*', userKeywords: ['audit'], mode: 'append', personaId: 'p' }] });
  assert.equal(route.mode, 'append');
  fixture.elements.get('add-persona').dispatch('click');
  assert.equal(fixture.context.window.PurgePage.getOptions().personas.length, 2);
  fixture.runSave();
  assert.equal(fixture.writes.length, 1);
});

test('routing bypasses excluded model globs and supports default mode', () => {
  const fixture = sandbox();
  const api = fixture.context.window.PurgePage;
  assert.equal(api.route({ model: 'alma-nmem', workspace: '/tmp', message: 'hello' }, { enabled: true, excludedModelGlobs: ['*nmem*'], defaultMode: 'strict' }).mode, 'off');
  assert.equal(api.route({ model: 'claude', workspace: '/tmp', message: 'hello' }, { enabled: true, excludedModelGlobs: [], defaultMode: 'strict' }).mode, 'strict');
});
