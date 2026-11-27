# Task（子代理）

[← 文档索引](README.md)

`epi:task` 默认开启（Manifest 里 `"disable": ["epi:task"]` 可关掉），由内置 `dispatch` 引擎提供统一异步调度与多代理协同能力，可用工具与命令：

```text
bash (mode: "auto" | "background" | "daemon" / stdin)
task / task_status / task_wait / task_cancel / task_input
board_post / board_read（同伴另有 board_wait）
timer / outbox / todo
/tasks [id] · /board · /bg (Alt+B)
```

**子代理**是另一个 Epi 进程：有自己的上下文窗口，只把结论带回主会话。适合会把主上下文撑爆的工作——大范围搜索、长时构建、一个任务里互不相干的几条分支。

## 直接用，不必先建档

```text
task(task="读一遍 src/tui/，列出所有注册快捷键的地方，带文件:行号")
```

不需要 `agent` 参数，也不需要先写 `agents/*.md`。

## 能力按需打开（默认全关）

子代理默认**不带**技能、不连 MCP、不注入 Rules——省掉这些的加载与 token 开销。`task` 调用可直接传通用调度与裁剪参数，Epi 宿主装配域（`rules` / `skills` / `mcp` / `hooks` / `extensions`）则在 `agents/*.md` 预设里按需开启：

| 参数 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `context` | 调用 / 预设 | `fresh` | `fork` 让子代理看到当前对话已完成的历史 |
| `workspace` | 调用 / 预设 | `inherit` | `branch`（git worktree）或 `share`（CoW 克隆）做文件隔离 |
| `model` | 调用 / 预设 | 继承 | `provider/id`、`provider/id:thinking` 或 `:thinking` |
| `tools` / `excludeTools` | 调用 / 预设 | 继承 | 例如 `tools=["read","grep","find","ls"]` 做只读子代理（自动保留进度/看板工具） |
| `systemPrompt` / `verifyCommand` | 调用 / 预设 | 无 | 追加系统指令；出口门禁命令须以 `0` 退出才允许收尾 |
| `maxTurns` / `timeoutSeconds` | 调用 / 预设 | 无 / `600` | 到达轮数以 `partial` 交回已有产出；超时终止进程组 |
| `rules` | `agents/*.md` | `false` | 注入本次运行的 Rules（`AGENTS.md`） |
| `skills` | `agents/*.md` | `false` | `true` 列出全部技能；`["code-review"]` 把该技能正文直接预载 |
| `mcp` | `agents/*.md` | `false` | `true` 连全部；`["lark"]` 只连指定服务 |
| `web` | `agents/*.md` | `false` | 开启 `epi:web`（`web_search` / `web_fetch`），默认关闭省上下文 |
| `hooks` / `extensions` | `agents/*.md` | `true` | 子代理的工具调用同样受 `hooks.json` 约束；裁剪 Manifest 外部扩展 |

只读的审查子代理：

```text
task(task="审查 git diff 里的安全问题，只报带文件:行号的实据",
     tools=["read","grep","find","ls"])
```

## 后台与并发

同一轮里发出多个 `task` 调用（或用 `tasks: [...]` 批量下发），它们就会并发运行，各自直接返回结果，不需要 `task_wait`。

传 `background=true` 只返回一个 `jobId`，主会话继续干别的；之后用 `task_status` 查、`task_wait` 等、`task_cancel` 取消。只有主会话要在等待期间做别的事时才需要它。

并发上限默认是 CPU 核数（最少 2，最多 16），超出的自动排队。

每个子代理都要付一份系统提示词和一次进程启动（约 0.6 秒）。拆分时按工作量给，每个子代理分几个文件，不要一个小文件一个子代理。

## 查看、纠偏与续跑

- **查看**：`task_status({ id })` 显示运行中子代理、后台命令（`bg_*`）或闹钟（`tm_*`）的状态与输出；`task_status({})` 列出全部后台项。交互界面里可点右下角状态计数或输入 `/tasks`、`/board` 查看双页签浮层，前台等待中按 `Alt+B` 或输入 `/bg` 可放手转后台。
- **具名同伴与看板**：`task({ role: "peer", name: "parser", workspace: "branch", task: "..." })` 启动具名同伴并加入共享看板，同伴间用 `board_post("@peer ...")` + `board_wait` 直接交接，支持 `forkFrom: "<name>"` 复制同伴上下文（不传 `role: "peer"` 时，即使带 `name` 也只作普通前台工人运行）。
- **纠偏**：对运行中的子代理调用 `task({ jobId, task: "新指令", strategy })`（`jobId` 可传 `job_<id>` 或具名 `name`），已有上下文不丢；纠偏文本同样先过 `task_start` hook。
- **续跑**：对已结束（completed / partial / failed / cancelled）的子代理调用 `task({ jobId, task: "追问" })`，它在原来的会话上继续。
- **自动唤醒**：后台项结束且未被主动拉取时，主会话收到一条 `dispatch:notify` 消息；`epi -p` 下 `agent_settled` 排空屏障会自动等待有限后台项汇报后再收尾退出。

## 上下文与压缩

子代理的自动压缩总是开着（即使全局设置关掉了），上下文快满时自己压缩后继续。压缩也腾不出空间时，子代理以 `partial` 结束：保留已写出的回答，结果末尾写明原因，会话文件保留，可以续跑。用量（包括被压缩掉的轮次和压缩本身）计入主会话的 `epi:task-usage`。

## 生命周期

主会话的 `/compact`、Esc、`/new`、`/resume`、`/fork`、`/reload` 都不会杀掉正在跑的子代理（前台调用被打断时转为后台继续）。只有退出 Epi 和 `task_cancel` 会结束它；父进程被强杀时，子进程读到管道关闭后自行退出。

## 边界

- 子代理**不能再派子代理**（它那边不加载 `epi:task`）。
- 子代理的资源是主会话的子集：主会话没信任的项目配置，子代理也拿不到。
- 子会话文件在 `~/.epi/runtime/dispatch/sessions/`，不会出现在 `epi -c` 或 `/resume` 里。

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
