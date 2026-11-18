# magpie-purge

`magpie-purge` 是一个自包含的 Magpie 网关插件，用于按条件分流系统提示词。它支持 Alma、Pi、Claude Code、Codex 和 OpenCode，并通过 Magpie 的 `chat`、`responses`、`anthropic` 和 `gemini` 请求钩子工作。

## 安装

从 npm / Magpie 发现页安装：

```sh
magpie plugin add magpie-purge
```

或从 GitHub / 本地目录安装：

```sh
magpie plugin add github:HamsteRider-m/magpie-purge
magpie plugin add /path/to/magpie-purge
```

打开 Magpie 设置页，启用插件，配置 persona，并添加有序路由规则。

## 在聊天中使用

让模式对后续消息保持生效：

```text
/purge on persona replace
```

只作用于当前消息：

```text
/purge once strict 审查这段代码
@purge append 总结这次修改
```

关闭粘性路由：

```text
/purge off
```

单独输入 `on` 或 `off` 时，插件会替换为简短的确认请求。上游不会收到空的用户消息。Alma 的上下文和响应指南会保留。

## 按请求数据路由

规则支持 workspace、model、agent、protocol 和 user keywords。规则按从上到下的顺序匹配，第一条匹配的规则决定 persona 和模式。Alma 的工作区路由读取 `WORKING DIRECTORY` 区块。`claude-*` 和 `*nmem*` 这类模型 glob 支持不区分大小写的 `*` 和 `?`。

插件默认保护辅助调用。即使历史中出现过 `/purge on`，它也会跳过排除模型、记忆调用、标题生成、JSON 选择器和同类后台请求。当前消息中的 `/purge once` 或 `@purge` 可以绕过通用辅助调用判断。排除模型 glob 仍然优先，除非配置 `allowExcludedModelsOnOnce`。

## 模式

| 模式 | 行为 |
| --- | --- |
| `strict` | 用选中的 persona 替换所有宿主系统提示词区块。 |
| `replace` | 清理宿主 persona 内容，并把选中的 persona 放在剩余宿主文本之前。 |
| `fallback` | 绑定自定义 persona 时按 `replace` 执行。绑定的 persona 仍是 `builtin-example` 或内容为空时跳过。 |
| `append` | 把选中的 persona 放在已有宿主提示词之前。 |
| `off` | 不修改宿主提示词和用户上下文。 |

启用 `keepCwd` 后，`{{cwd}}` 会替换为请求的工作目录。严格模式在模板没有占位符且请求有工作目录时，会附加当前工作目录。所有模式都会保留 wire 上的 `cwd`。

## 宿主边界

钩子只复制请求容器，并保留以下七个不可变 wire 字段。钩子用 JSON 值比较改写前后的字段：

`tools`、`tool_choice`、`function_call`、`functions`、`toolConfig`、`model`、`stream`

钩子也会保留 `body.config.tools` 和 `body.config.toolConfig`。删除指令时会保留多模态用户内容。Anthropic 的 system 区块会保留字段和 `cache_control` 对象身份。

账号 fallback 重试前，钩子会恢复完全匹配的原始 body。输入校验或不可变字段检查失败时，钩子会放行原请求，并且只报告 Magpie 支持的状态码。

## 外部预设库同步（`some-magic`）

`magpie-purge` 的 Git 仓库与 npm 包本身不打包第三方 `some-magic` 提示词正文。如需使用 [ZiChuanLan/some-magic](https://github.com/ZiChuanLan/some-magic) 的 20 份 Markdown 人设预设，可通过自带快捷命令一键拉取到本机：

```sh
npx magpie-purge-presets
# 或在本地仓库目录执行：
npm run sync-presets
```

默认会同步到 `~/.config/magpie/magpie-purge/presets/some-magic`（升级插件也不会丢失）；也可传 `--local` 同步到插件目录 `./presets/some-magic`，或用 `--dir <path>` 指定目录。

- 同步后即可直接在聊天指令（当 `defaultMode` 为 `off` 时记得带上模式名，例如 `/purge once qwen-37 strict ...` 或 `/purge on eni-opus-5 replace`）、`defaultPersonaId` 或路由规则中引用预设 ID。
- 可在 Magpie 设置页的 **Personas** 与 **Defaults** 中直接选择或导入预设目录（`page/presets.js` 仅含预设元数据）。
- 在 `options.personas` 中配置同 `id` 的条目会覆盖已同步预设；相对路径 `presets/some-magic/...` 会同时在插件根目录与 `~/.config/magpie/magpie-purge/presets/some-magic` 中解析。

## 开发

使用 Node 运行测试：

```sh
npm test
```

使用 Bun 运行测试：

```sh
bun test
```

测试覆盖真实 Alma envelope、辅助调用免疫、四种 wire 协议、重试重入、persona 文件热加载、页面 simulator parity、不可变字段和宿主时限。

## 致谢

路由设计参考了 YuJunZhiXue/dsh-purge、[ZiChuanLan/pi-purge](https://github.com/ZiChuanLan/pi-purge)、[ZiChuanLan/agent-purge](https://github.com/ZiChuanLan/agent-purge) 和 [ZiChuanLan/some-magic](https://github.com/ZiChuanLan/some-magic)。

本项目使用 MIT License。
