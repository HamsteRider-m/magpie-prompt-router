import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVE_ROUTE_MODES,
  classifyAuxiliaryCall,
  decideRouteAction,
  extractWorkspaceCwd,
  interpolatePersona,
  matchesGlob,
  parseRouterConfig,
  parseUserTurnDirective,
  reduceThreadDirectives,
  scrubAlmaUserContext,
  scrubHostSystemPrompt
} from '../src/engine.js';

const almaTurn = (text) => `[Context: reminder\nEMOTION SYSTEM \u2014 loud internal text\nSYSTEM INFO - keep this\nWORKING DIRECTORY - Your working directory for this conversation is: /tmp/project\n][Message sent-at: 2026-11-17T12:00:00Z]${text}\n\n## Response Guidelines\nKeep it short.`;

test('parses Alma directives without touching the envelope or response guidelines', () => {
  const result = parseUserTurnDirective(almaTurn('/route once strict inspect this'), ['builtin-example']);
  assert.equal(result.command, 'once');
  assert.equal(result.mode, 'strict');
  assert.equal(result.text.includes('[Context:'), true);
  assert.equal(result.text.includes('inspect this'), true);
  assert.equal(result.text.includes('## Response Guidelines'), true);
  assert.equal(result.text.includes('/route'), false);
});

test('reduces sticky directives and keeps once scoped to one request', () => {
  const result = reduceThreadDirectives(['/route on builtin-example replace', 'continue'], ['builtin-example']);
  assert.equal(result.state.enabled, true);
  assert.equal(result.state.mode, 'replace');
  assert.equal(result.state.once, false);
  assert.equal(result.turns[1].text, 'continue');

  const scoped = reduceThreadDirectives(['/route off', '/route once builtin-example strict inspect', 'follow up'], ['builtin-example']);
  assert.equal(scoped.state.enabled, false);
  assert.equal(scoped.state.mode, 'off');
  assert.equal(scoped.state.personaId, null);
  assert.equal(scoped.state.once, false);

  const afterOnce = decideRouteAction({
    userText: 'follow up',
    userTurns: ['/route once strict inspect', 'follow up']
  }, { defaultMode: 'off' });
  assert.equal(afterOnce.mode, 'off');
});

test('replaces bare directives with a non-empty acknowledgement request', () => {
  const on = parseUserTurnDirective('/route on');
  const off = parseUserTurnDirective('/route off');
  assert.match(on.text, /magpie-prompt-router/);
  assert.match(off.text, /magpie-prompt-router/);
});

test('leaves malformed directives as ordinary text', () => {
  const result = parseUserTurnDirective('/route maybe do this');
  assert.equal(result.matched, false);
  assert.equal(result.text, '/route maybe do this');
});

test('protects auxiliary JSON calls from sticky routing state', () => {
  const result = decideRouteAction({
    model: 'alma-nmem',
    systemText: 'Return JSON for memory extraction.',
    userText: 'extract memories',
    userTurns: ['/route on strict']
  }, {});
  assert.equal(result.mode, 'off');
  assert.equal(result.reason, 'auxiliary');
  assert.equal(classifyAuxiliaryCall({ model: 'main', systemText: 'Return JSON for tool selection.' }, {
    bypassAuxiliary: true,
    excludedModelGlobs: []
  }), true);
});

test('allows an explicit once directive to bypass a non-excluded auxiliary call', () => {
  const result = decideRouteAction({
    model: 'main',
    systemText: 'Return JSON for tool selection.',
    userText: '/route once strict choose a tool',
    userTurns: ['/route once strict choose a tool']
  }, { excludedModelGlobs: [] });
  assert.equal(result.mode, 'strict');
});

