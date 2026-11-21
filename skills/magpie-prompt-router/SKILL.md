---
name: magpie-prompt-router
description: Manage Magpie Prompt Router personas, ordered routing rules, project-level .prompt-router.md files, and in-chat /route directives from any terminal ADE or agent workflow.
---

# magpie-prompt-router Companion Skill

Use this skill whenever the user wants to configure, inspect, bind, or debug conditional system prompt routing in Magpie (`magpie-prompt-router`) without opening the Magpie Web UI.

## How It Works

`magpie-prompt-router` runs inside the **Magpie gateway** (`onRequest` middleware hook) as a deterministic local rule engine—not via JEV or any LLM classifier. Routing priority:

1. Same-turn `/route` or `@route` directive in chat
2. First matching enabled rule in `options.rules` (`workspaceGlob`, `modelGlob`, `agentGlob`, `protocol`, `userKeywords`)
3. Sticky thread `/route on` state
4. Global `defaultMode` / `defaultPersonaId`
5. Project-level `<cwd>/.prompt-router.md` auto-discovery (when `autoDiscoverProjectFile` is enabled and no higher rule/directive matched)

Auxiliary calls (`*nmem*`, `*embedding*`, `*rerank*`, `*jev*`, and JSON-only background selectors) are skipped automatically.

## Workflows

### 1. Check Status & Diagnose Routing

```sh
mpr status
mpr test --model claude-sonnet-4 --agent claude-code --user "Review this diff"
```

If `installed: false`, install and enable the plugin in Magpie first:

```sh
magpie plugin add magpie-prompt-router
magpie plugin on magpie-prompt-router
```

### 2. Zero-Config Project Routing (Recommended)

Drop a `.prompt-router.md` file in the repository root so any request with that `cwd` automatically routes without adding Magpie rules:

```sh
mpr init-project --mode replace
```

Frontmatter supports `mode` (`replace` | `strict` | `append` | `fallback`), `keepCwd` (`true` | `false`), and `enabled` (`true` | `false`). Edits hot-reload automatically on `mtime`/`size` changes.

### 3. Manage Global Personas & Workspace Rules

```sh
# Add a persona backed by a local Markdown file (hot-reloaded)
mpr persona add architect --file ~/prompts/architect.md --name "Architect"

# Bind the current working directory to that persona
mpr bind-cwd architect --mode replace

# Or add a custom rule matching model / agent / keywords
mpr rule add --persona architect --mode replace --model "claude-*" --keywords "design,architecture"

# Inspect or remove rules
mpr rule list
mpr rule rm 1
```

### 4. In-Chat Directives

When traffic flows through Magpie, switch personas or modes inline in any conversation:

- `/route on <personaId> <mode>` — sticky enable for subsequent turns
- `/route once <personaId> <mode> <prompt>` or `@route <personaId> <mode> <prompt>` — single-turn override
- `/route off` — disable sticky routing (also suppresses `.prompt-router.md` for that thread)
