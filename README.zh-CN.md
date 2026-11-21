# magpie-prompt-router

[English](README.md) | **简体中文**

`magpie-prompt-router`（**提示词路由** / **Prompt Router**）是一个零运行时依赖的 Magpie 网关插件，用于在 `chat`、`responses`、`anthropic` 和 `gemini` 四种 wire 协议上按条件路由系统提示词。

插件**不内置任何红队或越狱载荷**——仅提供纯本地确定性提示词路由引擎与一条极简默认示例（`builtin-example`），适用于 Alma、Pi、Claude Code、Codex 和 OpenCode 等客户端。

## 核心特性

- **纯本地确定性路由（不使用 JEV / 不调用 LLM 分类器）**：在 Magpie 网关的 `onRequest` 钩子内以纯 JavaScript 同步执行（glob、关键词与正则匹配），零额外模型调用、零网络延迟、零外部路由依赖。
- **有序条件路由规则**：按工作区 glob、模型 glob、Agent glob、协议与用户关键词从上到下匹配，首条命中即决定 persona 与模式。
- **聊天内 `/route` 与 `@route` 指令**：支持粘性切换或单轮生效，并在发往上游前自动从 wire 上剥离指令。
- **辅助调用保护**：即使对话历史中开启了粘性路由，仍默认放行排除模型、记忆提取、标题生成、JSON 选择器等后台请求。
- **宿主上下文清理**：在 `replace` / `strict` 模式下清理 Alma、Pi 或通用宿主的人格、情绪、疲劳与自拍区块，同时保留 `WORKING DIRECTORY`、`SYSTEM INFO`、`READ-ONLY AUTHORITY` 和 `<available_skills>` 等运行区块。
- **本地 Markdown 热加载**：persona 可绑定本地 `.md` 文件，自动剥离 YAML frontmatter 并在 `mtime`/`size` 变化时热更新。
- **零构建设置页与实时模拟器**：适配 Magpie 2.4+ Liquid Glass 主题变量，内置交互式路由模拟器。

## 路由实现原理

`magpie-prompt-router` **不是**基于 JEV 或任何 LLM 路由模型实现的，而是运行在 Magpie `onRequest` 中间件钩子中的两模块纯本地同步管线（`src/hooks.js` → `src/engine.js`）：

1. **请求归一化（`envelopeFor`）**：从 `chat`、`responses`、`anthropic`、`gemini` 四种协议中提取 `{ protocol, model, agent, cwd, systemText, userText, userTurns }`。
2. **对话指令归约（`reduceThreadDirectives`）**：按顺序扫描所有用户轮次（仅解析 Alma `[Context: ...][Message sent-at: ...]` 与 `## Response Guidelines` 之间的人类文本切片），计算线程级粘性 `/route on|off` 状态以及当前轮 `/route once` / `@route` 覆盖。
3. **辅助调用免疫（`classifyAuxiliaryCall`）**：在改写前优先检查 `excludedModelGlobs`（默认 `*nmem*`、`*embedding*`、`*rerank*`、`*jev*`）以及无主 Agent 工作目录标记的 JSON 选择器/记忆/标题/分类等后台调用。
4. **有序规则匹配（`options.rules`）**：自上而下遍历启用的规则，单条规则内已填写的条件须同时满足（`workspaceGlob`、`modelGlob`、`agentGlob`、精确 `protocol` 以及全部 `userKeywords`），首条命中生效。
5. **优先级链**：当前轮 `/route` 或 `@route` 覆盖 > 首条命中规则 > 线程粘性 `/route on` 状态 > 全局 `defaultMode` 与 `defaultPersonaId`。
6. **协议改写与边界校验**：按选定模式改写系统提示词（并在 `replace`/`strict` 下清洗 Alma 用户上下文），校验 7 个不可变 wire 字段与 `body.config.tools`/`body.config.toolConfig` 未被破坏，否则 fail-open 放行原请求。

## 所有配置的前置要求

要让提示词路由按预期生效，需要满足以下前置条件：

- **运行环境与网关版本**：
  - 安装在支持中间件插件与自定义设置页的 Magpie 网关中（推荐 Magpie 2.4+，以适配 Liquid Glass 主题变量）。
  - 本地开发、测试或 CI 校验需要 Node.js `>= 20` 或 Bun `>= 1.3.0`（零第三方依赖，无需 `npm install`）。
- **流量路径前提**：
  - 客户端（Alma、Pi、Claude Code、Codex、OpenCode）的出站请求必须经过已安装并启用本插件的 Magpie 网关实例，且使用 `chat`、`responses`、`anthropic` 或 `gemini` 协议之一。