test('matches declarative routing fields and normalizes workspace paths', () => {
  assert.equal(matchesGlob('/tmp/project', '/tmp/*'), true);
  assert.equal(extractWorkspaceCwd('Working directory: C:\\repo\\app'), 'C:/repo/app');
  const result = decideRouteAction({
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

test('scrubs Alma state sections without consuming operational boundaries or context closure', () => {
  const system = [
    'You are Alma, the personal assistant.',
    'PERSONALITY:',
    'remove personality',
    'Intensity: high',
    'EMOTION SYSTEM — remove emotion',
    'Energy: 90%',
    'Current state:',
    'FATIGUE SYSTEM:',
    'IMPORTANT: remove fatigue',
    'SELFIE ALBUM — remove selfies',
    'HOW TO USE: remove album instructions',
    'SYSTEM INFO - keep system info',
    'WORKING DIRECTORY - keep working directory',
    '<available_skills>keep skills</available_skills>'
  ].join('\n');
  const clean = scrubHostSystemPrompt(system, 'alma');
  assert.equal(clean.includes('PERSONALITY:'), false);
  assert.equal(clean.includes('EMOTION SYSTEM'), false);
  assert.equal(clean.includes('FATIGUE SYSTEM:'), false);
  assert.equal(clean.includes('SELFIE ALBUM'), false);
  assert.equal(clean.includes('Intensity: high'), false);
  assert.equal(clean.includes('Energy: 90%'), false);
  assert.equal(clean.includes('Current state:'), false);
  assert.equal(clean.includes('IMPORTANT:'), false);
  assert.equal(clean.includes('HOW TO USE:'), false);
  assert.equal(clean.includes('SYSTEM INFO - keep system info'), true);
  assert.equal(clean.includes('WORKING DIRECTORY - keep working directory'), true);
  assert.equal(clean.includes('<available_skills>keep skills</available_skills>'), true);

  const context = '[Context: reminder\nSELFIE ALBUM — private album\nHOW TO USE: private instructions][Message sent-at: now]hello';
  const scrubbed = scrubAlmaUserContext(context);
  assert.equal(scrubbed.includes('SELFIE ALBUM'), false);
  assert.equal(scrubbed.includes('HOW TO USE:'), false);
  assert.equal(scrubbed.includes('][Message sent-at:'), true);
});

test('interpolates and removes an absent cwd placeholder', () => {
  assert.equal(interpolatePersona('A {{cwd}} B', '/tmp/x'), 'A /tmp/x B');
  assert.equal(interpolatePersona('A {{cwd}} B', ''), 'A\nB');
});

test('decides off when disabled and honors default persona mode', () => {
  assert.deepEqual(ACTIVE_ROUTE_MODES, ['strict', 'replace', 'fallback', 'append', 'suffix']);
  assert.equal(parseRouterConfig().defaultMode, 'off');
  assert.equal(decideRouteAction({ userText: 'hello', userTurns: ['hello'] }, { enabled: false }).mode, 'off');
  const result = decideRouteAction({ userText: 'hello', userTurns: ['hello'] }, { defaultMode: 'strict' });
  assert.equal(result.mode, 'strict');
  assert.equal(result.personaId, 'builtin-example');
});

test('engine work stays well under the host budget', () => {
  const envelope = { cwd: '/tmp/project', model: 'claude', agent: 'pi', protocol: 'chat', systemText: 'Working directory: /tmp/project', userText: 'hello', userTurns: ['hello'] };
  const start = performance.now();
  for (let index = 0; index < 1000; index += 1) decideRouteAction(envelope, { defaultMode: 'strict' });
  assert.ok(performance.now() - start < 1000);
});

test('extracts backticked GA workspace cwd without trailing parenthetical text', () => {
  const gaSystem = '[T3 Workspace]\n- Active project working directory: `/Users/dev/my-app` (relative paths in file_read/file_write/file_patch and `code_run` default cwd resolve directly here).\n- Active role: `general`';
  assert.equal(extractWorkspaceCwd(gaSystem), '/Users/dev/my-app');
});

test('preserves multi-line prompts, indentation, and GA injected tail blocks in directives', () => {
  const multiline = parseUserTurnDirective('/route once custom suffix First line\n  indented second line', ['custom']);
  assert.equal(multiline.matched, true);
  assert.equal(multiline.personaId, 'custom');
  assert.equal(multiline.mode, 'suffix');
  assert.equal(multiline.text, 'First line\n  indented second line');

  const line2Mode = parseUserTurnDirective('/route once\nstrict is a word', ['custom']);
  assert.equal(line2Mode.matched, true);
  assert.equal(line2Mode.mode, undefined);
  assert.equal(line2Mode.text, 'strict is a word');

  const gaTail = '\n\n<nmem_context>\nmemory line\n</nmem_context>\n\n[Role Instructions]\nStay focused.';
  const gaOnce = parseUserTurnDirective(`/route once custom suffix Check line 1\n  line 2${gaTail}`, ['custom']);
  assert.equal(gaOnce.matched, true);
  assert.equal(gaOnce.personaId, 'custom');
  assert.equal(gaOnce.mode, 'suffix');
  assert.equal(gaOnce.text, `Check line 1\n  line 2${gaTail}`);

  const gaBareOn = parseUserTurnDirective('/route on custom suffix\n\n<nmem_context>\nmemory\n</nmem_context>', ['custom']);
  assert.equal(gaBareOn.matched, true);
  assert.equal(gaBareOn.personaId, 'custom');
  assert.equal(gaBareOn.mode, 'suffix');
  assert.match(gaBareOn.text, /magpie-prompt-router: state -> enabled/);
  assert.ok(gaBareOn.text.endsWith('\n\n<nmem_context>\nmemory\n</nmem_context>'));

  const gaBareOff = parseUserTurnDirective('/route off\n\n<project_rules root="/tmp">\nrule 1\n</project_rules>', ['custom']);
  assert.equal(gaBareOff.matched, true);
  assert.equal(gaBareOff.command, 'off');
  assert.match(gaBareOff.text, /magpie-prompt-router: state -> disabled/);
  assert.ok(gaBareOff.text.endsWith('\n\n<project_rules root="/tmp">\nrule 1\n</project_rules>'));
});

test('bare /route on after /route off resumes prior mode, rule, or defaultMode without false enable', () => {
  const personas = [{ id: 'arch', template: 'Arch' }];
  const resumedSticky = decideRouteAction({
    userText: '/route on',
    userTurns: ['/route on arch replace', '/route off', '/route on']
  }, { defaultMode: 'off', personas });
  assert.equal(resumedSticky.mode, 'replace');
  assert.equal(resumedSticky.personaId, 'arch');

  const afterStickyResume = decideRouteAction({
    userText: 'next question',
    userTurns: ['/route on arch replace', '/route off', '/route on', 'next question']
  }, { defaultMode: 'off', personas });
  assert.equal(afterStickyResume.mode, 'replace');
  assert.equal(afterStickyResume.personaId, 'arch');

  const resumedDefault = decideRouteAction({
    userText: '/route on',
    userTurns: ['/route off', '/route on']
  }, { defaultMode: 'replace', personas });
  assert.equal(resumedDefault.mode, 'replace');

  const resumedRule = decideRouteAction({
    model: 'claude-sonnet-4',
    userText: '/route on',
    userTurns: ['/route off', '/route on']
  }, {
    defaultMode: 'off',
    personas,
    rules: [{ modelGlob: 'claude-*', mode: 'suffix', personaId: 'arch' }]
  });
  assert.equal(resumedRule.mode, 'suffix');
  assert.equal(resumedRule.personaId, 'arch');

  const explicitOff = decideRouteAction({
    userText: '/route on off',
    userTurns: ['/route off', '/route on off']
  }, { defaultMode: 'replace', personas });
  assert.equal(explicitOff.mode, 'off');
});
