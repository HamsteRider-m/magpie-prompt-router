# magpie-purge

`magpie-purge` is a self-contained Magpie gateway plugin for conditional system prompt routing. It supports Alma, Pi, Claude Code, Codex, and OpenCode request paths through Magpie's `chat`, `responses`, `anthropic`, and `gemini` hooks.

## Install

Install from a local checkout:

```sh
magpie plugin add /path/to/magpie-purge
```

Install from GitHub. GitHub authentication is required while the repository is private:

```sh
magpie plugin add github:HamsteRider-m/magpie-purge
```

Open the Magpie settings page to enable the plugin, define personas, and add ordered routing rules.

## Use it in chat

Use a sticky mode for later turns:

```text
/purge on persona replace
```

Use one turn without changing the thread:

```text
/purge once strict Review this code
@purge append Summarize the change
```

Disable sticky routing:

```text
/purge off
```

A bare `on` or `off` command becomes a short acknowledgement request. The provider never receives an empty user turn. Alma context and response guidelines remain in place.

## Route by request data

Rules match workspace, model, agent, protocol, and user keywords. They run from top to bottom, and the first matching rule selects the persona and mode. Alma workspace routing uses the `WORKING DIRECTORY` section. Model globs such as `claude-*` and `*nmem*` use case-insensitive `*` and `?` matching.

Auxiliary calls stay off by default. The plugin protects excluded models, memory calls, title generation, JSON selectors, and similar background requests even when `/purge on` appears earlier in the conversation. A current-turn `/purge once` or `@purge` can bypass the generic auxiliary check. Excluded model globs still win unless you set `allowExcludedModelsOnOnce`.

## Modes

| Mode | Behavior |
| --- | --- |
| `strict` | Replace all host system prompt entries with the selected persona. |
| `replace` | Scrub host persona material and prepend the selected persona before the remaining host text. |
| `fallback` | Act like `replace` when a custom persona is bound. Skip when the bound persona is still `builtin-example` or empty. |
| `append` | Prepend the selected persona before the existing host prompt. |
| `off` | Leave the host prompt and user context unchanged. |

The `{{cwd}}` placeholder expands to the request working directory when `keepCwd` is enabled. Strict mode adds the current working directory when the persona template has no placeholder and a working directory is available. The hook keeps `cwd` on the wire in every mode.

## Host boundary

The hook clones request containers and preserves these seven immutable wire keys. It compares their JSON values before and after rewriting:

`tools`, `tool_choice`, `function_call`, `functions`, `toolConfig`, `model`, `stream`

It also preserves `body.config.tools` and `body.config.toolConfig`. It preserves multimodal user content when it removes a directive. Anthropic system arrays keep their block fields and `cache_control` object identity.

The hook restores the original body before exact account fallback re-entry. It reports only Magpie's valid statuses and fails open when input validation or the immutable-key check fails.

## Development

Run the test suite with Node:

```sh
npm test
```

Run it with Bun:

```sh
bun test
```

The test suite covers real Alma envelopes, auxiliary immunity, all four wire protocols, retry re-entry, persona file reload, page simulator parity, immutable keys, and host-budget timing.

## Credits

The routing ideas build on work by YuJunZhiXue/dsh-purge, [ZiChuanLan/pi-purge](https://github.com/ZiChuanLan/pi-purge), and [ZiChuanLan/agent-purge](https://github.com/ZiChuanLan/agent-purge).

Licensed under the MIT License.
