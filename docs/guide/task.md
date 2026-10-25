# Task（子代理）

[← 文档索引](README.md)

`epi:task` 默认开启（Manifest 里 `"disable": ["epi:task"]` 可关掉），可用工具：

```text
task
task_status
task_wait
task_cancel
todo
```

**子代理**是另一个 Epi 进程：有自己的上下文窗口，只把结论带回主会话。适合会把主上下文撑爆的工作——大范围搜索、长时构建、一个任务里互不相干的几条分支。

## 直接用，不必先建档

```text
task(task="读一遍 src/tui/，列出所有注册快捷键的地方，带文件:行号")
```

不需要 `agent` 参数，也不需要先写 `agents/*.md`。

## 能力按需打开（默认全关）

子代理默认**不带**技能、不连 MCP、不注入 Rules——省掉这些的加载与 token 开销。要哪项就开哪项：

| 参数 | 默认 | 说明 |
|---|---|---|
| `context` | `fresh` | `fork` 让子代理看到当前对话已完成的历史 |
| `model` | 继承 | `provider/id` 或 `provider/id:thinking`，便宜的活可以换小模型 |
| `rules` | `false` | 注入本次运行的 Rules（`AGENTS.md`） |
| `skills` | `false` | `true` 列出全部技能；`["code-review"]` 把该技能正文直接预载，子代理不用先 `read` |
| `mcp` | `false` | `true` 连全部；`["lark"]` 只连指定服务 |
| `tools` / `excludeTools` | 继承 | 例如 `tools=["read","grep","find","ls"]` 做只读子代理 |
| `hooks` | `true` | 子代理的工具调用同样受 `hooks.json` 约束 |
| `extensions` | `true` | Manifest 外部扩展 |
| `maxTurns` | 无 | 到达轮数后停下并交回已有产出（状态 `partial`） |
| `timeoutSeconds` | `600` | 超时终止 |

只读的审查子代理：

```text
task(task="审查 git diff 里的安全问题，只报带文件:行号的实据",
     tools=["read","grep","find","ls"], skills=["code-review"], rules=true)
```

## 后台与并发

同一轮里发出多个 `task` 调用，它们就会并发运行，各自直接返回结果，不需要 `task_wait`。

传 `background=true` 只返回一个 `jobId`，主会话继续干别的；之后用 `task_status` 查、`task_wait` 等、`task_cancel` 取消。只有主会话要在等待期间做别的事时才需要它。

并发上限默认是 CPU 核数（最少 2，最多 16），超出的排队。用环境变量 `EPI_TASK_MAX_CONCURRENCY` 改。

每个子代理都要付一份系统提示词和一次进程启动（约 0.6 秒）。拆分时按工作量给，每个子代理分几个文件，不要一个小文件一个子代理。

## 边界

- 子代理**不能再派子代理**（它那边不加载 `epi:task`）。
- 子代理的资源是主会话的子集：主会话没信任的项目配置，子代理也拿不到。
- 子会话文件在 `~/.epi/runtime/task/sessions/`，不会出现在 `epi -c` 或 `/resume` 里。

## 预设（可选）

常用组合可以存成 `~/.epi/agents/<name>.md`，可信项目用 `<repo>/.epi/agents/<name>.md` 按名覆盖：

```markdown
---
name: reviewer
description: Reviews one bounded code change
model: openai/gpt-4o-mini
tools: read,grep
skills: code-review
rules: true
timeoutSeconds: 600
---

Review only the requested change. Return findings with file and line evidence.
```

用 `task(agent="reviewer", task="...")` 调用；调用时显式传的参数覆盖预设。

字段约束：

- `name`：`^[a-z][a-z0-9-]{0,63}$`，目录内唯一。
- `description`：必填非空字符串。
- `model`：可选 `provider/model`；缺省时使用主会话当前模型。
- `tools` / `excludeTools` / `skills` / `mcp` / `extensions`：逗号分隔字符串或数组（后三者也接受 `true`/`false`）。
- `rules` / `hooks`：布尔。
- `context`：`fresh` 或 `fork`。
- `maxTurns` / `timeoutSeconds`：正整数，`timeoutSeconds` 默认 `600`。
- frontmatter 后的正文是子代理的 system prompt。
