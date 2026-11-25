import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_PERSONA,
  decideRouteAction,
  detectHostFamily,
  extractWorkspaceCwd,
  interpolatePersona,
  parseRouterConfig,
  parseUserTurnDirective,
  scrubAlmaUserContext,
  scrubHostSystemPrompt
} from './engine.js';

export const MAGPIE_IMMUTABLE_WIRE_KEYS = ['tools', 'tool_choice', 'function_call', 'functions', 'toolConfig', 'model', 'stream'];
export const PROJECT_CONFIG_FILENAME = '.prompt-router.md';
export const DEFAULT_TRACE_FILE = path.join(os.homedir(), '.config', 'magpie', 'prompt-router-recent.json');
const ACTIVE_PROJECT_MODES = new Set(['strict', 'replace', 'fallback', 'append', 'suffix']);
const originalBodies = new Map();
const personaFiles = new Map();
const lastPrefixSegments = new Map();
const recentDecisions = [];
const MAX_RECENT_DECISIONS = 20;
const MAX_ORIGINALS = 64;
const MAX_ORIGINAL_BYTES = 2 * 1024 * 1024;
let originalBytes = 0;

function shortHash(value, length = 12) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value) || '').digest('hex').slice(0, length);
}

export function getRecentDecisions() {
  return recentDecisions.map((entry) => ({ ...entry }));
}

export function clearRecentDecisions() {
  recentDecisions.length = 0;
  lastPrefixSegments.clear();
}

function computePrefixTelemetry(body, protocol, envelope) {
  const modelHash = shortHash(envelope.model);
  const toolsHash = shortHash({
    tools: body?.tools,
    tool_choice: body?.tool_choice,
    function_call: body?.function_call,
    functions: body?.functions,
    toolConfig: body?.toolConfig,
    configTools: body?.config?.tools,
    configToolConfig: body?.config?.toolConfig
  });
  const sysHash = shortHash(systemText(body, protocol));
  const items = messageList(body, protocol).filter((item) => !['system', 'developer'].includes(text(item?.role).toLowerCase()));
  const msgHashes = items.slice(0, Math.max(0, items.length - 1)).map((item) => shortHash(item, 8));
  const prefixHash = shortHash(`${modelHash}:${toolsHash}:${sysHash}`);
  const scopeKey = `${protocol}:${envelope.agent}:${envelope.cwd}`;
  const prev = lastPrefixSegments.get(scopeKey);
  let prefixBreakSegment = 'cold';
  if (prev) {
    if (prev.modelHash !== modelHash) prefixBreakSegment = 'model';
    else if (prev.toolsHash !== toolsHash) prefixBreakSegment = 'tools';
    else if (prev.sysHash !== sysHash) prefixBreakSegment = 'system';
    else if (msgHashes.length < prev.msgHashes.length || prev.msgHashes.some((h, i) => msgHashes[i] !== h)) prefixBreakSegment = 'history';
    else prefixBreakSegment = 'none';
  }
  lastPrefixSegments.set(scopeKey, { modelHash, toolsHash, sysHash, msgHashes });
  if (lastPrefixSegments.size > MAX_ORIGINALS) lastPrefixSegments.delete(lastPrefixSegments.keys().next().value);
  return { prefixHash, prefixBreakSegment };
}

