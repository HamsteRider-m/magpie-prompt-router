# Architecture rationale

## Synthesis decision

`magpie-prompt-router` uses a two-module, purely deterministic local runtime—it does **not** use JEV or any external LLM classifier. `src/engine.js` owns pure routing decisions. `src/hooks.js` translates Magpie requests into the engine input shape and applies the result to each wire protocol. The settings page uses a classic zero-build script so Magpie can load it inside its iframe CSP without a bundler or `fetch`.

This split keeps directive reduction, rule matching, and host-context scrubbers testable without a host. The hook owns file reads, retry restoration, cloning, protocol shapes, and Magpie reporting. The page owns option editing and a client-side simulator (`window.PromptRouterPage.route`) that mirrors the engine decision output.

## Request data shape

The engine receives an envelope with `protocol`, `model`, `agent`, `cwd`, `systemText`, `userText`, and ordered `userTurns`. The hook derives this envelope from `chat`, `responses`, `anthropic`, or `gemini` requests. `decideRouteAction` returns a mode, persona, cwd policy, reason, and rewritten latest user turn.

Chat system prompts live in `messages` items with `role` set to `system` or `developer`. Responses requests can carry system text in both `instructions` and `input` items with `role` set to `system` or `developer`. Anthropic uses `body.system`. Gemini uses either `body.systemInstruction` or `body.system_instruction`.

Alma user turns keep their `[Context: ...][Message sent-at: ...]` prefix and trailing `## Response Guidelines` block. Directive parsing changes only the human text after the message timestamp. Replace and strict modes remove Alma persona, emotion, fatigue, and selfie sections while retaining operational sections such as `WORKING DIRECTORY`, `SYSTEM INFO`, `READ-ONLY AUTHORITY`, and `<available_skills>`.

## Directive precedence

The reducer reads user turns in order. `/route on` enables sticky routing. `/route off` disables it. `/route once` and `@route` apply to the current turn only. A same-turn persona or mode override wins over an ordered rule. Rules win over sticky defaults. The configured default is the final choice.

Malformed `/route` text stays ordinary user text. A bare `on` or `off` directive becomes a short acknowledgement request (`[magpie-prompt-router: state -> ...]`) so a provider never receives an empty user turn.

## Auxiliary calls

The hook classifies excluded model globs before applying sticky state or declarative rules. It also detects JSON-only selectors, title generation, memory extraction, and similar calls that lack a main-agent working-directory marker. An explicit one-turn directive (`/route once` or `@route`) can bypass the generic auxiliary classifier. Excluded model globs still win unless `allowExcludedModelsOnOnce` is enabled.

## Modes

`strict` replaces all host system prompt entries with the selected persona. `replace` scrubs host persona material and prepends the selected persona before the remaining host text. `fallback` acts like `replace` when a custom persona is bound and skips when the bound persona is still `builtin-example` or empty. `append` prepends the selected persona before the existing host prompt. `off` leaves the host prompt and user context unchanged.

The hook preserves Anthropic system arrays. It preserves block fields and the original `cache_control` object on surviving blocks. It also keeps these seven immutable wire keys unchanged:

`tools`, `tool_choice`, `function_call`, `functions`, `toolConfig`, `model`, `stream`

The hook also preserves `body.config.tools` and `body.config.toolConfig`.

## Retry behavior

Account fallback can re-enter the hook with the already rewritten body. The hook stores exact original bodies in a bounded 64-entry, 2 MB map. An exact retry lookup restores the original body before the hook evaluates it again. The map uses the protocol, agent, and serialized rewritten body as its key.

## Persona files

A persona can point to a local Markdown file. The hook reads the file synchronously only when its `mtimeMs` or `size` changes. It removes YAML frontmatter before interpolation. Repeated requests use the cached string while an edited prompt file reloads automatically after a change.

## Settings page

`page/app.js` uses `window.magpie.options.get` and `window.magpie.options.set` when the bridge exists, falling back to defaults for standalone preview. Writes wait 1,050 ms after the last edit to respect Magpie's one-request-per-second option limit. Each rule exposes both mode and persona `<select>` controls (including a missing-persona fallback display), and persona additions/edits/deletions keep all persona selectors synchronized. `page/style.css` consumes Magpie's CSS theme variables (`--magpie-bg`, `--magpie-surface`, `--magpie-text`, `--magpie-muted`, `--magpie-border`, `--magpie-accent`, `--magpie-glass-content-fill`) with light/dark fallbacks.
