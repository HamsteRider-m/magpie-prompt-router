(function () {
  'use strict';
  var BUILTIN_PERSONA = { id: 'builtin-example', name: 'Concise neutral', template: 'Answer directly and clearly. Keep the response concise.\nWorking directory: {{cwd}}' };
  var MODES = ['strict', 'replace', 'fallback', 'append', 'suffix', 'off'];
  var defaults = { enabled: true, defaultMode: 'off', defaultPersonaId: BUILTIN_PERSONA.id, defaultKeepCwd: true, bypassAuxiliary: true, autoDiscoverProjectFile: true, excludedModelGlobs: ['*nmem*', '*embedding*', '*rerank*', '*jev*'], personas: [BUILTIN_PERSONA], rules: [] };
  var state = { options: copy(defaults), timer: null };
  var host = window.magpie || {};
  var optionsApi = host.options || {};

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function el(id) { return document.getElementById(id); }
  function value(id) { return el(id).value; }
  function text(value) { return typeof value === 'string' ? value : ''; }
  function list(value) { return Array.isArray(value) ? value : text(value).split(',').map(function (item) { return item.trim(); }).filter(Boolean); }
  function excluded(config) { return config.excludedModelGlobs === undefined ? defaults.excludedModelGlobs : list(config.excludedModelGlobs); }
  function glob(valueText, pattern) { var escaped = text(pattern || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'); return new RegExp('^' + escaped + '$', 'i').test(text(valueText)); }
  var GA_TAIL_BLOCK_RE = /(?:\r?\n){2,}(?=<nmem_context\b|<project_rules\b|<skill_pointers\b|\[Role Instructions\]|\[Role:\s|\[Long-Task & Delegation Guard\]|\[T3 Workspace\]|\[Pre-existing dirty|\[Git )/;
  function getHumanSlice(rawTurn) {
    var message = text(rawTurn);
    var sentAt = message.indexOf('[Message sent-at:');
    if (sentAt < 0) {
      var tailMatch = message.match(GA_TAIL_BLOCK_RE);
      if (tailMatch && tailMatch.index > 0) return { human: message.slice(0, tailMatch.index) };
      return { human: message };
    }
    var sentAtEnd = message.indexOf(']', sentAt);
    if (sentAtEnd < 0) return { human: message };
    var humanStart = sentAtEnd + 1;
    while (humanStart < message.length && /[\r\n \t]/.test(message[humanStart])) humanStart += 1;
    var guidelines = message.indexOf('\n\n## Response Guidelines', humanStart);
    return { human: message.slice(humanStart, guidelines < 0 ? message.length : guidelines) };
  }

  function peelLeadingOverrides(source, personaIds) {
    var rest = text(source);
    var overrides = {};
    for (var i = 0; i < 2; i += 1) {
      var tokenMatch = rest.match(/^[ \t]*(\S+)([ \t]*\r?\n|[ \t]+|$)/);
      if (!tokenMatch) break;
      var token = tokenMatch[1];
      var sep = tokenMatch[2] || '';
      if (!overrides.personaId && personaIds.has(token)) overrides.personaId = token;
      else if (!overrides.mode && MODES.includes(token.toLowerCase())) overrides.mode = token.toLowerCase();
      else break;
      rest = rest.slice(tokenMatch[0].length);
      if (sep.indexOf('\n') >= 0) break;
    }
    return { personaId: overrides.personaId, mode: overrides.mode, prompt: rest.replace(/^\r?\n+/, '').trimEnd() };
  }

  function parseDirective(message, personaIds) {
    var match = getHumanSlice(message).human.match(/^\s*(\/route|@route)\b([ \t]*\r?\n|[ \t]+|$)([\s\S]*)$/i);
    if (!match) return null;
    var command = match[1].toLowerCase();
    var sep = match[2] || '';
    var rest = text(match[3]);
    if (command === '/route') {
      if (!sep || sep.indexOf('\n') >= 0) return null;
      var commandMatch = rest.match(/^(on|off|once)\b([ \t]*\r?\n|[ \t]+|$)([\s\S]*)$/i);
      if (!commandMatch) return null;
      var action = commandMatch[1].toLowerCase();
      var actionSep = commandMatch[2] || '';
      var tail = text(commandMatch[3]);
      if (action === 'off') return { command: action, prompt: tail.replace(/^\r?\n+/, '').trimEnd() };
      if (!actionSep || actionSep.indexOf('\n') >= 0) return { command: action, prompt: tail.replace(/^\r?\n+/, '').trimEnd() };
      var peeled = peelLeadingOverrides(tail, personaIds);
      return { command: action, personaId: peeled.personaId, mode: peeled.mode, prompt: peeled.prompt };
    }
    if (!sep || sep.indexOf('\n') >= 0) return { command: command, prompt: rest.replace(/^\r?\n+/, '').trimEnd() };
    var atPeeled = peelLeadingOverrides(rest, personaIds);
    return { command: command, personaId: atPeeled.personaId, mode: atPeeled.mode, prompt: atPeeled.prompt };
  }
  function auxiliary(sample, config) {
    if (excluded(config).some(function (pattern) { return glob(sample.model, pattern); })) return true;
    var system = text(sample.systemText);
    var message = text(sample.message);
    var jsonOnly = /\b(?:json|JSON)\b/.test(system) && /\b(?:tool|skill|memory|title|selector|extract|classif)/i.test(system + '\n' + message);
    return config.bypassAuxiliary !== false && jsonOnly && !/WORKING DIRECTORY|Current working directory|<cwd>/i.test(system);
  }
  function route(sample, options) {
    var config = options || state.options;
    var personas = Object.create(null);
    personas[BUILTIN_PERSONA.id] = BUILTIN_PERSONA;
    (config.personas || []).forEach(function (persona) { if (persona && persona.id) personas[persona.id] = persona; });
    var personaIds = new Set(Object.keys(personas));
    var turns = list(sample.userTurns || [sample.message]);
    var sticky = { enabled: true, mode: null, personaId: null };
    var previousActiveMode = null;
    var parsed = turns.map(function (turn) { var item = parseDirective(turn, personaIds); if (item) { if (item.command === 'on') { sticky.enabled = true; var resumedMode = sticky.mode === 'off' ? previousActiveMode : sticky.mode; sticky.mode = item.mode || resumedMode; if (sticky.mode && sticky.mode !== 'off') previousActiveMode = sticky.mode; sticky.personaId = item.personaId || sticky.personaId; } else if (item.command === 'off') { if (sticky.mode && sticky.mode !== 'off') previousActiveMode = sticky.mode; sticky.enabled = false; sticky.mode = 'off'; } } return item; });
    var latest = parsed[parsed.length - 1] || { prompt: text(sample.message), command: null };
    var explicitOnce = latest.command === 'once' || latest.command === '@route';
    if (config.enabled === false) return { mode: 'off', personaId: null, reason: 'disabled' };
    if (auxiliary({ model: sample.model, systemText: sample.systemText, message: latest.prompt || sample.message }, config) && !(explicitOnce && (config.allowExcludedModelsOnOnce || !excluded(config).some(function (pattern) { return glob(sample.model, pattern); })))) return { mode: 'off', personaId: null, reason: 'auxiliary' };
    var rules = config.rules || [];
    var rule = rules.find(function (item) { return item.enabled !== false && (!item.workspaceGlob || glob(sample.workspace, item.workspaceGlob)) && (!item.modelGlob || glob(sample.model, item.modelGlob)) && (!item.agentGlob || glob(sample.agent, item.agentGlob)) && (!item.protocol || text(item.protocol).toLowerCase() === text(sample.protocol).toLowerCase()) && list(item.userKeywords).every(function (keyword) { return text(latest.prompt || sample.message).toLowerCase().indexOf(text(keyword).toLowerCase()) >= 0; }); });
    var inheritedMode = latest.mode || (rule && rule.mode) || sticky.mode || config.defaultMode || 'off';
    var mode = (!latest.mode && explicitOnce && latest.personaId && inheritedMode === 'off') ? 'replace' : inheritedMode;
    var personaId = latest.personaId || (rule && rule.personaId) || sticky.personaId || config.defaultPersonaId || BUILTIN_PERSONA.id;
    if (explicitOnce || sticky.enabled) {
      var persona = personas[personaId] || BUILTIN_PERSONA;
      var hasCustomBuiltin = personaId === BUILTIN_PERSONA.id && (config.personas || []).some(function (item) { return item && item.id === personaId && (text(item.template).trim() || text(item.filePath).trim()); });
      if (mode === 'fallback' && ((personaId === BUILTIN_PERSONA.id && !hasCustomBuiltin) || !(text(persona.template).trim() || text(persona.filePath).trim()))) mode = 'off';
      else if (mode === 'fallback') mode = 'replace';
      return { mode: MODES.includes(mode) ? mode : 'off', personaId: explicitOnce || sticky.enabled ? personaId : null, reason: latest.command ? 'directive-' + latest.command : rule ? 'rule' : 'default' };
    }
    return { mode: 'off', personaId: null, reason: 'directive-off' };
  }
  function saveSoon() {
    el('save-status').textContent = 'Saving...';
    clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      var write = typeof optionsApi.set === 'function' ? optionsApi.set(copy(state.options)) : null;
      Promise.resolve(write).then(function () { el('save-status').textContent = 'Saved'; }).catch(function () { el('save-status').textContent = 'Save failed'; });
    }, 1050);
  }
  function sync() { state.options.enabled = el('enabled').checked; state.options.defaultMode = value('defaultMode'); state.options.defaultPersonaId = value('defaultPersona'); state.options.defaultKeepCwd = el('defaultKeepCwd').checked; state.options.bypassAuxiliary = el('bypassAuxiliary').checked; state.options.excludedModelGlobs = list(value('excludedModelGlobs')); saveSoon(); updateSimulator(); }
  function button(label, handler) { var node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', handler); return node; }
  function input(label, current, handler) { var wrap = document.createElement('label'); wrap.textContent = label; var node = document.createElement('input'); node.value = current || ''; node.addEventListener('input', handler); wrap.appendChild(node); return wrap; }
  function buildPersonaSelect(currentId, includeDefaultOption, onChange) {
    var select = document.createElement('select');
    var found = false;
    if (includeDefaultOption) {
      var defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'Default persona';
      defaultOpt.selected = !currentId;
      select.appendChild(defaultOpt);
    }
    state.options.personas.forEach(function (persona) {
      var option = document.createElement('option');
      option.value = persona.id;
      option.textContent = persona.name || persona.id;
      if (persona.id === currentId) {
        option.selected = true;
        found = true;
      }
      select.appendChild(option);
    });
    if (currentId && !found) {
      var missing = document.createElement('option');
      missing.value = currentId;
      missing.textContent = currentId + ' (missing)';
      missing.selected = true;
      select.appendChild(missing);
    }
    select.value = currentId || (includeDefaultOption ? '' : (state.options.personas[0] ? state.options.personas[0].id : ''));
    if (onChange) select.addEventListener('change', onChange);
    return select;
  }
  function renderPersonas() {
    var target = el('personas');
    target.textContent = '';
    if (Array.isArray(target.children)) target.children.length = 0;
    state.options.personas.forEach(function (persona, index) {
      var item = document.createElement('div');
      item.className = 'item';
      var head = document.createElement('div');
      head.className = 'item-head';
      var title = document.createElement('strong');
      title.textContent = persona.name || persona.id;
      head.appendChild(title);
      var actions = document.createElement('div');
      actions.className = 'item-actions';
      actions.appendChild(button('Delete', function () { state.options.personas.splice(index, 1); render(); sync(); }));
      head.appendChild(actions);
      item.appendChild(head);
      var grid = document.createElement('div');
      grid.className = 'grid';
      grid.appendChild(input('ID', persona.id, function (event) { persona.id = event.target.value; renderDefaults(); renderRules(); sync(); }));
      grid.appendChild(input('Name', persona.name, function (event) { persona.name = event.target.value; title.textContent = persona.name || persona.id; renderDefaults(); renderRules(); sync(); }));
      var template = input('Template', persona.template, function (event) { persona.template = event.target.value; sync(); });
      template.className = 'wide';
      grid.appendChild(template);
      grid.appendChild(input('Local file path', persona.filePath, function (event) { persona.filePath = event.target.value; sync(); }));
      item.appendChild(grid);
      target.appendChild(item);
    });
  }
  function renderRules() {
    var target = el('rules');
    target.textContent = '';
    if (Array.isArray(target.children)) target.children.length = 0;
    state.options.rules.forEach(function (rule, index) {
      var item = document.createElement('div');
      item.className = 'item';
      var head = document.createElement('div');
      head.className = 'item-head';
      var title = document.createElement('strong');
      title.textContent = 'Rule ' + (index + 1);
      head.appendChild(title);
      var actions = document.createElement('div');
      actions.className = 'item-actions';
      if (index) actions.appendChild(button('Up', function () { var previous = state.options.rules[index - 1]; state.options.rules[index - 1] = rule; state.options.rules[index] = previous; renderRules(); sync(); }));
      if (index < state.options.rules.length - 1) actions.appendChild(button('Down', function () { var next = state.options.rules[index + 1]; state.options.rules[index + 1] = rule; state.options.rules[index] = next; renderRules(); sync(); }));
      actions.appendChild(button('Delete', function () { state.options.rules.splice(index, 1); renderRules(); sync(); }));
      head.appendChild(actions);
      item.appendChild(head);
      var grid = document.createElement('div');
      grid.className = 'grid';
      ['workspaceGlob', 'modelGlob', 'agentGlob', 'protocol', 'userKeywords'].forEach(function (key) {
        grid.appendChild(input(key, Array.isArray(rule[key]) ? rule[key].join(', ') : rule[key], function (event) { rule[key] = key === 'userKeywords' ? list(event.target.value) : event.target.value; sync(); }));
      });
      var modes = document.createElement('select');
      modes.dataset.field = 'mode';
      MODES.forEach(function (mode) {
        var option = document.createElement('option');
        option.value = mode;
        option.textContent = mode;
        option.selected = rule.mode === mode;
        modes.appendChild(option);
      });
      modes.value = rule.mode || 'off';
      modes.addEventListener('change', function (event) { rule.mode = event.target.value; sync(); });
      var modeLabel = document.createElement('label');
      modeLabel.textContent = 'Mode';
      modeLabel.appendChild(modes);
      grid.appendChild(modeLabel);
      var personaSelect = buildPersonaSelect(rule.personaId, true, function (event) { rule.personaId = event.target.value; sync(); });
      personaSelect.dataset.field = 'personaId';
      var personaLabel = document.createElement('label');
      personaLabel.textContent = 'Persona';
      personaLabel.appendChild(personaSelect);
      grid.appendChild(personaLabel);
      item.appendChild(grid);
      target.appendChild(item);
    });
  }
  function renderDefaults() {
    var select = el('defaultPersona');
    select.textContent = '';
    if (Array.isArray(select.children)) select.children.length = 0;
    var found = false;
    state.options.personas.forEach(function (persona) {
      var option = document.createElement('option');
      option.value = persona.id;
      option.textContent = persona.name || persona.id;
      if (persona.id === state.options.defaultPersonaId) {
        option.selected = true;
        found = true;
      }
      select.appendChild(option);
    });
    if (state.options.defaultPersonaId && !found) {
      var missing = document.createElement('option');
      missing.value = state.options.defaultPersonaId;
      missing.textContent = state.options.defaultPersonaId + ' (missing)';
      missing.selected = true;
      select.appendChild(missing);
    }
    select.value = state.options.defaultPersonaId || (state.options.personas[0] ? state.options.personas[0].id : '');
  }
  function render() { el('enabled').checked = state.options.enabled !== false; el('defaultMode').value = state.options.defaultMode || 'off'; el('defaultKeepCwd').checked = state.options.defaultKeepCwd !== false; el('bypassAuxiliary').checked = state.options.bypassAuxiliary !== false; el('excludedModelGlobs').value = list(state.options.excludedModelGlobs).join(', '); renderDefaults(); renderPersonas(); renderRules(); updateSimulator(); }
  function updateSimulator() { if (!el('sim-result')) return; var result = route({ model: value('sim-model'), workspace: value('sim-workspace'), agent: value('sim-agent'), protocol: value('sim-protocol'), systemText: value('sim-system'), message: value('sim-message'), userTurns: [value('sim-message')] }); el('sim-result').textContent = result.mode + ' · ' + result.reason + (result.personaId ? ' · ' + result.personaId : ''); }
  function init() { var loaded = typeof optionsApi.get === 'function' ? optionsApi.get() : null; Promise.resolve(loaded).then(function (saved) { state.options = Object.assign(copy(defaults), saved || {}, { personas: saved && saved.personas ? saved.personas : copy(defaults.personas), rules: saved && saved.rules ? saved.rules : [] }); render(); }).catch(function () { render(); }); ['enabled', 'defaultMode', 'defaultPersona', 'defaultKeepCwd', 'bypassAuxiliary', 'excludedModelGlobs'].forEach(function (id) { el(id).addEventListener('change', sync); }); el('excludedModelGlobs').addEventListener('input', sync); ['sim-model', 'sim-workspace', 'sim-agent', 'sim-protocol', 'sim-system', 'sim-message'].forEach(function (id) { el(id).addEventListener('input', updateSimulator); el(id).addEventListener('change', updateSimulator); }); el('add-persona').addEventListener('click', function () { state.options.personas.push({ id: 'persona-' + Date.now(), name: 'New persona', template: BUILTIN_PERSONA.template }); render(); sync(); }); el('add-rule').addEventListener('click', function () { state.options.rules.push({ enabled: true, mode: 'off', personaId: state.options.defaultPersonaId }); renderRules(); sync(); }); el('simulate').addEventListener('click', updateSimulator); var applyTheme = function (theme) { var isDark = typeof theme === 'object' ? Boolean(theme && theme.dark) : theme === 'dark'; document.documentElement.dataset.theme = isDark ? 'dark' : 'light'; }; if (typeof host.onTheme === 'function') host.onTheme(applyTheme); if (host.ready && typeof host.ready.then === 'function') host.ready.then(applyTheme, function () {}); if (host.theme) applyTheme(host.theme); }
  window.PromptRouterPage = { route: route, getOptions: function () { return copy(state.options); }, init: init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
