const MODES = new Set(['strict', 'replace', 'fallback', 'append', 'off']);
const DEFAULT_EXCLUDED_MODELS = ['*nmem*', '*embedding*', '*rerank*'];
const STOP_ANCHOR = String.raw`(?:\n(?=[A-Z][A-Z0-9 _-]{2,}(?::|\s+[\u2014–-]\s+)|#{1,3}\s|<[a-zA-Z_][\w-]*>|\[Context:)|$)`;

export const ACTIVE_PURGE_MODES = [...MODES].filter((mode) => mode !== 'off');
export const BUILTIN_PERSONA = {
  id: 'builtin-example',
  name: 'Concise neutral',
  template: 'Answer directly and clearly. Keep the response concise.\nWorking directory: {{cwd}}'
};

function string(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function globToRegExp(glob) {
  const source = string(glob, '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i');
}

export function matchesGlob(value, glob) {
  return globToRegExp(glob).test(string(value));
}

function normalizePath(value) {
  return string(value).replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function parsePurgeConfig(rawOptions = {}) {
  const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {};
  const personas = Array.isArray(options.personas) ? options.personas.filter((item) => item && typeof item.id === 'string') : [];
  const rules = Array.isArray(options.rules) ? options.rules.filter((item) => item && typeof item === 'object') : [];
  const defaultMode = MODES.has(options.defaultMode) ? options.defaultMode : 'off';
  const excludedSource = options.excludedModelGlobs === undefined ? DEFAULT_EXCLUDED_MODELS : (Array.isArray(options.excludedModelGlobs) ? options.excludedModelGlobs : string(options.excludedModelGlobs).split(','));
  const excludedModelGlobs = excludedSource.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  return {
    enabled: options.enabled !== false,
    defaultMode,
    defaultPersonaId: string(options.defaultPersonaId, BUILTIN_PERSONA.id),
    defaultKeepCwd: options.defaultKeepCwd !== false,
    bypassAuxiliary: options.bypassAuxiliary !== false,
    allowExcludedModelsOnOnce: options.allowExcludedModelsOnOnce === true,
    excludedModelGlobs,
    personas,
    rules
  };
}

export function extractWorkspaceCwd(systemText = '') {
  const text = string(systemText);
  const patterns = [
    /WORKING DIRECTORY\s*[-\u2014:]\s*Your working directory for this conversation is:\s*([^\n<]+)/i,
    /<environment>[\s\S]*?Working directory:\s*([^\n<]+)/i,
    /Current working directory:\s*([^\n<]+)/i,
    /Working directory:\s*([^\n<]+)/i,
    /<cwd>([^<]+)<\/cwd>/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return normalizePath(match[1].trim());
  }
  return '';
}

export function interpolatePersona(template, cwd = '') {
  const text = string(template);
  if (cwd) return text.replaceAll('{{cwd}}', cwd);
  return text.split('\n').map((line) => {
    if (!line.includes('{{cwd}}')) return line;
    const before = line.slice(0, line.indexOf('{{cwd}}')).trimEnd();
    const after = line.slice(line.indexOf('{{cwd}}') + 7).trimStart();
    return before.endsWith(':') && !after ? '' : line.replace(/\s*\{\{cwd\}\}\s*/, '\n');
  }).filter(Boolean).join('\n').trim();
}

function getHumanSlice(rawTurnText) {
  const text = string(rawTurnText);
  const sentAt = text.indexOf('[Message sent-at:');
  if (sentAt < 0) return { prefix: '', human: text, suffix: '', alma: false };
  const sentAtEnd = text.indexOf(']', sentAt);
  if (sentAtEnd < 0) return { prefix: '', human: text, suffix: '', alma: false };
  let humanStart = sentAtEnd + 1;
  while (humanStart < text.length && /[\r\n \t]/.test(text[humanStart])) humanStart += 1;
  const guidelines = text.indexOf('\n\n## Response Guidelines', humanStart);
  const humanEnd = guidelines < 0 ? text.length : guidelines;
  return { prefix: text.slice(0, humanStart), human: text.slice(humanStart, humanEnd), suffix: text.slice(humanEnd), alma: true };
}

function replaceHumanSlice(rawTurnText, humanText) {
  const slice = getHumanSlice(rawTurnText);
  return slice.alma ? `${slice.prefix}${humanText}${slice.suffix}` : humanText;
}

function parseDirectiveLine(text, knownPersonaIds) {
  const match = text.match(/^\s*(\/purge|@purge)\b(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const rest = string(match[2]).trim();
  if (command === '/purge') {
    const commandMatch = rest.match(/^(on|off|once)\b(?:\s+([\s\S]*))?$/i);
    if (!commandMatch) return null;
    const action = commandMatch[1].toLowerCase();
    const args = string(commandMatch[2]).trim();
    if (action === 'off') return { command: action, prompt: args };
    const tokens = args ? args.split(/\s+/) : [];
    const overrides = {};
    if (tokens[0] && knownPersonaIds.has(tokens[0])) overrides.personaId = tokens.shift();
    if (tokens[0] && MODES.has(tokens[0].toLowerCase())) overrides.mode = tokens.shift().toLowerCase();
    if (!overrides.personaId && tokens[0] && MODES.has(tokens[0].toLowerCase())) overrides.mode = tokens.shift().toLowerCase();
    if (!overrides.mode && tokens[0] && knownPersonaIds.has(tokens[0])) overrides.personaId = tokens.shift();
    return { command: action, ...overrides, prompt: tokens.join(' ') };
  }
  const tokens = rest ? rest.split(/\s+/) : [];
  const overrides = {};
  if (tokens[0] && knownPersonaIds.has(tokens[0])) overrides.personaId = tokens.shift();
  if (tokens[0] && MODES.has(tokens[0].toLowerCase())) overrides.mode = tokens.shift().toLowerCase();
  if (!overrides.personaId && tokens[0] && MODES.has(tokens[0].toLowerCase())) overrides.mode = tokens.shift().toLowerCase();
  if (!overrides.mode && tokens[0] && knownPersonaIds.has(tokens[0])) overrides.personaId = tokens.shift();
  return { command, ...overrides, prompt: tokens.join(' ') };
}

export function parseUserTurnDirective(rawTurnText, knownPersonaIds = []) {
  const slice = getHumanSlice(rawTurnText);
  const directive = parseDirectiveLine(slice.human, new Set(knownPersonaIds));
  if (!directive) return { matched: false, rawText: rawTurnText, text: rawTurnText };
  const prompt = directive.prompt || (directive.command === 'on' || directive.command === 'off'
    ? `[magpie-purge: state -> ${directive.command === 'on' ? 'enabled' : 'disabled'}. Acknowledge in one short sentence.]`
    : directive.prompt);
  return {
    matched: true,
    ...directive,
    prompt,
    rawText: rawTurnText,
    text: replaceHumanSlice(rawTurnText, prompt)
  };
}

export function reduceThreadDirectives(userTurns, knownPersonaIds = []) {
  const state = { enabled: true, mode: null, personaId: null, once: false };
  const turns = Array.isArray(userTurns) ? userTurns : [];
  const parsed = turns.map((turn) => {
    const result = parseUserTurnDirective(turn, knownPersonaIds);
    if (!result.matched) return result;
    if (result.command === 'on') {
      state.enabled = true;
      state.mode = result.mode || state.mode;
      state.personaId = result.personaId || state.personaId;
    } else if (result.command === 'off') {
      state.enabled = false;
      state.mode = 'off';
    } else {
      state.once = true;
      state.enabled = true;
      state.mode = result.mode || state.mode;
      state.personaId = result.personaId || state.personaId;
    }
    return result;
  });
  return { state, turns: parsed };
}

export function detectHostFamily(agent, systemText) {
  const value = string(agent).toLowerCase();
  if (value.includes('alma') || /\bWORKING DIRECTORY\b|\bPERSONALITY:\s*\n|\bEMOTION SYSTEM\b|<notification_protocol>/i.test(string(systemText))) return 'alma';
  if (value === 'pi' || /coding agent harness|<docs>\s*Pi documentation/i.test(string(systemText))) return 'pi';
  return 'generic';
}

function hasMainAgentMarker(envelope) {
  return /WORKING DIRECTORY|Current working directory|<cwd>/i.test(string(envelope.systemText));
}

export function classifyAuxiliaryCall(envelope = {}, config = parsePurgeConfig()) {
  const model = string(envelope.model);
  if (config.excludedModelGlobs.some((glob) => matchesGlob(model, glob))) return true;
  const system = string(envelope.systemText);
  const user = string(envelope.userText);
  const jsonOnly = /\b(?:json|JSON)\b/.test(system) && /\b(?:tool|skill|memory|title|selector|extract|classif)/i.test(`${system}\n${user}`);
  return config.bypassAuxiliary && jsonOnly && !hasMainAgentMarker(envelope);
}

function ruleMatches(rule, envelope) {
  if (rule.workspaceGlob && !matchesGlob(envelope.cwd, rule.workspaceGlob)) return false;
  if (rule.modelGlob && !matchesGlob(envelope.model, rule.modelGlob)) return false;
  if (rule.agentGlob && !matchesGlob(envelope.agent, rule.agentGlob)) return false;
  if (rule.protocol && string(rule.protocol).toLowerCase() !== string(envelope.protocol).toLowerCase()) return false;
  const keywords = Array.isArray(rule.userKeywords) ? rule.userKeywords : string(rule.userKeywords).split(',').map((item) => item.trim()).filter(Boolean);
  return keywords.every((keyword) => string(envelope.userText).toLowerCase().includes(string(keyword).toLowerCase()));
}

export function scrubAlmaUserContext(rawTurnText) {
  const text = string(rawTurnText);
  const sentAt = text.indexOf('[Message sent-at:');
  if (sentAt < 0 || sentAt > 8192) return rawTurnText;
  const contextStart = text.indexOf('[Context:');
  if (contextStart < 0 || contextStart > sentAt) return rawTurnText;
  const prefix = text.slice(0, sentAt);
  const context = prefix.slice(contextStart)
    .replace(/(EMOTION SYSTEM\s*[\u2014:-][\s\S]*?)(?=\n[A-Z][A-Z0-9 _-]{2,}(?::|\s+[\u2014–-]\s+)|\n<[a-zA-Z_][\w-]*>|$)/i, '')
    .replace(/(FATIGUE SYSTEM\s*:[\s\S]*?)(?=\n[A-Z][A-Z0-9 _-]{2,}(?::|\s+[\u2014–-]\s+)|\n<[a-zA-Z_][\w-]*>|$)/i, '')
    .replace(/(SELFIE ALBUM\s*[\u2014:-][\s\S]*?)(?=\n[A-Z][A-Z0-9 _-]{2,}(?::|\s+[\u2014–-]\s+)|\n<[a-zA-Z_][\w-]*>|$)/i, '');
  return `${prefix.slice(0, contextStart)}${context}${text.slice(sentAt)}`;
}

export function scrubHostSystemPrompt(text, hostFamily = 'generic') {
  let result = string(text);
  if (hostFamily === 'alma') {
    result = result
      .replace(/^You are[^\n]*\bAlma\b[\s\S]*?(?=\n(?:PERSONALITY:|SYSTEM INFO|WORKING DIRECTORY|[A-Z][A-Z0-9 _-]{2,}(?::|\s+[\u2014–-]\s+)|<|$))/im, '')
      .replace(new RegExp(`PERSONALITY\\s*:[\\s\\S]*?${STOP_ANCHOR}`, 'i'), '\n')
      .replace(new RegExp(`EMOTION SYSTEM\\s*[\\u2014:-][\\s\\S]*?${STOP_ANCHOR}`, 'i'), '\n')
      .replace(new RegExp(`FATIGUE SYSTEM\\s*:[\\s\\S]*?${STOP_ANCHOR}`, 'i'), '\n')
      .replace(new RegExp(`SELFIE ALBUM\\s*[\\u2014:-][\\s\\S]*?${STOP_ANCHOR}`, 'i'), '\n')
      .replace(/<notification_protocol>[\s\S]*?<\/notification_protocol>/gi, '');
  } else if (hostFamily === 'pi') {
    result = result.replace(/^You are (?:a coding assistant running inside pi|an expert coding assistant operating inside pi)[^\n]*[\s\S]*?(?=\n(?:<docs>|$))/im, '').replace(/^You are an? \S[^\n]{0,160}?coding agent harness\.[^\n]*\n?/im, '').replace(/<docs>[\s\S]*?<\/docs>/gi, '');
  } else {
    result = result.replace(/^\s*(?:You are|Your name is)\s+[^\n]+\n?/gim, '');
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

function personaMap(config, resolvedPersonaMap = {}) {
  const map = { [BUILTIN_PERSONA.id]: BUILTIN_PERSONA, ...Object.fromEntries(config.personas.map((persona) => [persona.id, persona])) };
  return { ...map, ...resolvedPersonaMap };
}

export function decidePurgeAction(envelope = {}, rawOptions = {}, resolvedPersonaMap = {}) {
  const config = parsePurgeConfig(rawOptions);
  const knownPersonaIds = Object.keys(personaMap(config, resolvedPersonaMap));
  const history = Array.isArray(envelope.userTurns) ? envelope.userTurns : [];
  const reduction = reduceThreadDirectives(history, knownPersonaIds);
  const latest = reduction.turns.at(-1) || { matched: false, text: envelope.userText || '' };
  const auxiliary = classifyAuxiliaryCall({ ...envelope, userText: latest.text }, config);
  const explicitOnce = latest.matched && (latest.command === 'once' || latest.command === '@purge');
  if (!config.enabled || (auxiliary && !(explicitOnce && (config.allowExcludedModelsOnOnce || !config.excludedModelGlobs.some((glob) => matchesGlob(envelope.model, glob)))))) {
    return { mode: 'off', personaId: null, keepCwd: true, reason: config.enabled ? 'auxiliary' : 'disabled', userText: latest.text, directive: latest };
  }
  const rule = config.rules.find((candidate) => candidate.enabled !== false && ruleMatches(candidate, envelope));
  const mode = latest.mode || rule?.mode || reduction.state.mode || config.defaultMode;
  const personaId = latest.personaId || rule?.personaId || reduction.state.personaId || config.defaultPersonaId;
  const keepCwd = rule?.keepCwd ?? config.defaultKeepCwd;
  const active = explicitOnce || reduction.state.enabled;
  return {
    mode: active && MODES.has(mode) ? (mode === 'fallback' ? ((personaId === BUILTIN_PERSONA.id && !resolvedPersonaMap[personaId]?.template && !config.personas.some((item) => item.id === personaId && (item.template || item.filePath))) || !(personaMap(config, resolvedPersonaMap)[personaId]?.template || '').trim() ? 'off' : 'replace') : mode) : 'off',
    personaId: active ? personaId : null,
    keepCwd,
    reason: latest.matched ? `directive-${latest.command}` : rule ? 'rule' : 'default',
    userText: latest.text,
    directive: latest,
    persona: personaMap(config, resolvedPersonaMap)[personaId] || BUILTIN_PERSONA
  };
}

export { MODES, getHumanSlice, replaceHumanSlice };
