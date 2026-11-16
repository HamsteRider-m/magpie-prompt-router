import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyAuxiliaryCall,
  decidePurgeAction,
  extractWorkspaceCwd,
  interpolatePersona,
  matchesGlob,
  parseUserTurnDirective,
  reduceThreadDirectives,
  scrubAlmaUserContext,
  scrubHostSystemPrompt
} from '../src/engine.js';

const almaTurn = (text) => `[Context: reminder\nEMOTION SYSTEM \u2014 loud internal text\nSYSTEM INFO - keep this\nWORKING DIRECTORY - Your working directory for this conversation is: /tmp/project\n][Message sent-at: 2026-11-17T12:00:00Z]${text}\n\n## Response Guidelines\nKeep it short.`;

test('parses Alma directives without touching the envelope or response guidelines', () => {
  const result = parseUserTurnDirective(almaTurn('/purge once strict inspect this'), ['builtin-example']);
  assert.equal(result.command, 'once');
  assert.equal(result.mode, 'strict');
  assert.equal(result.text.includes('[Context:'), true);
  assert.equal(result.text.includes('inspect this'), true);
  assert.equal(result.text.includes('## Response Guidelines'), true);
  assert.equal(result.text.includes('/purge'), false);
});

test('reduces sticky directives and keeps once scoped to one request', () => {
  const result = reduceThreadDirectives(['/purge on builtin-example replace', 'continue'], ['builtin-example']);
  assert.equal(result.state.enabled, true);
  assert.equal(result.state.mode, 'replace');
  assert.equal(result.state.once, false);
  assert.equal(result.turns[1].text, 'continue');
});

test('replaces bare directives with a non-empty acknowledgement request', () => {
  const on = parseUserTurnDirective('/purge on');
  const off = parseUserTurnDirective('/purge off');
  assert.match(on.text, /magpie-purge/);
  assert.match(off.text, /magpie-purge/);
});

test('leaves malformed directives as ordinary text', () => {
  const result = parseUserTurnDirective('/purge maybe do this');
  assert.equal(result.matched, false);
  assert.equal(result.text, '/purge maybe do this');
});

test('protects auxiliary JSON calls from sticky purge state', () => {
  const result = decidePurgeAction({
    model: 'alma-nmem',
    systemText: 'Return JSON for memory extraction.',
    userText: 'extract memories',
    userTurns: ['/purge on strict']
  }, {});
  assert.equal(result.mode, 'off');
  assert.equal(result.reason, 'auxiliary');
  assert.equal(classifyAuxiliaryCall({ model: 'main', systemText: 'Return JSON for tool selection.' }, {
    bypassAuxiliary: true,
    excludedModelGlobs: []
  }), true);
});

test('allows an explicit once directive to bypass a non-excluded auxiliary call', () => {
  const result = decidePurgeAction({
    model: 'main',
    systemText: 'Return JSON for tool selection.',
    userText: '/purge once strict choose a tool',
    userTurns: ['/purge once strict choose a tool']
  }, { excludedModelGlobs: [] });
  assert.equal(result.mode, 'strict');
});

test('matches declarative routing fields and normalizes workspace paths', () => {
  assert.equal(matchesGlob('/tmp/project', '/tmp/*'), true);
  assert.equal(extractWorkspaceCwd('Working directory: C:\\repo\\app'), 'C:/repo/app');
  const result = decidePurgeAction({
    cwd: '/workspace/app', model: 'claude-sonnet', agent: 'codex', protocol: 'responses', userText: 'audit auth', userTurns: ['audit auth']
  }, {
    defaultMode: 'off', rules: [{ workspaceGlob: '/workspace/*', modelGlob: 'claude-*', agentGlob: 'codex', protocol: 'responses', userKeywords: ['audit', 'auth'], mode: 'append', personaId: 'builtin-example' }]
  });
  assert.equal(result.mode, 'append');
});

test('scrubs persona content while preserving Alma operational sections', () => {
  const system = 'PERSONALITY: remove me\nEMOTION SYSTEM \u2014 remove me\nWORKING DIRECTORY - keep me\nSYSTEM INFO - keep me\n<available_skills>keep me</available_skills>';
  const clean = scrubHostSystemPrompt(system, 'alma');
  assert.equal(clean.includes('remove me'), false);
  assert.equal(clean.includes('WORKING DIRECTORY'), true);
  assert.equal(clean.includes('SYSTEM INFO'), true);
  assert.equal(clean.includes('<available_skills>keep me</available_skills>'), true);
  assert.equal(scrubAlmaUserContext(almaTurn('hello')).includes('EMOTION SYSTEM'), false);
});

test('interpolates and removes an absent cwd placeholder', () => {
  assert.equal(interpolatePersona('A {{cwd}} B', '/tmp/x'), 'A /tmp/x B');
  assert.equal(interpolatePersona('A {{cwd}} B', ''), 'A\nB');
});

test('decides off when disabled and honors default persona mode', () => {
  assert.equal(decidePurgeAction({ userText: 'hello', userTurns: ['hello'] }, { enabled: false }).mode, 'off');
  const result = decidePurgeAction({ userText: 'hello', userTurns: ['hello'] }, { defaultMode: 'strict' });
  assert.equal(result.mode, 'strict');
  assert.equal(result.personaId, 'builtin-example');
});

test('engine work stays well under the host budget', () => {
  const envelope = { cwd: '/tmp/project', model: 'claude', agent: 'pi', protocol: 'chat', systemText: 'Working directory: /tmp/project', userText: 'hello', userTurns: ['hello'] };
  const start = performance.now();
  for (let index = 0; index < 1000; index += 1) decidePurgeAction(envelope, { defaultMode: 'strict' });
  assert.ok(performance.now() - start < 1000);
});
