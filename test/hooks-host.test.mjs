import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAGPIE_IMMUTABLE_WIRE_KEYS, onRequest } from '../src/hooks.js';

const options = { defaultMode: 'strict', defaultPersonaId: 'persona', personas: [{ id: 'persona', template: 'Be concise. cwd={{cwd}}' }] };

function context(protocol, extra = {}) {
  return { protocol, options, agent: 'main', report: (code, bytes) => extra.reports?.push({ code, bytes }), ...extra };
}

test('writes strict persona into the actual system location for every protocol', () => {
  const bodies = {
    chat: { model: 'gpt', messages: [{ role: 'system', content: 'host one' }, { role: 'developer', content: 'host two' }, { role: 'user', content: 'hello' }] },
    responses: { model: 'gpt', input: [{ role: 'system', content: [{ type: 'input_text', text: 'host' }] }, { role: 'developer', content: 'host 2' }, { role: 'user', content: 'hello' }] },
    anthropic: { model: 'claude', system: [{ type: 'text', text: 'host one' }, { type: 'text', text: 'host two' }], messages: [{ role: 'user', content: 'hello' }] },
    gemini: { model: 'gemini', system_instruction: { parts: [{ text: 'host' }, { text: 'host 2' }] }, contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }
  };
  for (const [protocol, body] of Object.entries(bodies)) {
    const result = onRequest(body, context(protocol));
    assert.ok(result, protocol);
    if (protocol === 'chat') {
      assert.deepEqual(result.messages.filter((item) => ['system', 'developer'].includes(item.role)), [{ role: 'system', content: 'Be concise. cwd=' }]);
      assert.equal(Object.hasOwn(result, 'system'), false);
    } else if (protocol === 'responses') {
      assert.equal(result.input.filter((item) => ['system', 'developer'].includes(item.role)).length, 1);
      assert.deepEqual(result.input[0].content, [{ type: 'input_text', text: 'Be concise. cwd=' }]);
      assert.equal(Object.hasOwn(result, 'instructions'), false);
    } else if (protocol === 'anthropic') assert.deepEqual(result.system, [{ type: 'text', text: 'Be concise. cwd=' }]);
    else assert.deepEqual(result.system_instruction.parts, [{ text: 'Be concise. cwd=' }]);
  }
});

test('prepend mode places persona before host text and preserves Anthropic metadata', () => {
  const cacheControl = { type: 'ephemeral', ttl: '5m' };
  const body = { model: 'claude', system: [{ type: 'text', text: 'host', cache_control: cacheControl }, { type: 'text', text: 'second' }], messages: [{ role: 'user', content: 'hello' }] };
  const result = onRequest(body, context('anthropic', { options: { ...options, defaultMode: 'append' } }));
  assert.deepEqual(result.system.map((block) => block.text), ['Be concise. cwd=', 'host', 'second']);
  assert.equal(result.system[1].cache_control, cacheControl);
});

test('scrubs each system block and every Alma user context without changing image parts', () => {
  const body = {
    model: 'gpt',
    messages: [
      { role: 'system', content: 'PERSONALITY: host persona\nWORKING DIRECTORY - keep operational data' },
      { role: 'system', content: 'EMOTION SYSTEM - another host section' },
      { role: 'user', content: '[Context: EMOTION SYSTEM - private\nWORKING DIRECTORY - keep this][Message sent-at: now]hello' },
      { role: 'user', content: [{ type: 'text', text: '[Context: FATIGUE SYSTEM: private][Message sent-at: now]next' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }
    ]
  };
  const result = onRequest(body, context('chat', { options: { ...options, defaultMode: 'replace' } }));
  const systems = result.messages.filter((item) => ['system', 'developer'].includes(item.role));
  assert.match(systems[0].content, /Be concise\./);
  assert.equal(systems[0].content.includes('host persona'), false);
  assert.equal(systems[1].content.includes('another host section'), false);
  assert.equal(result.messages[2].content.includes('EMOTION SYSTEM'), false);
  assert.equal(result.messages[3].content[1].image_url.url, 'data:image/png;base64,abc');
  assert.equal(result.messages[3].content[0].text.includes('FATIGUE SYSTEM'), false);
});

test('keeps all seven immutable wire values structurally unchanged', () => {
  const body = { model: 'gpt', tools: [{ name: 'tool' }], tool_choice: { type: 'auto' }, function_call: { name: 'f' }, functions: [{ name: 'f' }], toolConfig: { mode: 'AUTO' }, stream: true, config: { tools: [{ name: 'nested' }], toolConfig: { mode: 'ANY' } }, messages: [{ role: 'user', content: 'hello' }] };
  const result = onRequest(body, context('chat'));
  for (const key of MAGPIE_IMMUTABLE_WIRE_KEYS) assert.deepEqual(result[key], body[key], key);
  assert.deepEqual(result.config, body.config);
});

test('restores an exact re-entered body without retry metadata', () => {
  const body = { model: 'gpt', messages: [{ role: 'system', content: 'host' }, { role: 'user', content: 'hello' }] };
  const first = onRequest(body, context('chat'));
  const restoredAndRewritten = onRequest(first, context('chat'));
  assert.deepEqual(restoredAndRewritten, first);
  assert.equal(restoredAndRewritten.messages.filter((item) => item.role === 'system').length, 1);
});

test('reloads a file persona after mtime and size change', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-purge-'));
  const filePath = path.join(directory, 'persona.md');
  fs.writeFileSync(filePath, 'first persona');
  const body = { model: 'gpt', messages: [{ role: 'system', content: 'host' }, { role: 'user', content: 'hello' }] };
  const fileOptions = { defaultMode: 'strict', personas: [{ id: 'file', filePath }], defaultPersonaId: 'file' };
  const first = onRequest(body, { protocol: 'chat', options: fileOptions });
  assert.match(first.messages[0].content, /first persona/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  fs.writeFileSync(filePath, 'second persona');
  const second = onRequest(body, { protocol: 'chat', options: fileOptions });
  assert.match(second.messages[0].content, /second persona/);
});

test('fails open for malformed input and clamps safe Magpie reports', () => {
  const reports = [];
  assert.equal(onRequest(null, { report: (code) => reports.push(code) }), undefined);
  assert.equal(onRequest({ model: 'gpt' }, { protocol: 'unknown', report: (code) => reports.push(code) }), undefined);
  const oversized = { model: 'gpt', messages: [{ role: 'user', content: 'x'.repeat(40000) }] };
  onRequest(oversized, { protocol: 'chat', options: { ...options, defaultMode: 'strict' }, report: (code, bytes) => reports.push({ code, bytes }) });
  assert.deepEqual(reports.slice(0, 2), ['empty', 'unavailable']);
  assert.ok(reports[2].bytes <= 32768);
});