- **默认安全态与激活前提**：
  - 插件默认 `enabled: true` 且 `defaultMode: "off"`，不会主动改写任何请求；必须满足以下至少一项才会触发改写：将 `defaultMode` 设为非 `off`、在 `options.rules` 中添加至少一条启用规则，或在聊天中输入 `/route` / `@route` 指令。
  - 若使用 `fallback` 模式或自定义提示词，须先在 `options.personas` 中定义至少一个自定义 persona（内联 `template` 或本地 `.md` `filePath`）；若绑定对象仍是 `builtin-example` 或内容为空，`fallback` 会自动跳过。
- **按字段匹配的规则前提**：
  - `workspaceGlob`：请求需携带 `body.cwd`/`ctx.cwd`，或系统提示词中包含可解析的工作目录标记（如 Alma 的 `WORKING DIRECTORY`、`<environment> Working directory:`、`Current working directory:`、`Working directory:` 或 `<cwd>...</cwd>`）。
  - `agentGlob`：Magpie 需能识别并传入 `ctx.agent` / `body.agent`。
  - `modelGlob`：对 `body.model` / `ctx.model` 执行不区分大小写的 `*`、`?` glob 匹配。
  - 本地 Markdown persona（`filePath`）：文件路径必须对运行 Magpie 网关的本机进程可读（支持绝对路径或相对于进程工作目录的相对路径）；读取时自动剥离 YAML frontmatter，并在 `mtime` 或 `size` 变化时热更新。
- **辅助调用保护前提**：
  - 默认 `bypassAuxiliary: true` 且 `excludedModelGlobs` 包含 `["*nmem*", "*embedding*", "*rerank*", "*jev*"]`。如使用其他记忆、嵌入或后台模型，请补充到 `excludedModelGlobs`；仅当确实希望单轮 `/route once` 或 `@route` 强制覆盖排除模型时，才开启 `allowExcludedModelsOnOnce: true`。
- **CI/CD 与自动发布前提（维护者）**：
  - GitHub 仓库开启 Actions 后，每次推送 `main` 或发起 PR 会自动运行测试与发包校验。
  - 推送 `v*` tag 自动发布到 npm 前，需在 GitHub Secrets 配置 `NPM_TOKEN`（或配置 npm Trusted Publishing），且 tag 版本号需与 `package.json` 的 `version` 一致（例如 `v0.1.0`）。

## 安装与终端 CLI

从 npm 安装：

```sh
magpie plugin add magpie-prompt-router
magpie plugin on magpie-prompt-router
```

从 GitHub 或本地目录安装：

```sh
magpie plugin add github:HamsteRider-m/magpie-prompt-router
magpie plugin add /path/to/magpie-prompt-router
```

除在 Magpie 的 **提示词路由（Prompt Router）** 设置页配置外，也可以直接用内置的 `mpr`（`magpie-prompt-router`）终端 CLI 完成全部配置与测试：

```sh
# 零配置项目级路由：在当前仓库生成 ./.prompt-router.md（按 cwd 自动发现）
npx magpie-prompt-router init-project --mode replace

# 或在终端直接管理 ~/.config/magpie/plugins.json 中的人设与规则
npx magpie-prompt-router status
npx magpie-prompt-router persona add architect --file ~/prompts/architect.md --name "Architect"
npx magpie-prompt-router bind-cwd architect --mode replace
npx magpie-prompt-router test --model claude-sonnet-4 --agent claude-code --user "Review this diff"
```

包内同时附带了伴生 Agent Skill（`skills/magpie-prompt-router/SKILL.md`），可供 Claude Code、Codex、Alma、Pi 或 T3 Code 通过自然语言自动帮你检查状态、生成 `.prompt-router.md` 或绑定工作区规则。

## 项目级 `.prompt-router.md` 自动发现

当 `autoDiscoverProjectFile` 开启（默认 `true`），且当前请求未命中显式 `/route` 指令或 `options.rules` 时，钩子会自动检查 `<cwd>/.prompt-router.md`（按 `mtime`/`size` 热重载）：

```markdown
---
mode: replace
keepCwd: true
enabled: true
---
You are working in {{cwd}}. Answer concisely and follow repository conventions.
```

显式 `/route off`、`/route once`、`@route`、`options.rules` 以及辅助调用保护（含默认排除的 `*jev*`）始终具有更高优先级。

## 在聊天中使用

开启粘性路由，对当前及后续消息生效：

```text
/route on persona replace
```

仅作用于当前这一轮，不改变线程的粘性状态：

```text
/route once strict 审查这段代码
@route append 总结这次修改
```

关闭粘性路由：

```text
/route off
```

单独输入 `/route on` 或 `/route off` 时，插件会将其替换为简短的确认请求（`[magpie-prompt-router: state -> enabled|disabled. ...]`），上游不会收到空的用户消息。Alma 的上下文包裹和 `## Response Guidelines` 会完整保留。

