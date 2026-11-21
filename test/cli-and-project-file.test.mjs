import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decideRouteAction } from '../src/engine.js';
import { loadProjectPersona, onRequest, parsePromptFile, PROJECT_CONFIG_FILENAME } from '../src/hooks.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(rootDir, 'bin', 'magpie-prompt-router.mjs');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('default excludedModelGlobs skips JEV router models', () => {
  const action = decideRouteAction(
    { protocol: 'chat', model: 'jev-1.13', agent: 'alma', cwd: '/tmp/proj', systemText: 'WORKING DIRECTORY - Your working directory for this conversation is: /tmp/proj', userText: 'Hi', userTurns: ['Hi'] },
    { enabled: true, defaultMode: 'replace', defaultPersonaId: 'custom', personas: [{ id: 'custom', template: 'Custom' }] }
  );
  assert.equal(action.mode, 'off');
  assert.equal(action.reason, 'auxiliary');
});

test('parsePromptFile parses frontmatter fields and strips header', () => {
  const parsed = parsePromptFile(`---
mode: strict
keepCwd: false
enabled: true
name: Repo Guide
---
Follow repo rules in {{cwd}}.`);
  assert.equal(parsed.meta.mode, 'strict');
  assert.equal(parsed.meta.keepCwd, false);
  assert.equal(parsed.meta.enabled, true);
  assert.equal(parsed.meta.name, 'Repo Guide');
  assert.equal(parsed.body, 'Follow repo rules in {{cwd}}.');
});

test('onRequest auto-discovers .prompt-router.md, hot-reloads edits, and respects precedence', () => {
  const dir = mkTempDir('mpr-proj-');
  const filePath = path.join(dir, PROJECT_CONFIG_FILENAME);
  fs.writeFileSync(filePath, `---
mode: strict
---
Project persona v1 for {{cwd}}`, 'utf8');

  const body = {
    model: 'claude-sonnet-4',
    cwd: dir,
    messages: [
      { role: 'system', content: 'Host prompt' },
      { role: 'user', content: 'Explain this module' }
    ]
  };

  // Auto-discovers when defaultMode is off and no rule matched
  const out1 = onRequest(body, { protocol: 'chat', options: { enabled: true, defaultMode: 'off' } });
  assert.ok(out1);
  assert.match(out1.messages[0].content, /Project persona v1/);
  assert.ok(out1.messages[0].content.includes(dir));

  // Hot-reloads on mtime/size change
  fs.writeFileSync(filePath, `---
mode: append
---
Project persona v2 updated`, 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(filePath, future, future);
  const out2 = onRequest(body, { protocol: 'chat', options: { enabled: true, defaultMode: 'off' } });
  assert.ok(out2);
  assert.match(out2.messages[0].content, /Project persona v2 updated/);
  assert.match(out2.messages[0].content, /Host prompt/);

  // Explicit /route off overrides .prompt-router.md
  const offBody = {
    ...body,
    messages: [
      { role: 'system', content: 'Host prompt' },
      { role: 'user', content: '/route off Keep host prompt' }
    ]
  };
  const outOff = onRequest(offBody, { protocol: 'chat', options: { enabled: true, defaultMode: 'off' } });
  assert.ok(outOff);
  assert.equal(outOff.messages[0].content, 'Host prompt');
  assert.equal(outOff.messages[1].content, 'Keep host prompt');

  // autoDiscoverProjectFile: false disables discovery
  const outDisabled = onRequest(body, { protocol: 'chat', options: { enabled: true, defaultMode: 'off', autoDiscoverProjectFile: false } });
  assert.equal(outDisabled, undefined);

  // Auxiliary JEV call still skipped even when .prompt-router.md exists
  const jevBody = { ...body, model: 'jev-1.13-free' };
  const outJev = onRequest(jevBody, { protocol: 'chat', options: { enabled: true, defaultMode: 'off' } });
  assert.equal(outJev, undefined);

  // enabled: false inside .prompt-router.md disables it
  fs.writeFileSync(filePath, `---
enabled: false
---
Disabled body`, 'utf8');
  const future2 = new Date(Date.now() + 10000);
  fs.utimesSync(filePath, future2, future2);
  assert.equal(loadProjectPersona(dir), null);
});

test('CLI manages personas, rules, defaults, init-project, status, and dry-run test', () => {
  const dir = mkTempDir('mpr-cli-');
  const configPath = path.join(dir, 'plugins.json');
  const repoDir = path.join(dir, 'sample-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ plugins: [{ spec: 'other-plugin', off: false }] }, null, 2));

  const runCli = (args) => execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });

  // init-project
  const initOut = runCli(['init-project', '--dir', repoDir, '--mode', 'append']);
  assert.match(initOut, /Created/);
  assert.ok(fs.existsSync(path.join(repoDir, PROJECT_CONFIG_FILENAME)));

  // persona add & list
  runCli(['persona', 'add', 'arch', '--template', 'Be an architect for {{cwd}}', '--name', 'Architect', '--config', configPath]);
  const personas = JSON.parse(runCli(['persona', 'list', '--config', configPath]));
  assert.equal(personas.length, 1);
  assert.equal(personas[0].id, 'arch');

  // bind-cwd & rule list
  runCli(['bind-cwd', 'arch', '--mode', 'replace', '--cwd', repoDir, '--config', configPath]);
  const rules = JSON.parse(runCli(['rule', 'list', '--config', configPath]));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].personaId, 'arch');

  // dry-run test matches rule
  const dryRun = JSON.parse(runCli(['test', '--cwd', repoDir, '--model', 'claude-sonnet-4', '--config', configPath]));
  assert.equal(dryRun.mode, 'replace');
  assert.equal(dryRun.personaId, 'arch');
  assert.equal(dryRun.reason, 'rule');

  // remove rule -> falls back to .prompt-router.md auto-discovery
  runCli(['rule', 'rm', '1', '--config', configPath]);
  const dryRunProject = JSON.parse(runCli(['test', '--cwd', repoDir, '--model', 'claude-sonnet-4', '--config', configPath]));
  assert.equal(dryRunProject.mode, 'append');
  assert.equal(dryRunProject.personaId, 'project-file');
  assert.equal(dryRunProject.reason, 'project-file');

  // status preserves unrelated plugins in plugins.json
  const status = JSON.parse(runCli(['status', '--cwd', repoDir, '--config', configPath]));
  assert.equal(status.installed, true);
  assert.equal(status.projectFile.mode, 'append');
  const savedPlugins = JSON.parse(fs.readFileSync(configPath, 'utf8')).plugins;
  assert.ok(savedPlugins.some((p) => p.spec === 'other-plugin'));
});