function recordDecision(config, envelope, action, changed, telemetry = {}) {
  const entry = {
    ts: new Date().toISOString(),
    protocol: envelope.protocol,
    model: envelope.model,
    agent: envelope.agent,
    cwd: envelope.cwd,
    mode: action.mode,
    personaId: action.personaId || null,
    reason: action.reason,
    changed,
    prefixHash: telemetry.prefixHash || null,
    prefixBreakSegment: telemetry.prefixBreakSegment || 'cold'
  };
  recentDecisions.push(entry);
  if (recentDecisions.length > MAX_RECENT_DECISIONS) recentDecisions.shift();
  if (config.traceLog) {
    try {
      const target = path.resolve(config.traceFile || DEFAULT_TRACE_FILE);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(recentDecisions, null, 2)}\n`, 'utf8');
    } catch {}
  }
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function cloneBody(value) {
  if (Array.isArray(value)) return value.map(cloneBody);
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };
  for (const key of Object.keys(value)) {
    if (key === 'cache_control') copy[key] = value[key];
    else if (value[key] && typeof value[key] === 'object') copy[key] = cloneBody(value[key]);
  }
  return copy;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => typeof part === 'string' || part?.type === 'text' || part?.type === 'input_text' || (!part?.type && typeof part?.text === 'string' && !part.inlineData && !part.image_url && !part.file_data)).map((part) => typeof part === 'string' ? part : part.text).join('');
}

function messageList(body, protocol) {
  if (protocol === 'gemini') return Array.isArray(body.contents) ? body.contents : [];
  if (Array.isArray(body.messages)) return body.messages;
  if (Array.isArray(body.input)) return body.input;
  return [];
}

function systemText(body, protocol) {
  if (protocol === 'chat') return messageList(body, protocol).filter((item) => ['system', 'developer'].includes(text(item?.role).toLowerCase())).map((item) => contentText(item.content)).join('\n');
  if (protocol === 'responses') {
    const instructions = typeof body.instructions === 'string' ? body.instructions : '';
    const input = messageList(body, protocol).filter((item) => ['system', 'developer'].includes(text(item?.role).toLowerCase())).map((item) => contentText(item.content)).join('\n');
    return [instructions, input].filter(Boolean).join('\n');
  }
  if (protocol === 'anthropic') return contentText(body.system);
  if (protocol === 'gemini') {
    const key = Object.hasOwn(body, 'system_instruction') ? 'system_instruction' : 'systemInstruction';
    return contentText(body[key]?.parts);
  }
  return '';
}

function userMessages(body, protocol) {
  return messageList(body, protocol).filter((item) => ['user', 'human'].includes(text(item?.role || item?.speaker).toLowerCase()));
}

function messageText(message, protocol) {
  return protocol === 'gemini' ? contentText(message?.parts) : contentText(message?.content ?? message?.input ?? message?.text);
}

function isTextPart(part) {
  if (typeof part === 'string') return true;
  if (!part || typeof part !== 'object' || part.type === 'image_url' || part.type === 'image' || part.type === 'input_image' || part.inlineData || part.file_data || part.image_url) return false;
  return part.type === 'text' || part.type === 'input_text' || (!part.type && typeof part.text === 'string');
}

function partText(part) {
  return typeof part === 'string' ? part : text(part?.text);
}

function transformMessageText(message, transform, protocol, shouldTransform = null) {
  const copy = { ...message };
  const key = protocol === 'gemini' ? 'parts' : message.content !== undefined ? 'content' : message.input !== undefined ? 'input' : 'text';
  const value = message[key];
  if (Array.isArray(value)) {
    const indexes = value.map((part, index) => isTextPart(part) ? index : -1).filter((index) => index >= 0);
    if (!indexes.length) return copy;
    const selected = shouldTransform
      ? indexes.filter((index) => shouldTransform(partText(value[index])))
      : [indexes.find((index) => messageText(message, protocol).includes(partText(value[index]))) ?? indexes.at(-1)];
    const targets = selected.length ? new Set(selected) : new Set([indexes.at(-1)]);
    copy[key] = value.map((part, index) => targets.has(index)
      ? (typeof part === 'string' ? transform(part) : { ...part, text: transform(part.text) })
      : part);
    return copy;
  }
  if (typeof value === 'string') copy[key] = transform(value);
  return copy;
}

function mapUserMessages(body, protocol, transform, latestOnly = false) {
  const key = protocol === 'gemini' ? 'contents' : Array.isArray(body.messages) ? 'messages' : 'input';
  if (!Array.isArray(body[key])) return body;
  const userIndexes = body[key].map((item, idx) => ['user', 'human'].includes(text(item?.role || item?.speaker).toLowerCase()) ? idx : -1).filter((idx) => idx >= 0);
  const lastUserIndex = userIndexes.at(-1);
  const copy = { ...body, [key]: body[key].map((item, idx) => {
    if (latestOnly && idx !== lastUserIndex) return item;
    if (!['user', 'human'].includes(text(item?.role || item?.speaker).toLowerCase()) || !messageText(item, protocol).includes('[Context:')) return item;
    return transformMessageText(item, transform, protocol, (value) => value.includes('[Context:'));
  }) };
  return copy;
}

function replaceLatestUser(body, protocol, userText, knownPersonaIds) {
  const key = protocol === 'gemini' ? 'contents' : Array.isArray(body.messages) ? 'messages' : 'input';
  if (!Array.isArray(body[key])) return body;
  const indexes = body[key].map((item, index) => ['user', 'human'].includes(text(item?.role || item?.speaker).toLowerCase()) ? index : -1).filter((index) => index >= 0);
  const index = indexes.at(-1);
  if (index === undefined) return body;
  const message = body[key][index];
  const copy = { ...body, [key]: [...body[key]] };
  copy[key][index] = transformMessageText(
    message,
    (value) => {
      const parsed = parseUserTurnDirective(value, knownPersonaIds);
      return parsed.matched ? parsed.text : userText;
    },
    protocol,
    (value) => parseUserTurnDirective(value, knownPersonaIds).matched
  );
  return copy;
}

function formatResponsesSysContent(item, value) {
  if (Array.isArray(item?.content)) return item.content.map((part) => part?.type === 'input_text' ? { ...part, text: value } : part).length ? [{ type: 'input_text', text: value }] : [{ type: 'input_text', text: value }];
  return value;
}

function replaceSystem(body, protocol, persona, mode, renderedPersona, host) {
  const copy = { ...body };
  if (protocol === 'chat') {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const indexes = messages.map((item, index) => ['system', 'developer'].includes(text(item?.role).toLowerCase()) ? index : -1).filter((index) => index >= 0);
    const first = messages[indexes[0]];
    if (mode === 'strict') {
      const inheritedCacheControl = Array.isArray(first?.content)
        ? first.content.find((part) => part && typeof part === 'object' && part.cache_control)?.cache_control
        : undefined;
      const content = inheritedCacheControl
        ? [{ type: 'text', text: renderedPersona, cache_control: inheritedCacheControl }]
        : renderedPersona;
      const next = { ...(first || { role: 'system' }), content };
      copy.messages = messages.filter((item) => !['system', 'developer'].includes(text(item?.role).toLowerCase()));
      copy.messages.splice(indexes[0] ?? 0, 0, next);
    } else if (mode === 'suffix') {
      if (!indexes.length) {
        copy.messages = [{ role: 'system', content: renderedPersona }, ...messages];
      } else {
        const lastIdx = indexes.at(-1);
        copy.messages = messages.map((item, index) => {
          if (index !== lastIdx) return item;
          if (Array.isArray(item.content) && item.content.some((part) => part && typeof part === 'object' && part.cache_control)) {
            return {
              ...item,
              content: [
                ...item.content.map((part) => (part && typeof part === 'object' ? { ...part } : part)),
                { type: 'text', text: renderedPersona }
              ]
            };
          }
          const existing = contentText(item.content);
          return transformMessageText(item, () => `${existing}\n\n${renderedPersona}`.trim(), protocol);
        });
      }
    } else {
      copy.messages = messages.map((item, index) => {
        if (!['system', 'developer'].includes(text(item?.role).toLowerCase())) return item;
        const existing = contentText(item.content);
        const cleaned = mode === 'replace' ? scrubHostSystemPrompt(existing, host) : existing;
        const value = index === indexes[0] ? `${renderedPersona}\n\n${cleaned}`.trim() : cleaned;
        return transformMessageText(item, () => value, protocol);
      });
      if (!first) copy.messages.unshift({ role: 'system', content: renderedPersona });
    }
    return copy;
  }
  if (protocol === 'responses') {
    const input = Array.isArray(body.input) ? body.input : [];
    const indexes = input.map((item, index) => ['system', 'developer'].includes(text(item?.role).toLowerCase()) ? index : -1).filter((index) => index >= 0);
    const first = input[indexes[0]];
    const hasInstructions = typeof body.instructions === 'string' && body.instructions.length > 0;
    if (mode === 'strict') {
      if (hasInstructions && indexes.length) {
        copy.input = input.filter((item) => !['system', 'developer'].includes(text(item?.role).toLowerCase()));
        copy.instructions = renderedPersona;
      } else if (indexes.length) {
        copy.input = input.filter((item) => !['system', 'developer'].includes(text(item?.role).toLowerCase()));
        copy.input.splice(indexes[0], 0, { ...(first || { role: 'system' }), content: formatResponsesSysContent(first, renderedPersona) });
      } else if (hasInstructions) copy.instructions = renderedPersona;
      else copy.input = [{ role: 'system', content: renderedPersona }, ...input];
    } else if (mode === 'suffix') {
      if (indexes.length) {
        const lastIdx = indexes.at(-1);
        copy.input = input.map((item, index) => {
          if (index !== lastIdx) return item;
          const existing = contentText(item.content);
          return transformMessageText(item, () => `${existing}\n\n${renderedPersona}`.trim(), protocol);
        });
      } else if (hasInstructions) {
        copy.instructions = `${body.instructions}\n\n${renderedPersona}`.trim();
      } else {
        copy.instructions = renderedPersona;
      }
    } else {
      const current = hasInstructions ? body.instructions : contentText(first?.content);
      const scrubbed = mode === 'replace' ? scrubHostSystemPrompt(current, host) : current;
      const next = `${renderedPersona}\n\n${scrubbed}`.trim();
      if (hasInstructions) {
        copy.instructions = next;
        copy.input = input.map((item, index) => indexes.includes(index) ? transformMessageText(item, (value) => mode === 'replace' ? scrubHostSystemPrompt(value, host) : value, protocol) : item);
      } else if (first) {
        copy.input = input.map((item, index) => {
          if (!indexes.includes(index)) return item;
          const value = index === indexes[0] ? next : (mode === 'replace' ? scrubHostSystemPrompt(contentText(item.content), host) : contentText(item.content));
          return transformMessageText(item, () => value, protocol);
        });
      } else copy.instructions = renderedPersona;
    }
    return copy;
  }
  if (protocol === 'anthropic') {
    const blocks = Array.isArray(body.system) ? body.system : body.system ? [{ type: 'text', text: body.system }] : [];
    const inheritedCacheControl = blocks.find((block) => block && typeof block === 'object' && block.cache_control)?.cache_control;
    const nextBlocks = mode === 'strict'
      ? [inheritedCacheControl ? { type: 'text', text: renderedPersona, cache_control: inheritedCacheControl } : { type: 'text', text: renderedPersona }]
      : mode === 'suffix'
        ? [...blocks.map((block) => ({ ...block })), { type: 'text', text: renderedPersona }]
        : mode === 'replace'
          ? [{ type: 'text', text: renderedPersona }, ...blocks.map((block) => ({ ...block, text: scrubHostSystemPrompt(text(block.text), host) })).filter((block) => block.text.trim() !== '')]
          : [{ type: 'text', text: renderedPersona }, ...blocks.map((block) => ({ ...block }))];
    copy.system = nextBlocks;
    return copy;
  }
  const key = Object.hasOwn(body, 'system_instruction') ? 'system_instruction' : 'systemInstruction';
  const instruction = body[key] && typeof body[key] === 'object' ? { ...body[key] } : {};
  const parts = Array.isArray(instruction.parts) ? instruction.parts : [];
  if (mode === 'strict') {
    copy[key] = { ...instruction, parts: [{ text: renderedPersona }] };
  } else if (mode === 'suffix') {
    copy[key] = { ...instruction, parts: [...parts.map((part) => ({ ...part })), { text: renderedPersona }] };
  } else {
    const cleaned = mode === 'replace' ? parts.map((part) => part?.text ? { ...part, text: scrubHostSystemPrompt(part.text, host) } : part) : parts.map((part) => ({ ...part }));
    copy[key] = { ...instruction, parts: [{ text: renderedPersona }, ...cleaned] };
  }
  return copy;
}

export function parsePromptFile(raw) {
  const source = text(raw);
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?([\s\S]*)$/);
  if (!match) return { meta: {}, body: source.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].replace(/^['"]|['"]$/g, '');
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    meta[key] = val;
  }
  return { meta, body: match[2].trim() };
}

export function loadProjectPersona(cwd) {
  if (!cwd) return null;
  try {
    const filePath = path.resolve(cwd, PROJECT_CONFIG_FILENAME);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const cached = personaFiles.get(filePath);
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      const parsed = parsePromptFile(fs.readFileSync(filePath, 'utf8'));
      personaFiles.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
    }
    const { meta, body } = personaFiles.get(filePath).parsed;
    if (meta.enabled === false || !body) return null;
    const rawMode = typeof meta.mode === 'string' ? meta.mode.toLowerCase() : 'replace';
    const mode = ACTIVE_PROJECT_MODES.has(rawMode) ? rawMode : 'replace';
    return {
      mode: mode === 'fallback' ? 'replace' : mode,
      keepCwd: typeof meta.keepCwd === 'boolean' ? meta.keepCwd : undefined,
      persona: {
        id: 'project-file',
        name: typeof meta.name === 'string' && meta.name ? meta.name : PROJECT_CONFIG_FILENAME,
        template: body,
        filePath
      }
    };
  } catch {
    return null;
  }
}

function loadPersonas(config) {
  const map = {};
  for (const persona of config.personas) {
    if (!persona.filePath) {
      map[persona.id] = persona;
      continue;
    }
    try {
      const filePath = path.resolve(persona.filePath);
      const stat = fs.statSync(filePath);
      const cached = personaFiles.get(filePath);
      if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) personaFiles.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content: parsePromptFile(fs.readFileSync(filePath, 'utf8')).body });
      map[persona.id] = { ...persona, template: personaFiles.get(filePath).content };
    } catch {
      map[persona.id] = persona;
    }
  }
  return map;
}

function protocolFor(body, ctx) {
  return text(ctx?.protocol || body?.protocol || 'chat').toLowerCase();
}

function envelopeFor(body, protocol, ctx) {
  const users = userMessages(body, protocol).map((item) => messageText(item, protocol));
  return { protocol, model: text(body.model || ctx?.model), agent: text(ctx?.agent || body.agent), cwd: text(body.cwd || ctx?.cwd) || extractWorkspaceCwd(systemText(body, protocol)), systemText: systemText(body, protocol), userText: users.at(-1) || '', userTurns: users };
}

function report(ctx, code, bytes) {
  try {
    if (typeof ctx?.report === 'function') ctx.report(code, Math.min(32768, Math.max(0, bytes)));
  } catch {}
}

function identityKey(body, protocol, agent) {
  return `${protocol}:${agent}:${JSON.stringify(body)}`;
}

function restoreIfReentered(body, protocol, agent) {
  if (!originalBodies.size) return body;
  const saved = originalBodies.get(identityKey(body, protocol, agent));
  return saved ? cloneBody(saved.body) : body;
}

function rememberOriginal(key, body, bytes) {
  if (bytes > MAX_ORIGINAL_BYTES || originalBodies.has(key)) return;
  originalBodies.set(key, { body: cloneBody(body), bytes });
  originalBytes += bytes;
  while (originalBodies.size > MAX_ORIGINALS || originalBytes > MAX_ORIGINAL_BYTES) {
    const first = originalBodies.keys().next().value;
    originalBytes -= originalBodies.get(first).bytes;
    originalBodies.delete(first);
  }
}

function immutableSnapshot(body) {
  const snapshot = {};
  for (const key of MAGPIE_IMMUTABLE_WIRE_KEYS) snapshot[key] = body?.[key];
  snapshot.configTools = body?.config?.tools;
  snapshot.configToolConfig = body?.config?.toolConfig;
  return snapshot;
}

function immutableKeysIntact(before, after) {
  return [...MAGPIE_IMMUTABLE_WIRE_KEYS, 'configTools', 'configToolConfig'].every((key) => JSON.stringify(before[key]) === JSON.stringify(key === 'configTools' ? after?.config?.tools : key === 'configToolConfig' ? after?.config?.toolConfig : after?.[key]));
}

export function onRequest(body, ctx = {}) {
  if (!body || typeof body !== 'object') {
    report(ctx, 'empty', 0);
    return undefined;
  }
  const protocol = protocolFor(body, ctx);
  if (!['chat', 'responses', 'anthropic', 'gemini'].includes(protocol)) {
    report(ctx, 'unavailable', 0);
    return undefined;
  }
  try {
    const agent = text(ctx.agent || body.agent);
    const source = restoreIfReentered(body, protocol, agent);
    const result = cloneBody(source);
    const before = immutableSnapshot(source);
    const config = parseRouterConfig(ctx.options || {});
    const envelope = envelopeFor(result, protocol, ctx);
    const resolvedPersonas = loadPersonas(config);
    let action = decideRouteAction(envelope, config, resolvedPersonas);
    const allowProjectAutoDiscover = action.reason === 'default' || (action.reason === 'directive-on' && !action.directive?.mode);
    if (config.autoDiscoverProjectFile && action.mode === 'off' && allowProjectAutoDiscover && envelope.cwd) {
      const projectRoute = loadProjectPersona(envelope.cwd);
      if (projectRoute) {
        action = {
          ...action,
          mode: projectRoute.mode,
          personaId: projectRoute.persona.id,
          keepCwd: projectRoute.keepCwd ?? config.defaultKeepCwd,
          reason: 'project-file',
          persona: projectRoute.persona
        };
      }
    }
    const knownPersonaIds = [...new Set([BUILTIN_PERSONA.id, ...Object.keys(resolvedPersonas)])];
    let next = result;
    let reportBytes = 0;
    if (action.userText !== envelope.userText) next = replaceLatestUser(next, protocol, action.userText, knownPersonaIds);
    if (action.mode !== 'off' && action.persona) {
      const cwd = action.keepCwd ? envelope.cwd : '';
      const template = action.persona.template || '';
      let personaText = interpolatePersona(template, cwd);
      if (action.mode === 'strict' && action.keepCwd && cwd && !template.includes('{{cwd}}')) personaText = `${personaText}\n\nCurrent working directory: ${cwd}`.trim();
      reportBytes = Buffer.byteLength(personaText);
      const host = detectHostFamily(envelope.agent, envelope.systemText);
      next = replaceSystem(next, protocol, personaText, action.mode, personaText, host);
    }
    if (action.mode === 'replace' || action.mode === 'strict') {
      const singleTurnOverride = action.reason === 'directive-once' || action.reason === 'directive-@route';
      next = mapUserMessages(next, protocol, scrubAlmaUserContext, singleTurnOverride);
    }
    if (!immutableKeysIntact(before, next)) {
      report(ctx, 'invalid', 0);
      return undefined;
    }
    const sourceSerialized = JSON.stringify(source);
    const resultSerialized = JSON.stringify(next);
    const changed = sourceSerialized !== resultSerialized;
    if (changed) rememberOriginal(`${protocol}:${agent}:${resultSerialized}`, source, Buffer.byteLength(sourceSerialized));
    const telemetry = computePrefixTelemetry(next, protocol, envelope);
    recordDecision(config, envelope, action, changed, telemetry);
    report(ctx, changed ? 'ready' : 'skipped', changed ? reportBytes : 0);
    return changed ? next : undefined;
  } catch {
    report(ctx, 'invalid', 0);
    return undefined;
  }
}
