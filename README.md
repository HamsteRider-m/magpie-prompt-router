# magpie-purge

**English** | [简体中文](README.zh-CN.md)

`magpie-purge` is a self-contained Magpie gateway plugin for conditional system prompt routing. It supports Alma, Pi, Claude Code, Codex, and OpenCode request paths through Magpie's `chat`, `responses`, `anthropic`, and `gemini` hooks.

## Install

Install from npm / Magpie Discover:

```sh
magpie plugin add magpie-purge
```

Or install from GitHub or a local checkout:

```sh
magpie plugin add github:HamsteRider-m/magpie-purge
magpie plugin add /path/to/magpie-purge
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

## External presets (`some-magic`)

`magpie-purge` does not ship third-party `some-magic` prompt bodies inside the repository or npm tarball. Pull the 20 Markdown persona presets from [ZiChuanLan/some-magic](https://github.com/ZiChuanLan/some-magic) on demand with the included sync command:

```sh
npx magpie-purge-presets
# or inside a local checkout:
npm run sync-presets
```

By default, presets are synced to `~/.config/magpie/magpie-purge/presets/some-magic` (so they persist across `magpie plugin update`). Pass `--local` to sync into `./presets/some-magic`, or `--dir <path>` for a custom directory.

- Once synced, any preset ID works directly in chat commands (note: include an active mode when `defaultMode` is `off`, for example `/purge once qwen-37 strict ...` or `/purge on eni-opus-5 replace`), as `defaultPersonaId`, or in routing rules.
- Select or import presets from the **Personas** and **Defaults** sections in the Magpie settings page (`page/presets.js` carries catalog metadata only).
- Defining a persona in `options.personas` with the same `id` overrides any synced preset. Relative `filePath` values (`presets/some-magic/...`) resolve against both the plugin root and `~/.config/magpie/magpie-purge/presets/some-magic`.

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

The routing ideas build on work by YuJunZhiXue/dsh-purge, [ZiChuanLan/pi-purge](https://github.com/ZiChuanLan/pi-purge), [ZiChuanLan/agent-purge](https://github.com/ZiChuanLan/agent-purge), and [ZiChuanLan/some-magic](https://github.com/ZiChuanLan/some-magic).

Licensed under the MIT License.
