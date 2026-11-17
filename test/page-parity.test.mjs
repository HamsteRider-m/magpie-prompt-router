import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { decidePurgeAction } from '../src/engine.js';

function pageRoute() {
  const elements = new Map();
  function element(tag) { return { tagName: tag.toUpperCase(), children: [], listeners: {}, style: {}, dataset: {}, value: '', checked: false, textContent: '', className: '', appendChild(child) { this.children.push(child); return child; }, addEventListener(name, handler) { this.listeners[name] = handler; } }; }
  ['enabled', 'defaultMode', 'defaultPersona', 'defaultKeepCwd', 'bypassAuxiliary', 'excludedModelGlobs', 'personas', 'rules', 'save-status', 'sim-result', 'sim-model', 'sim-workspace', 'sim-agent', 'sim-protocol', 'sim-system', 'sim-message', 'add-persona', 'add-rule', 'simulate'].forEach((id) => { const node = element('div'); node.id = id; elements.set(id, node); });
  const document = { readyState: 'loading', documentElement: { dataset: {} }, getElementById: (id) => elements.get(id), createElement: element, addEventListener: () => {} };
  const context = { window: { magpie: {} }, document, Promise, Date, JSON, RegExp, Set, clearTimeout: () => {}, setTimeout: () => 1, console };
  context.window.window = context.window;
  vm.runInNewContext(fs.readFileSync(new URL('../page/app.js', import.meta.url), 'utf8'), context);
  return context.window.PurgePage.route;
}

function compare(engineEnvelope, options) {
  const route = pageRoute();
  const engine = decidePurgeAction(engineEnvelope, options);
  const page = route({ model: engineEnvelope.model, workspace: engineEnvelope.cwd, agent: engineEnvelope.agent, protocol: engineEnvelope.protocol, systemText: engineEnvelope.systemText, message: engineEnvelope.userText, userTurns: engineEnvelope.userTurns }, options);
  assert.deepEqual({ mode: page.mode, personaId: page.personaId || null, reason: page.reason }, { mode: engine.mode, personaId: engine.personaId || null, reason: engine.reason });
}

test('page simulator matches engine for Alma-wrapped human directives', () => {
  const turn = '[Context: reminder\nEMOTION SYSTEM — private\nFATIGUE SYSTEM: private][Message sent-at: now]\n/purge once strict inspect\n\n## Response Guidelines\nKeep it short.';
  compare({
    model: 'claude',
    agent: 'alma',
    cwd: '/workspace/app',
    protocol: 'chat',
    systemText: 'WORKING DIRECTORY - /workspace/app',
    userText: turn,
    userTurns: [turn]
  }, { defaultMode: 'off' });
});

test('page simulator matches engine decisions across fifteen wire cases', () => {
  const base = { model: 'claude', agent: 'codex', cwd: '/workspace/app', protocol: 'chat', systemText: 'WORKING DIRECTORY - /workspace/app', userText: 'review auth', userTurns: ['review auth'] };
  const cases = [
    [base, {}],
    [{ ...base, model: 'alma-nmem' }, {}],
    [{ ...base, protocol: 'RESPONSES' }, { defaultMode: 'append' }],
    [{ ...base, userText: '/purge once strict inspect', userTurns: ['/purge once strict inspect'] }, { defaultMode: 'off' }],
    [{ ...base, userText: '@purge append summarize', userTurns: ['@purge append summarize'] }, {}],
    [{ ...base, userText: '/purge off', userTurns: ['/purge on strict', '/purge off'] }, {}],
    [{ ...base, userText: 'audit auth' }, { defaultMode: 'off', rules: [{ protocol: 'CHAT', userKeywords: ['audit', 'auth'], mode: 'strict', personaId: 'builtin-example' }] }],
    [{ ...base, agent: 'worker-7' }, { defaultMode: 'off', rules: [{ agentGlob: 'worker-*', mode: 'append', personaId: 'builtin-example' }] }],
    [{ ...base, cwd: '/tmp/other' }, { defaultMode: 'off', rules: [{ workspaceGlob: '/workspace/*', mode: 'strict', personaId: 'builtin-example' }] }],
    [{ ...base, systemText: 'Return JSON for tool selection.', userText: 'choose tool' }, { defaultMode: 'strict' }],
    [{ ...base, model: 'claude', userText: 'audit auth' }, { excludedModelGlobs: '*nmem*, *embedding*', rules: [{ userKeywords: 'audit, auth', mode: 'append', personaId: 'builtin-example' }] }],
    [{ ...base, userText: '/purge once strict audit', userTurns: ['/purge on', '/purge once strict audit'] }, { excludedModelGlobs: [], defaultMode: 'off' }],
    [{ ...base, userText: 'custom', userTurns: ['custom'] }, { defaultMode: 'fallback', defaultPersonaId: 'custom', personas: [{ id: 'custom', template: 'Custom' }] }],
    [{ ...base, userText: 'builtin', userTurns: ['builtin'] }, { defaultMode: 'fallback', defaultPersonaId: 'builtin-example' }],
    [{ ...base, protocol: 'Gemini', userText: 'memory extract', systemText: 'Return JSON for memory extraction.' }, { defaultMode: 'replace', excludedModelGlobs: [] }],
    [{ ...base, userText: 'follow up', userTurns: ['/purge once strict inspect', 'follow up'] }, { defaultMode: 'off' }],
    [{ ...base, userText: 'follow up', userTurns: ['/purge off', '/purge once strict inspect', 'follow up'] }, { defaultMode: 'strict' }]
  ];
  cases.forEach(([envelope, options]) => compare(envelope, options));
});