## 按请求数据路由

规则支持 workspace、model、agent、protocol 和 user keywords。规则按从上到下的顺序匹配，第一条匹配的规则决定 persona 和模式。Alma 的工作区路由读取 `WORKING DIRECTORY` 区块。`claude-*` 和 `*nmem*` 这类模型 glob 支持不区分大小写的 `*` 和 `?`。

插件默认保护辅助调用。即使历史中出现过 `/route on`，它也会跳过排除模型、记忆调用、标题生成、JSON 选择器和同类后台请求。当前消息中的 `/route once` 或 `@route` 可以绕过通用辅助调用判断。排除模型 glob 仍然优先，除非配置 `allowExcludedModelsOnOnce`。

## 模式

| 模式 | 行为 |
| --- | --- |
| `strict` | 用选中的 persona 替换所有宿主系统提示词区块（自动继承 Anthropic 原块上的 `cache_control` 断点）。 |
| `replace` | 清理宿主 persona 内容，并把选中的 persona 放在剩余宿主文本之前。 |
| `fallback` | 绑定自定义 persona 时按 `replace` 执行。绑定的 persona 仍是 `builtin-example` 或内容为空时跳过。 |
| `append` | 把选中的 persona 放在已有宿主提示词之前。 |
| `suffix` | **缓存保活尾部追加**：把选中的 persona 追加到已有宿主提示词末尾，字节级保留宿主稳定前缀与 Anthropic `cache_control` 断点。 |
| `off` | 不修改宿主提示词和用户上下文。 |

启用 `keepCwd` 后，`{{cwd}}` 会替换为请求的工作目录。严格模式在模板没有占位符且请求有工作目录时，会附加当前工作目录。所有模式都会保留 wire 上的 `cwd`。

## 宿主边界

钩子只复制请求容器，并保留以下七个不可变 wire 字段，在改写前后校验其 JSON 值一致：

`tools`、`tool_choice`、`function_call`、`functions`、`toolConfig`、`model`、`stream`

钩子同时保留 `body.config.tools` 和 `body.config.toolConfig`。剥离指令时会保留多模态用户内容；Anthropic 的 `system` 数组会保留区块字段与 `cache_control` 对象引用。

账号 fallback 重试前，钩子会恢复完全匹配的原始 body。输入校验或不可变字段检查失败时，钩子会 fail-open 放行原请求，并且只报告 Magpie 支持的状态码。

## 开发与 CI/CD

在本地运行测试与发包校验：

```sh
npm test
bun test
npm run verify
```

GitHub Actions 工作流位于 `.github/workflows/`：

- `ci.yml`：在推送 `main` 与 PR 时自动运行 Node 20/22 `npm test`、`bun test` 与 `npm run verify`（清单校验、`npm pack --dry-run` 及历史残留检查）。
- `release.yml`：推送 `v*` tag（或手动触发并可选 `dry_run`）时自动验证测试与版本号一致性，配置 `NPM_TOKEN` 后发布至 npm 并创建附带 `.tgz` 产物的 GitHub Release。

## 更新日志（Changelog）

### 2026-11-20

- **缓存保活架构升级**：新增 `suffix` 尾部追加模式字节级保留宿主前缀；Anthropic `strict` 模式自动继承原 `cache_control` 断点；单轮 `/route once` 与 `@route` 仅清洗当前轮 Alma 上下文，避免回溯改写历史轮次破坏缓存；新增分段 `prefixHash` 与 `prefixBreakSegment`（`cold` / `none` / `model` / `tools` / `system` / `history`）缓存断链归因。
- **体验、可观测性与多网关同步**：优化 `defaultMode: "off"` 下单轮显式人设自动按 `replace` 激活；新增 20 条有界内存决策环缓冲与可选 `traceLog`（`mpr status --recent`）；新增 `mpr export` / `mpr import` 支持多网关一键同步配置。
- **重定位、终端 CLI、项目自动发现与 CI/CD**：正式更名为 `magpie-prompt-router`（`/route` & `@route`），新增零依赖 `mpr` CLI、`<cwd>/.prompt-router.md` 热重载自动发现、伴生 Skill、`*jev*` 默认排除、GitHub Actions CI/CD 与产品综合评估报告（`docs/evaluation.md`）。

### 2026-11-18

- **形式化不变量验证与双语文档**：通过 407 组跨协议形式化不变量验证，补齐中英文 README 顶部互链。

### 2026-11-17

- **初始版本**：落地两模块纯本地确定性路由引擎与 Magpie 四协议钩子（`chat` / `responses` / `anthropic` / `gemini`）、7 个不可变 wire 字段守卫、Alma/Pi/通用宿主清洗、账号 fallback 重试恢复及零构建设置页与实时模拟器。

本项目使用 MIT License。
