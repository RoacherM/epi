# Epi 内置 Subagents 设计（`epi:task` 2.0）

状态：**包 1、包 2 已实现，包 3 待实现**（2026-10-26 更新）。第 10–11 节是实现状态、范围修订与包 3 详细设计，**以第 10–11 节为准**；第 1–9 节保留原始设计，其中标为"不做"或"未实现"的承诺不对用户和模型生效。

本文定义如何将 Epi 现有的内置扩展 `epi:task`（当前约 840 行）升级为完整的、简约风格的内置 Subagents 系统，从而直接替代外部 98,113 行的 `npm:pi-subagents`。

文中引用的源码位置均于 2026-10-23 核对自当前仓库与 `@earendil-works/pi-coding-agent` 1.1.0 的 `dist/`。

---

## 0. 名词说明

- **主会话（Parent Session）**：用户当前交互（或 `epi -p` 启动）的顶层 Pi `AgentSession`。
- **子代理（Subagent / Child Session）**：由主会话通过 `task` 工具派生的独立 `AgentSession`，运行在独立的 Node.js 子进程（`dist/worker.js`）中，拥有隔离的上下文窗口，只把阶段汇报或最终结论带回主会话。
- **任务胶囊（TaskCapsule）**：父进程写给 Worker 子进程的启动配置文件（权限 `0600`，位于 `~/.epi/runtime/task/`），描述本次子代理的任务指令与 Agent Loop 装配参数。
- **装配（ResolvedAssembly）**：Epi 在启动时由 `src/assembly.ts` 解析出的资源全集（Rules、Skills、内置扩展、外部插件、可信项目根目录）。
- **中途转向（Steer）**：子代理正在运行工具或生成回复时，主会话向其注入一条新指令；子代理在当前工具执行完毕后、下一轮请求模型前立即按新指令调整方向，不丢失已有上下文。
- **等待屏障（Wait Barrier）**：主会话对一个或多个后台子代理发起的同步等待，支持 `all`（全部完成才返回，同 `Promise.all`）与 `any`（任意一个完成即返回，同 `Promise.race`）。

---

## 1. 现状问题与目标边界

### 1.1 为什么现有 `epi:task` 不够用，而 `npm:pi-subagents` 又太重

| 维度 | 现有 `epi:task`（`src/task-*.ts`，840 行） | 外部 `npm:pi-subagents`（98,113 行 JS） | `epi:task` 2.0 目标设计（~1,350 行 TS） |
|---|---|---|---|
| **角色与调用门槛** | 强制要求传 `agent: string` 匹配 `agents/*.md`；目录为空时显示 `Available agents: none.`，开箱不可用 | 内置 13 个固定人格（`scout`、`oracle`、`reviewer` 等），提示词冗余且经常与主任务冲突 | **无内置具名人格**：`agent` 改为可选预设，默认直接传 `task` + 原子参数即可运行 |
| **Agent Loop 原子能力** | `src/worker.ts:116-127` 硬编码 `noExtensions: true, noSkills: true`，子代理没有 Hooks、MCP、Web、Skills、外部插件 | 自建一套加载器，读写 `~/.pi/agent/`，破坏 Epi 配置隔离（`docs/architecture.md` §3.7） | **复用主会话统一装配管线**（`resolveAssembly` → `scopeAssemblyForTask` → `buildInlineExtensions`），9 项原子能力按需开关 |
| **执行与阻塞模型** | 默认同步阻塞（`background: false`）；后台完成无通知，主会话只能轮询 | 支持后台与自动唤醒，但绑了 4.2 万行 `node:vm` JS 工作流引擎与 5,000 行 `FleetView` | **默认后台非阻塞（`background: true`）** + 双向进度（Push 自动唤醒 + Pull 实时快照） |
| **生命周期与复用** | 一次性短命进程（`SessionManager.inMemory` + `stdin: "ignore"`），跑偏只能杀、跑完不能追问 | 支持 `fork` 与 `resume`，但依赖修改 Pi 内部私有字段 | **有状态 Actor**：落盘子会话 `.jsonl` + 开放 `stdin`，运行中可 `steer` 纠偏、停止后可按 `jobId` 原地续跑 |
| **并发写隔离** | 共享父会话 `cwd`，多个子代理并发写文件互相踩踏 | 2,300 行复杂的 worktree 锁与清理计划 | 轻量 `isolation: "worktree"`（无改动自动清理，有改动返回 `worktreePath` 与 `diffStat`） |

### 1.2 做什么、不做什么

| 做 | 不做（砍掉 `pi-subagents` 95% 的冗余） |
|---|---|
| 无名子代理直接调用（`task` 必填，`agent` 可选） | 内置 `scout` / `worker` / `reviewer` / `oracle` 等具名人格文件 |
| 复用 `resolveAssembly` + `buildInlineExtensions`，打通 Hooks、外部插件、MCP、Web、Skills、Rules、Tools | 读写 `~/.pi/agent/` 或任何非 Epi 配置路径 |
| 默认后台非阻塞执行 + 子代理主动上报进度（Push）+ 主代理随时查实时轨迹（Pull） | `node:vm` 脚本工作流（`workflow: true` 代码块）、Missions 持久化库、Cron 定时任务 |
| 统一 `jobId` 消息投递：运行中发消息走 `session.steer()`，停止后发消息走 `SessionManager.open()` 续跑 | 子代理阻塞等父代理回话的 `contact_supervisor` / `subagent_supervisor` 双向锁 |
| `context: "fresh" \| "fork"`、`isolation: "none" \| "worktree"`、`maxTurns` 优雅 `partial` 截断 | Watchdog 对抗式审查器、外部 CLI 适配器（`claude-code`、`codex-exec`、`herdr`） |
| 保持 `task`、`task_status`、`task_wait`、`task_cancel`、`todo` 五个工具名不变（与 `/trace` 语义对齐） | 常驻底部的 `FleetView` 大面板（改用 Grok 单列 `CallLine` + 状态栏单行提示） |

---

## 2. 总体架构

### 2.1 统一装配管线（Worker 与主会话同源）

遵循 `docs/architecture.md` §2（*「所有运行模式走同一条启动路径，不为某个模式单开一条」*），`src/worker.ts` 不再手写裸 `createAgentSessionServices`，而是复用 `src/assembly.ts` 与 `src/extensions/index.ts`：

```text
                 ┌──────────────────┐    ┌─────────────┐
                 │ epi.json & .epi/ │    │ TaskCapsule │
                 └─────────┬────────┘    └──────┬──────┘
                           └─────────┐          └─────────────────────────────────────┐
                                     ▼                                                │
                            ┌─────────────────┐                                       │
                            │ resolveAssembly │                                       │
                            └────────┬────────┘                                       │
                                     │     ┌──────────────────────────────────────────┘
                                     ▼     ▼
                         ┌──────────────────────┐
                         │ scopeAssemblyForTask │
                         └───────────┬──────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │ buildInlineExtensions │
                         └───────────┬───────────┘
       ┌─────────────────┬───────────┴────────┬─────────────────────────┐
       ▼                 ▼                    ▼                         ▼
 ┌───────────┐   ┌───────────────┐  ┌──────────────────┐   ┌────────────────────────┐
 │ epi:hooks │   │ epi:mcp + web │  │ external plugins │   │ rules + skills + tools │
 └───────────┘   └───────────────┘  └──────────────────┘   └────────────────────────┘
```

### 2.2 非阻塞调度与双向进度时序（Push + Pull）

```text
┌────────────┐                        ┌─────────────┐                          ┌────────┐
│ Main Agent │                        │ TaskRuntime │                          │ Worker │
└──────┬─────┘                        └──────┬──────┘                          └────┬───┘
       │                                     │                                      │
       │    task({ task }) (non-blocking)    │                                      │
       ├────────────────────────────────────▶│                                      │
       │                                     │                                      │
       │                                     │           spawn worker.js            │
       │                                     ├─────────────────────────────────────▶│
       │                                     │                                      │
       │    { jobId, status: "running" }     │                                      │
       │◄╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤                                      │
       │                                     │                                      │
       │                                     │JSONL progress (tool / turn / report) │
       │                                     │◄─────────────────────────────────────┤
       │                                     │                                      │
       │  task_status({ jobId }) (0ms pull)  │                                      │
       ├────────────────────────────────────▶│                                      │
       │                                     │                                      │
       │ snapshot (step, tool, recentEvents) │                                      │
       │◄╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤                                      │
       │                                     │                                      │
       │                                     │       JSONL result / milestone       │
       │                                     │◄─────────────────────────────────────┤
       │                                     │                                      │
       │sendMessage(triggerTurn) (push wake) │                                      │
       │◄────────────────────────────────────┤                                      │
       │                                     │                                      │
┌──────┴─────┐                        ┌──────┴──────┐                          ┌────┴───┐
│ Main Agent │                        │ TaskRuntime │                          │ Worker │
└────────────┘                        └─────────────┘                          └────────┘
```

### 2.3 子代理状态机（支持运行中 `steer` 与终态 `resume`）

```text
                            done      ┌───────────┐
          task  ┌─────────┐┌─────────▶│ Completed │
╭───────╮┌─────▶│ Running ├┤          └─────┬─────┘
│ start ├┘      └─────┬───┘│                │
╰───────╯            ▲│  ▲ │maxTurns  ┌─────────┐
                     │╰──╯ └─────────▶│ Partial │
                     │                └────┬────┘
                     │                     ││
                     ├─── task(jobId) ─────┘│
                     └─── task(jobId) ──────┘
```
- **运行中转向（`Running` 自环）**：调用 `task({ jobId, task: "新指令" })` 时，父进程经 `worker.stdin` 发送 `steer` 命令，Worker 在当前工具结束后立即转向（实现上是逐字投递的 `session.agent.steer`，不是会展开/抛错的 `session.steer`，见 development.md §12.1）。
- **终态续跑（`Completed` / `Partial` / `Failed` → `Running`）**：对已停止的 `jobId` 调用 `task({ jobId, task: "追问或继续" })` 时，直接通过 `SessionManager.open(job.sessionPath)` 打开原会话文件继续执行下一轮。

---

## 3. Agent Loop 的 9 项正交原子能力

每次调用 `task`（或定义可选的 `agents/*.md` 预设模板）时，均可独立控制以下 9 个正交维度。调用时传入的显式参数优先级高于 `agents/*.md` 模板：

| # | 维度 | 参数名与类型 | 默认值 | 装配与运行语义 |
|---|---|---|---|---|
| 1 | **上下文模式** | `context?: "fresh" \| "fork"` | `"fresh"` | `"fresh"`：新建空白子会话；`"fork"`：复制父会话当前分支已完成的上下文历史（剔除未闭合的当前工具调用，见 §9.1） |
| 2 | **工作区隔离** | `isolation?: "none" \| "worktree"` | `"none"` | `"none"`：直接使用 `cwd`；`"worktree"`：在 `~/.epi/runtime/worktrees/<jobId>` 创建独立 Git 工作树，无改动自动清理，有改动保留并返回 `worktreePath` 与 `diffStat` |
| 3 | **模型与思考** | `model?: string` | 继承父会话 `model:thinking` | 支持 `"provider/id"`、`"provider/id:high"` 或仅传思考档位 `":low"` / `":high"`（传 `":low"` 时保留父会话模型，仅切换思考档位） |
| 4 | **系统提示词与规则** | `systemPrompt?: string`<br>`rules?: boolean` | `""`<br>`false` | `systemPrompt` 作为子代理附加系统指令注入；`rules: true` 时注入父会话已加载的 `# Epi Rules`（`AGENTS.md`） |
| 5 | **技能（Skills）** | `skills?: boolean \| string[]` | `false` | `false`：不注入 `<available_skills>`（省约 2k tokens）；<br>`["skill-a"]`：**Preload 模式**，直接将对应 `SKILL.md` 全文注入子代理初始系统提示词，省去第 1 轮调 `read` 的开销；<br>`true`：**Discover 模式**，暴露父会话全部 `skillPaths` |
| 6 | **MCP 服务** | `mcp?: boolean \| string[]` | `false` | `false`：不启动 MCP 连接（零冷启动开销）；`true`：加载全部已配置服务（`epi:mcp` + `codemode` + `tool-search`）；`["lark"]`：仅按名称过滤加载指定 MCP 服务 |
| 7 | **工具集与过滤** | `tools?: string[]`<br>`excludeTools?: string[]` | `undefined`<br>`undefined` | 直接透传给 Pi `createAgentSession`（`dist/core/sdk.js:147-162`）：<br>• `tools` 支持精确白名单（如 `["read", "grep", "find", "ls"]`）或增减修饰符（如 `["-edit", "-write", "-bash"]`）；<br>• `excludeTools` 支持黑名单及 MCP 通配（如 `["mcp__github__*"]`）；<br>• `epi:web` 默认随 `scopeAssemblyForTask` 挂载，可用 `excludeTools: ["web_search", "web_fetch"]` 屏蔽 |
| 8 | **Hooks 与外部插件** | `hooks?: boolean`<br>`extensions?: boolean \| string[]` | `true`<br>`true` | 默认继承 `epi:hooks`（子代理内的 `tool_call` / `tool_result` 受同一份 `hooks.json` 约束）与 `epi.json` 中的 `externalExtensions`；可传 `false` 或插件名数组裁剪 |
| 9 | **执行预算** | `maxTurns?: number`<br>`timeoutSeconds?: number` | `undefined`<br>`600` | 达到 `maxTurns` 时优雅中止当前轮并返回已有产出（`status: "partial"`，带 `turns`）；该轮没有工具结果说明模型已收尾，按 `completed` 结束，不算 partial；达到 `timeoutSeconds` 时终止进程组（若已有已完成轮次则保留部分产出与会话文件供续跑） |

---

## 4. 工具面与参数契约（`src/extensions/task.ts`）

保持 `task`、`task_status`、`task_wait`、`task_cancel`、`todo` 五个工具名不变（符合 `docs/development.md` §12.1 与 `docs/trace-design.md:233`「提交、等待、取消各自成步」的约定），对前四个工具做原位能力升级：

### 4.1 `task`：启动单任务、并发任务组、或向已有 `jobId` 发送指令（转向 / 续跑）

```ts
const TaskSpecSchema = Type.Object({
  task: Type.String({ description: "Task prompt for a new subagent, or message to steer/resume jobId" }),
  jobId: Type.Optional(Type.String({ description: "Existing jobId: steers if running, resumes if stopped" })),
  agent: Type.Optional(Type.String({ description: "Optional preset name from agents/*.md" })),
  cwd: Type.Optional(Type.String({ description: "Working directory (default: session cwd)" })),
  context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])),
  isolation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("worktree")])),
  model: Type.Optional(Type.String({ description: "Model override (provider/id, provider/id:thinking, or :thinking)" })),
  systemPrompt: Type.Optional(Type.String()),
  rules: Type.Optional(Type.Boolean()),
  skills: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
  mcp: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
  tools: Type.Optional(Type.Array(Type.String())),
  excludeTools: Type.Optional(Type.Array(Type.String())),
  hooks: Type.Optional(Type.Boolean()),
  extensions: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
});

const TaskToolParameters = Type.Object({
  ...TaskSpecSchema.properties,
  task: Type.Optional(Type.String({ description: "Task prompt for a single subagent" })),
  tasks: Type.Optional(Type.Array(TaskSpecSchema, { minItems: 1, maxItems: 8, description: "Launch multiple subagents in parallel" })),
  background: Type.Optional(Type.Boolean({
    default: true,
    description: "Run in background by default and wake session when done; set false to block until finished",
  })),
});
```

- **单跑或并行**：传 `task` 启动 1 个，或传 `tasks: [...]` 一次并行启动多个（最多 8 个，受 `TaskRuntime` 的 `maxConcurrency: 4` 队列调度）。
- **默认 `background: true`**：调用立即返回 `{ id, status: "queued" | "running", ... }`（或 `{ jobs: [...] }`），绝不阻塞主会话。当主模型下一步必须立刻用到该结果时，可显式传 `background: false`。
- **向已有 `jobId` 发消息（`jobId` + `task`）**：
  - 若 `jobId` 处于 `running`：通过 `worker.stdin` 写入 `{"type":"steer","message":task}`，返回当前最新进度快照；
  - 若 `jobId` 处于 `completed` / `partial` / `failed` / `cancelled`：基于其保留的 `~/.epi/runtime/task/sessions/<jobId>.jsonl` 重新拉起 Worker 跑新一轮。

### 4.2 `task_status`：0ms 主动拉取实时进度（支持单查与全量列表）

```ts
parameters: Type.Object({
  jobId: Type.Optional(Type.String({ description: "Job ID to inspect; omit to list all jobs in this session" })),
})
```

### 4.3 `task_wait`：支持 `all` / `any` 的多任务等待屏障

```ts
parameters: Type.Object({
  jobId: Type.Optional(Type.String({ description: "Wait for one specific job" })),
  jobIds: Type.Optional(Type.Array(Type.String(), { description: "Wait for multiple jobs; omit both jobId and jobIds to wait on all active jobs" })),
  mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("any")], {
    default: "all",
    description: "'all' waits until every target job settles; 'any' returns as soon as the first target job settles",
  })),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0.001 })),
})
```

### 4.4 `task_cancel`：支持单任务、多任务与全量取消

```ts
parameters: Type.Object({
  jobId: Type.Optional(Type.String()),
  jobIds: Type.Optional(Type.Array(Type.String())),
  all: Type.Optional(Type.Boolean({ description: "Cancel all queued and running jobs in this session" })),
})
```

---

## 5. Worker 双工协议与进度模型（`src/task-runtime.ts` + `src/worker.ts`）

### 5.1 进度与状态快照 `TaskJobSnapshot`

```ts
export type TaskJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export interface TaskJobSnapshot {
  id: string;
  agent?: string;
  agentSource?: "global" | "project";
  status: TaskJobStatus;
  cwd: string;
  sessionPath: string;
  worktreePath?: string;
  diffStat?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  // --- 实时进度字段 ---
  turns: number;
  steps: number;
  currentActivity?: string;         // 例："bash: npm test" 或 "read: src/host.ts"
  lastSummary?: string;             // 最近一轮 assistant 文本摘要或 report_progress 内容
  recentEvents: string[];           // 最近 10 条动作环形缓冲，如 ["✓ read src/host.ts (9ms)", "⠋ bash npm test"]
  usage?: { inputTokens: number; outputTokens: number };
  // --- 终态输出 ---
  result?: string;
  error?: string;
  stdoutArtifact?: string;
  stderrArtifact?: string;
}
```

### 5.2 父子进程 stdio 协议

- **`worker.stdin`（父 → 子，JSONL）**：
  - `{"type": "steer", "message": "..."}`：调用 `activeSession.agent.steer(message)`（不展开、不抛错；session 就绪前的 steer 先缓存）；
  - `{"type": "abort"}`：调用 `activeSession.abort()`。
- **`worker.stdout`（子 → 父，受 `takeOverStdout()` 保护的纯 JSONL，见 §9.3）**：
  - `{"type": "started", "pid": 12345}`
  - `{"type": "progress", "turns": 1, "steps": 3, "phase": "tool_start" | "tool_end" | "turn_end" | "report", "tool": "read", "target": "src/cli.ts", "summary": "...", "notifyParent": false, "usage": {...}}`
  - `{"type": "result", "ok": true, "partial": false, "output": "...", "turns": 2, "steps": 5, "usage": {...}}`

### 5.3 子代理内置 `report_progress` 工具与自动唤醒合并

1. **子代理主动上报工具 `report_progress`**：
   Worker 会话内置注册一个极简工具 `report_progress({ summary: string, notifyParent?: boolean })`：
   - `notifyParent: false`（默认）：仅更新父进程内存中的 `job.lastSummary` 与 TUI 状态栏；
   - `notifyParent: true`：子代理遇到里程碑或需要向主会话报告阶段性发现时，立即向父进程触发一次推送通知。
2. **微批合并唤醒（Coalesced Wake）**：
   当后台子任务进入终态（`completed` / `partial` / `failed`）或发出 `notifyParent: true` 时：
   - 若该任务当前正被某个同步 `task_wait` 阻塞等待，则结果直接由 `task_wait` 返回，**不重复发 `sendMessage`**（防双投递）；
   - 若无 `task_wait` 认领：
     - 主会话正忙（`!ctx.isIdle()`）或用户刚按了 `Esc` 中止本轮：以 `pi.sendMessage(..., { triggerTurn: false, deliverAs: "followUp" })` 挂入队尾；
     - 主会话空闲（`ctx.isIdle()`）：开启 **300ms 微批窗口**，将窗口内同时落定的多个子代理结果合并为一条 `customType: "epi:task-notify"` 消息，调用一次 `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` 唤醒主会话。

---

## 6. TUI 交互与渲染（Grok 单列风格）

不引入 `pi-subagents` 的多行常驻 `FleetView`，全部融进 Epi 现有的单列工具块（`src/tui/tools/common.ts`）与底部状态栏：

1. **调用行（`renderCall`，使用 `CallLine`）**：
   - 前台运行中：`⠋ task "排查 MCP 连接超时" · step 3 · read src/extensions/mcp.ts   ██··`
   - 后台已派发：`◆ task "排查 MCP 连接超时" · running in background (job-1)          ▏···`
   - 前台已完成：`◆ task "排查 MCP 连接超时" · 5 steps · 34 lines                     ███·`
   - 并行任务组：`◆ task 3 parallel · 2/3 done                                        ██··`
2. **结果行（`renderResult`，使用 `LinesComponent` + `Inspectable`）**：
   - 遵循「成功不占行」：前台单任务完成且未展开（`expanded: false`）时，摘要写进 `CallLine` 尾部，结果占 0 行；按 `Ctrl+O` 展开后显示最多 10 行正文，超出部分生成 `… +N lines` 可点击行，单击直接打开 Epi 的 Buffer Inspector 查看全文。
   - `task_status`（无参列表或单查）折叠显示 `2 running, 1 completed`，展开每行显示一个任务的 `id · status · steps · currentActivity · elapsed`。
3. **底部状态栏实时微提示（`ctx.ui.setStatus("epi-task", ...)`）**：
   - 当有后台任务处于 `running` / `queued` 时，在状态栏显示单行摘要：`⠋ 2 tasks · job-1 step 4 (bash) · job-2 step 1 (read)`；全部落定后自动清除（`setStatus("epi-task", undefined)`）。

---

## 7. `agents/*.md` 预设文件扩展（向后兼容）

`~/.epi/agents/<name>.md` 与可信项目 `<repo>/.epi/agents/<name>.md` 继续作为可选预设（同时供 `epi:hooks` 的 `type: "agent"` handler 使用），Frontmatter 在原有 5 个字段基础上支持全部原子属性：

```yaml
---
name: security-reviewer
description: Audits code changes for security vulnerabilities
model: claude-sonnet:high
context: fresh
isolation: none
tools: read,grep,find,ls
excludeTools: mcp__*
skills: code-review
mcp: false
rules: false
maxTurns: 15
timeoutSeconds: 600
---
```

---

## 8. 改动文件清单

| 文件 | 改动内容 | 预估行数变化 |
|---|---|---|
| `src/assembly.ts` | 新增 `scopeAssemblyForTask(base, capsule)` 与按名称匹配/读取 Skill 的辅助函数 | +55 行 |
| `src/extensions/index.ts` & `src/extensions/mcp.ts` | `createTaskInlineExtension` 传入 `resolveAssembly`；`createEpiMcpExtension` 支持可选 `serverFilter`（按名称过滤子代理启用哪些 MCP 服务） | +30 行 |
| `src/task-agents.ts` | 解析可选的新增 Frontmatter 字段（`thinking`、`context`、`isolation`、`excludeTools`、`skills`、`mcp`、`rules`、`hooks`、`extensions`、`maxTurns`） | +55 行 |
| `src/task-runtime.ts` | 支持无 `agent` 启动、子会话 `.jsonl` 持久化与 `fork` 分支构建、双向 `stdin` `steer`、`worktree` 创建与自动清理、`waitMany(mode: "all" \| "any")`、`list()`、`progress` 环形缓冲 | +220 行 |
| `src/worker.ts` | 顶部调 `takeOverStdout()` 隔离扩展杂音；改走 `resolveAssembly` + `scopeAssemblyForTask` + `buildInlineExtensions`；监听 `stdin` 处理 `steer`/`abort`；注册 `report_progress` 工具与 `maxTurns` 优雅截断 | +110 / -35 行 |
| `src/extensions/task.ts` | 升级 `task` / `task_status` / `task_wait` / `task_cancel` 参数与执行逻辑；实现 300ms 微批合并唤醒与非交互模式自动 drain；重写 `CallLine` + `LinesComponent` 渲染器与状态栏提示 | +190 / -70 行 |
| `docs/guide/task.md` | 同步更新用户指南 | +60 行 |

---

## 9. 设计与功能审查记录（已提前规避的 7 个设计缺陷）

在落盘本设计前，对照 `@earendil-works/pi-coding-agent` 1.1.0 源码与 Epi 现有模块做了逐项走查，提前发现并规避了以下 7 个隐蔽缺陷：

### 缺陷 1（P0）：`context: "fork"` 在工具执行中途分叉会导致末尾悬空 `toolCall`，引发模型 API 400 报错
- **源码根因**：
  1. `pi-coding-agent/dist/core/agent-session.js:767` 在 `message_end` 时先把含 `toolCall`（即本次 `task` 调用本身）的 `assistant` 消息写入 `sessionManager`，随后才执行 `task.execute()`。此时 `ctx.sessionManager.getBranch()` 的最后一条记录是**尚未产生 `toolResult` 的 `assistant` `toolCall`**。若原样复制给子代理并追加子代理的 `user` prompt，Anthropic / OpenAI 会因 `tool_use` 缺少紧邻的 `tool_result` 直接报 HTTP 400。
  2. 此外，`SessionManager.prototype.createBranchedSession`（`session-manager.js:1257-1259`）会**原地修改调用方实例自身的 `this.sessionId` 和 `this.sessionFile`**，直接对父会话 `ctx.sessionManager` 调用会篡改父会话状态。
  3. 若将分叉出的子会话文件放进父会话默认的 `~/.epi/pi/sessions/<encoded-cwd>/`，Pi 的 `continueRecent`（`epi -c`，`session-manager.js:1354`）按最新 `mtime` 选文件，会导致后台子代理劫持用户下一次 `epi -c`。
- **规避方案**：
  - 所有子代理会话文件统一存放在独立的 `~/.epi/runtime/task/sessions/<jobId>.jsonl`（权限 `0600`），不进入 `~/.epi/pi/sessions/`，从根源上杜绝污染 `epi -c` 和 `/resume` 列表。
  - 构造 `fork` 时不调 `ctx.sessionManager.createBranchedSession`，而是读取 `ctx.sessionManager.getBranch()` 内存副本（同时天然支持 `--no-session` 内存模式下的父会话），**从尾部剥离当前未闭合的这一轮 `assistant` `toolCall`（及同轮已产生的兄弟 `toolResult`）**，再写入 `<jobId>.jsonl`。
  - 剥离后必须**重连 `parentId` 链**：Pi 的 `SessionManager` 从叶子沿 `parentId` 回溯，遇到不存在的 id 就停（`session-manager.js` `getBranch`），所以滤掉 `system` 条目、丢掉父会话当前 `user` prompt 后，每个幸存条目都要改接到前一个幸存条目的 `id`（第一个接 `null`），否则子代理会静默丢掉被删条目之前的全部历史。

### 缺陷 2（P0）：Worker 加载扩展后，第三方插件或 MCP 的 `console.log` 会污染 `stdout` JSONL 协议
- **源码根因**：`src/task-runtime.ts:365-370` 将 `worker.stdout` 的每一行都作 `JSON.parse`，一旦出现非 JSON 行就判定 `task worker emitted invalid JSONL` 并令任务失败。此前 `worker.ts` 设了 `noExtensions: true` 所以没暴露；现在接入 `buildInlineExtensions` 与外部插件后，任何插件调 `console.log` 都会直接打崩 Worker 协议。
- **规避方案**：复用 `src/noninteractive.ts:25` 已登记的 Pi 内部模块 `core/output-guard.js`（`pi-internals` 已登记 `output-guard-stdout-write`）：在 `worker.ts` 启动首行调用 `takeOverStdout()`，将所有普通 `process.stdout.write` / `console.log` 重定向到 `stderr`，仅 Worker 自己的 `emit()` 使用 `writeRawStdout()` 输出协议 JSONL。

### 缺陷 3（P0）：非交互模式（`epi -p` / `--mode json`）下默认 `background: true` 会在子代理完成前提前退出进程
- **源码根因**：在交互式 TUI 下，主会话结束当前轮后进程常驻，后台子代理完成后可随时通过 `pi.sendMessage(..., { triggerTurn: true })` 唤醒主会话；但在 `epi -p`（`runPrintMode`）下，主模型一旦结束第一轮回复且没有阻塞中的工具调用，`runPrintMode` 就会立即返回并触发 `session_shutdown`，把还在跑的后台子代理全部 `cancel` 杀掉。
- **规避方案**：在 `epi:task` 中监听 `agent_end`：当处于非交互模式（`ctx.mode === "print" || ctx.mode === "json"`）或当前进程本身就是上层子代理时，若本轮结束时仍有未完成的后台子任务，自动等待（auto-drain）这批后台任务落定并投递结果触发下一轮，保证 `-p` 模式下后台子任务绝不会被半途腰斩。

### 缺陷 4（P1）：`epi:hooks` 的 `type: "agent"` Hook 与 `epi:task` 递归死循环
- **源码根因**：`src/hooks-runtime.ts:328-337` 内部也实例化了一个 `TaskRuntime` 来跑 `type: "agent"` 的 Hook。如果子代理默认开启 `hooks: true`（继承 `hooks.json`），且用户的 `hooks.json` 在 `tool_call` 或 `task_start` 上挂载了 `agent` Hook，就会触发无限派生的死循环。
- **规避方案**：
  - `HooksRuntime` 创建的 `TaskRuntime` 强制固定 `hooks: false, maxDepth: 0`（Hook 检验器自身不再触发 Hook，也不能再派子任务）；
  - 普通子代理继承 `hooks.json` 时，自动过滤掉 `task_start` / `task_stop` 事件及 `type: "agent"` 处理器，只保留确定性的 `command` 与 `http` 处理器守护子代理工具调用。

### 缺陷 5（P1）：运行中 `steer` 在轮次边界（Turn Boundary）的竞态丢消息
- **源码根因**：若主代理调用 `task({ jobId, task: "补充指令" })` 时，Worker 恰好刚跑完 `await session.prompt(initialTask)` 准备退出进程，写入 `stdin` 的 `steer` 消息会因进程退出而丢失。
- **规避方案（2026-10-25 修订）**：
  - Worker 在 `session.prompt()` 返回后置 `loopFinished`；此后到达的 steer 无法投递，worker 逐字上报 `{"type":"steer_dropped","message":…}`（不是静默丢弃，也不再循环等 `pendingMessageCount`）。
  - 父进程**不自动续跑**：自动续跑会与 `task_wait` 竞态（等待者拿到旧一轮结果、新一轮的 push 被吞），且会把已 `cancelled` 的 Job 复活。改为把一行 `[Not applied: a steer arrived after the job finished: "…". Resume with task({ jobId, task }) to apply it.]` 追加到该 Job 的结果文本，由模型决定是否显式续跑。worker 已退出导致的 stdin `EPIPE` 仍是窄竞态（见 development.md §12.4）。

### 缺陷 6（P1）：子目录 `cwd` 下开启 `isolation: "worktree"` 导致相对路径错位
- **源码根因**：若父会话 `cwd` 位于仓库子目录（如 `<repo>/packages/core`），`git worktree add <wtRoot> HEAD` 检出的是仓库根目录 `<wtRoot>`；如果直接把 `<wtRoot>` 当作 Worker 的 `cwd`，子代理内部的相对路径就会偏离 `packages/core`。
- **规避方案**：创建 worktree 前先通过 `git rev-parse --show-toplevel` 与 `--show-prefix` 算出当前 `cwd` 相对仓库根的子路径 `subpath`，将 Worker 的实际工作目录设为 `join(wtRoot, subpath)`；若目标目录不在 Git 仓库内或无任何提交（`HEAD` 无效），在启动前直接报错拒绝，不静默退回原目录。

### 缺陷 7（P2）：合并工具名会导致 `/trace` 将「等待」误计为「新建子任务」
- **源码根因**：`docs/trace-design.md:233` 明确规定：*「后台 task 的提交、等待、取消是各自步骤，不能把 wait 次数当子任务次数」*。若把 `wait` 和 `cancel` 全塞进 `task({ action: "wait" })`，`/trace` 时间轴会把每次等待和查询都画成一次新的 `task` 工具调用，且破坏现有测试与快照基线。
- **规避方案**：保持 `task`（创建/发信）、`task_status`（查询）、`task_wait`（等待屏障）、`task_cancel`（取消）、`todo` 五个工具名字各自独立，既保持单职责清晰，又与 `/trace` 零冲突。

---

## 10. 实现状态与范围修订（2026-10-25）

### 10.1 已实现（已合入 `main`）

| 能力 | 位置 | 说明 |
|---|---|---|
| 统一装配管线 + 8 项原子能力（§3，`isolation` 除外） | `src/worker.ts`、`src/assembly.ts` | 子代理走 `resolveAssembly → scopeAssemblyForTask → buildInlineExtensions`；Rules/Skills/MCP 默认关（用户确认可接受） |
| 模型优先级 调用 > 预设 > 父会话，`":thinking"` 保留基础模型 | `src/task-runtime.ts` `childModelReference` | 测评发现预设 `model:` 被父模型覆盖、`":low"` 丢模型，均已修 |
| 子代理用量计账 `epi:task-usage` | `src/extensions/task.ts` | 带 `createdAt/startedAt/finishedAt`；失败、超时也上报 |
| 并发默认 = CPU 核数（2..16），`EPI_TASK_MAX_CONCURRENCY` | `src/task-runtime.ts` | |
| 生命周期解耦 | `src/extensions/task.ts` | `/compact`、Esc 只停等待不杀子代理；`/new` `/resume` `/fork` `/reload` 不杀；只有 quit 和 `task_cancel` 杀。job 注册表跨会话切换共享 |
| 信任按项目根判定 | `src/project.ts` `childProjectTrust` | 子代理 `cwd` 进入另一个项目时按不信任处理 |
| 子代理里过滤 `type: "agent"` hook 与 `task_start/stop` | `src/extensions/hooks.ts` `hooksForChild` | 即缺陷 4 第 2 条 |

### 10.2 包 1 已实现（2026-10-25 合入）

- stdin 双工管道：父进程 SIGKILL 后 worker 读到 EOF 自行退出，工具子进程一并回收（取代旧的 `process.once("exit")` 兜底，它覆盖不了 SIGKILL）。
- progress 事件 → `task_status({jobId})` 显示当前轮次、步数、正在做什么、最近 10 步；`task_status({})` 列出全部任务；id 可用 8 位以上的唯一前缀。
- 运行中 steer：`task({ jobId, task })`，经 `session.agent.steer` 逐字投递（不做命令展开，`/epi …` 不再能打挂 worker）；session 就绪前到达的 steer 先缓存再投递；queued 任务改为替换文本。steer 与替换文本都先过父进程的 `task_start` hook。

### 10.2b 包 2 已实现（2026-10-25 合入）

- **结束后按 `jobId` 续跑（§2.3）**：对 `completed`/`partial`/`failed`/`cancelled` 的 Job 调用 `task({ jobId, task })`，用 `SessionManager.open(job.sessionPath)` 重开原会话文件续跑；Job 保持 id/`createdAt`/`sessionPath`，`turns`/`steps`/`compactions`/`usage` 跨轮累加（worker 只报本轮，父进程逐轮相加；`epi:task-usage` 条目只含该轮自身的消耗）；capsule 复用原设置，不再写 fork entries；会话文件缺失则报错不启动；续跑默认前台，`background: true` 时只回执；续跑文本先过 `task_start` hook；artifact 按轮命名，`delivered` 按轮清除。
- **push 唤醒（§2.2）**：`background: true` 的 Job 落定且无人等待时，父会话收到一条 `epi:task-notify` follow-up（`deliverAs: "followUp"`, `triggerTurn: true`）；300ms 内落定的多个 Job 合并成一条；已被 `task_wait`/`task_cancel` 收回的 Job 不重复推送；`-p`/json 模式下进程可能先于后台 Job 落定退出，此限制已知且不阻塞退出。
- **agent loop 结束后到达的 steer 不再丢字（§9 缺陷 5）**：worker 报 `{"type":"steer_dropped","message":…}`，父进程把 `[Not applied: … Resume with task({ jobId, task }) to apply it.]` 追加到该 Job 的结果文本后，由模型决定是否续跑；不自动续跑（自动续跑会与 `task_wait` 竞态，并可能复活已取消的 Job，2026-10-25 主会话决定）。

### 10.3 包 2 已实现（2026-10-25 合入）

- **子代理自己压缩**（用户决定）：子代理的 auto-compaction 永远开启（内存覆盖，不写用户 settings；`/reload` 后重新套用；`reserveTokens`、`keepRecentTokens` 按窗口比例夹住，含 per-model 覆盖）。压缩救不回来时（溢出错误，或输出远低于上限就因 `length` 停下）以 `partial` 结束：保留已完成的回答，父进程在截断之后补一行停止原因，会话文件保留可续跑。父进程看得到 `⟲ compacted 42k→13k` 与压缩次数。用量按会话原始条目累计，包含被压缩掉的轮次与摘要请求本身。
- **按 jobId 续跑**：`task({ jobId, task })` 对已结束的任务在同一个会话文件上继续；用量按"每次运行"上报、父进程累加；产物文件按运行编号区分。
- **push 唤醒**：`background: true` 的任务结束且无人等待时，经当前会话发一条 `epi:task-notify`（300 ms 合并，已被 `task_wait` 收走的不再推送）。`epi -p` 下进程可能先退出，不阻塞退出。
- **最后一轮之后到达的 steer**：不自动续跑（避免隐藏的第二次运行与竞态），在结果里写明"未应用"，由模型决定是否续跑。

实测（真实模型 deepseek-v4.1-flash，`.dev/probes/live-*.mjs`）：续跑后子代理不读文件也答出上一轮读到的内容；声明 40k 窗口时读 6 个文件、压缩 2 次后给出正确答案；声明 10k 窗口时以 `partial context` 结束。

### 10.4 明确不做（用户决定）

| 项 | 原因 |
|---|---|
| 孙代理（子代理再派子代理） | 用户决定；子代理里永不加载 `epi:task` |
| `ask_parent`（子代理阻塞问父代理）、`waiting` 状态 | 父子互等带来死锁与超时策略，正是 §1.2 要砍掉的 `contact_supervisor` 双向锁 |
| 界面代办（子代理的 `ui.confirm/select` 转到主 TUI） | 子代理按 `-p` 规则运行，无界面时取默认值已够用 |
| `background` 默认 `true` | 同一轮多个前台 `task` 已经并发且一次返回，比后台 + `task_wait` 少一轮请求 |

### 10.5 实测发现（`.dev/bench/subagents-2026-10-23/report.md`）

- 委派的收益是父上下文（峰值降 63–82%）和墙钟（并发后最快），**省钱只在父模型比子模型贵时成立**。
- **便宜父模型不会主动委派**：flash 在测评自由组、5 个开发任务中 4 个（含规则里写明"必须委派"的 2 个）都是 0 次委派；只有 1 个任务派了 2 次。光靠工具描述和规则不够，需要机制（例如父上下文超阈值时提示），待设计。

---

## 11. 包 3 设计：可靠投递信箱、底栏微提示、实时任务行（2026-10-26）

背景：对照 Claude Code MCP Tasks 客户端交互与 Peri Code `AsyncResultMailbox`（`docs/design/session-async-tasks.md` §3），并由主控与 `claude-opus-5-5:high` 联合走查 `src/extensions/task.ts`、`src/task-runtime.ts`、`src/tui/app.ts` 与 `@earendil-works/pi-coding-agent` 1.4.0 的 `dist/core/agent-session.js`，确认包 2 存在后台结果通知丢失漏洞与 TUI 可见性缺口，收敛为以下三项改进。

### 11.1 走查发现的真问题（核对源码）

| # | 问题 | 源码位置与触发条件 |
|---|---|---|
| 1 | **`flushNotify` 在确认落盘前就清空 `pendingNotify`** | `src/extensions/task.ts:463-475` 先 `pendingNotify.splice(0)` 再调 `pi.sendMessage`。而 `agent-session.js:2765-2772` 中 `sendMessage` 内部是 `this.sendCustomMessage(message, options).catch(→ emitError)`（fire-and-forget），后续队列被清空或 `_startRun` 抛错都不会回到 `task.ts` 的 `try/catch`。 |
| 2 | **流式运行中按 `Esc` / `Alt+Up` / `Ctrl+C` 永久擦除后台任务通知** | 主会话流式运行中（`this.isStreaming === true`），`sendCustomMessage`（`agent-session.js:1857-1859`）把 `epi:task-notify` 放进底层 `this.agent.followUp(appMessage)`，而**不进** `this._followUpMessages`（后者只存用户文本，见 `1811-1818`）。当用户按 `Esc`（`src/tui/keys.ts:49-51`）、`Alt+Up` 取回排队消息（`keys.ts:156`）、`Ctrl+C`（`keys.ts:89-93`）或扩展调 `ctx.abort()`（`src/tui/app.ts:810-814`）时，`restoreQueuedMessagesToEditor()` → `clearAllQueues()`（`app.ts:926-965`）调用 `session.clearQueue()`（`agent-session.js:1944-1951`）执行 `this.agent.clearAllQueues()`，底层队列里的 `epi:task-notify` 被彻底抹掉，而编辑器只恢复用户文本数组。结果既不进会话历史，也不再重发。 |
| 3 | **手动 `/compact` 或 `/tree` 分支摘要期间到达的通知并发启动 `_startRun`** | `compact()`（`agent-session.js:2230-2232`）先 `await this.abort()`，此时 `this.isStreaming` 为 `false`、`_compactionAbortController` 非空。`prompt()` 在 `1647` 行显式拦截了 `_compactionAbortController !== undefined`，但 `sendCustomMessage`（`1844-1872`）没有该检查，会直接与正在进行的手动压缩并发调用 `this._startRun()`。 |
| 4 | **跨会话串台唤醒** | `TaskRuntime` 是进程级共享的（`src/extensions/task.ts:379`）。会话 A 启动的后台任务在用户切到 `/new`（会话 B）后完成，`flushNotify` 会读取 `current.pi` 直接向会话 B 发送 `Job <id> completed` 并触发新轮次，而会话 B 的模型根本不知道这个任务。 |
| 5 | **底栏状态与前台实时进度缺失** | `src/extensions/task.ts` 未调用 `ctx.ui.setStatus("epi-task", ...)`，也未注册 `renderCall` 或在等待期间调用 `onUpdate`；前台 `task` 落入 `src/tui/tools/block.ts:111` 的 `fallbackCall`（只显示粗体 `◆ task`，无任务描述、无耗时条、无步骤进度），折叠完成结果还打出了 36 位完整 UUID（`task.ts:293`）。 |

### 11.2 改进一：进程内轻量结果信箱（`Mailbox`，替代 `pendingNotify` + `delivered`）

不引入 Peri Code 的 SQLite 持久化表（Epi 退出进程时 `runtime.shutdown()` 会终止所有子代理，无需跨进程冷恢复），在 `src/extensions/task.ts` 闭包内用一个 `Map<string, MailboxEntry>` 闭环：

```text
          settle && (background || wakeOnSettle) && !collected
                                 │
                                 ▼
     ┌──────────── unsent ◄──────────────────────────────┐
     │                │ flush() when canWake()           │ agent_settled (no receipt),
     │                ▼                                  │ session_start,
     │              sent ────────────────────────────────┘ originSessionId !== current
     │                │ message_end(epi:task-notify, details.jobIds ∋ id)
     │ before_agent_start (any run on originSession): attach as { message }
     │                ▼
     └──────────► delivered (mailbox.delete)
  task_wait / task_cancel / task_status(jobId) on settled job ──► mailbox.delete
  resume(jobId)                                               ──► mailbox.delete
```

```ts
interface MailboxEntry {
  job: TaskJobSnapshot;
  run: number;
  originSessionId: string | undefined;
  state: "unsent" | "sent";
  /** 用户主动按 Esc 中断后置为 false：不再自动开新轮次，留给底栏提示与下次用户提问捎带。 */
  autoWake: boolean;
}
```

1. **创建条目**：后台任务（或前台等待被中断转入 `wakeOnSettle` 的任务）落定时，若尚未被同步收回，写入 `mailbox.set(job.id, { job, run, originSessionId, state: "unsent", autoWake })`。其中前台等待若因非压缩期间的用户 `Esc` 中断，初始 `autoWake` 设为 `false`（用户刚按了停止，不应几分钟后自己开一轮）；若因压缩中断则 `autoWake: true`。
2. **准入条件 `canWake()`**：同时满足 ① `current.pi` 与 `current.ctx` 存在；② `current.ctx.sessionManager.getSessionId() === entry.originSessionId`（只唤醒发起该任务的原会话）；③ `!compacting`（在 `session_before_compact` / `session_before_tree` 置 `true`，在 `session_compact` / `session_compact_failed` / `session_tree` 置 `false` 并重调 `flush()`）。
3. **发送与回执确认（Cover after commit）**：
   - `flush()`（保持 300ms 微批合并）挑出当前会话 `state === "unsent" && autoWake` 的条目，调用 `pi.sendMessage({ customType: "epi:task-notify", content, display: true, details: { jobIds } }, { deliverAs: "followUp", triggerTurn: true })`，将状态标为 `"sent"`（**不删除条目**）。
   - 监听 `message_end`：当收到 `message.role === "custom" && message.customType === "epi:task-notify"` 时，按 `message.details.jobIds` 精确删除已落盘进 `sessionManager` 的 `MailboxEntry`（此时才算真正送达）。
   - 监听 `agent_settled`：本轮结束时，所有仍处于 `"sent"`（未收到 `message_end` 回执，说明被 `Esc` / `Alt+Up` / `clearQueue` 擦除或 `_prepareRun` 失败）的条目退回 `"unsent"`；若 `event.aborted === true`，同时将这些条目的 `autoWake` 置为 `false`。
   - 监听 `session_start`：所有 `"sent"` 条目退回 `"unsent"`；若切回了某条目的 `originSessionId`，触发 `flush()`。
4. **下一轮启动捎带（`before_agent_start` 兜底）**：
   - 监听 `before_agent_start`：当用户在原会话发起新一轮提问（且触发源不是 `epi:task-notify` 自身）时，若存在属于该会话的 `"unsent"` 条目（含此前因 `Esc` 将 `autoWake` 置为 `false` 的条目），直接通过 `before_agent_start` 返回 `{ message: { customType: "epi:task-notify", content, display: true, details: { jobIds } } }` 挂入本轮起始消息并标为 `"sent"`。该路径发生在 `_prepareRun` 内部（`agent-session.js:1514-1523`），不经过 `followUp` 队列，不受 `clearQueue()` 影响。
5. **主动拉取即销账**：模型调用 `task_wait({ jobId })`、`task_cancel({ jobId })`、或对已落定任务调用单查 `task_status({ jobId })`（返回完整 `jobResult`）时，直接 `mailbox.delete(job.id)`，不再重复推送。`task_status({})` 列表摘要不销账。

### 11.3 改进二：底栏实时状态微提示（`ctx.ui.setStatus("epi-task", ...)`）

1. **`TaskRuntime` 状态变更回调**：
   在 `TaskRuntimeOptions`（`src/task-runtime.ts:325`）新增可选 `onChange?: (jobId: string) => void`，由私有 `notifyChange(jobId)`（内包 `try/catch`）在 `start`、`resume`、`steer`（仅 queued 替换文本分支）、`run` 启动、`applyProgress`、`finish` 时触发。只传 `jobId`，避免每次工具进度都深拷贝 `recentEvents`。
2. **纯事件驱动、零定时器、80 列预算**：
   - `src/tui/chrome.ts:28-33` 的 `shortcutsBar` 在 80 列终端下左侧快捷键占约 68 列，右侧留给 `statuses`（含 `epi-update`）仅约 12–14 列。因此底栏**不放 jobId、不放工具参数、不起动画定时器**（严守 `docs/dev-workflow.md` §9 的静默帧 `fullRedraws` 增量为 0 不变量），只显示静态符号与计数：

   | 状态 | 底栏文本（`epi-task`） | 颜色 |
   |---|---|---|
   | 仅有运行中任务 | `◐ 2 tasks`（单数为 `◐ 1 task`） | `accent` |
   | 运行中 + 排队中 | `◐ 2+1 tasks` | `accent` |
   | 仅有未收取的已完成/失败任务（在 `mailbox` 中） | `✓ 1 done`（若含失败则为 `✗ 1 failed`） | `success` / `error` |
   | 同时有运行中与未收取任务 | `◐ 2 · ✓ 1` | 组合 |
   | 无活跃任务且 `mailbox` 为空 | `undefined`（清除槽位） | — |

3. **跨会话保留与去重**：
   - 记录上一次设置的文本 `lastStatusText`，仅在文本变化时调用 `ctx.ui.setStatus("epi-task", text)`，将高频 `applyProgress` 降为 O(1) 空操作。
   - 在 `pi.on("session_start")` 中重置 `lastStatusText` 并立即调一次 `refreshStatus()`，补回被 `clearExtensionUiState()`（`src/tui/app.ts:834`）清空的底栏状态。

### 11.4 改进三：Grok 单列 `renderCall`、节流 `onUpdate` 与通知渲染器

1. **四个工具全部补齐 `renderCall`（基于 `CallLine`，`src/tui/tools/common.ts:166`）**：
   - `task`：`task [<agent>] "<task 前 50 字>"`（后台任务带 `bg` 尾注；传 `jobId` 时按状态显示 `steer <id8> "…"` 或 `resume <id8> "…"`）。
   - `task_wait`：`wait <id8>`。
   - `task_status`：`status <id8>` 或 `status all`。
   - `task_cancel`：`cancel <id8>`。
2. **前台等待期间的节流 `onUpdate`（实时进度上屏）**：
   - 在前台 `runJob` 与 `task_wait` 等待期间，订阅该 `jobId` 的 `onChange` 事件。
   - 当 `turn N · now: <tool>: <target>` 发生变化时，按 **250ms 尾随节流**（`unref()` 定时器）调用 `onUpdate({ content: [...], details: snapshot })`；等待结束或 `signal` 中止时立即退订并清理定时器。
3. **`renderResult` 对齐「成功不占行」**：
   - 运行中（`context.isPartial`）：调用 `setCallSummary(context, "turn 2 · bash: npm test")` 并返回空 `LinesComponent`（0 行），让实时步骤与 `CallLine` 右侧的对数耗时条同行刷新，不引起工具块高度跳动。
   - 终态折叠（`!options.expanded`）：成功时 `setCallSummary(context, "3 turns · 28 lines")` 且结果占 0 行；后台回执时 `setCallSummary(context, "bg · 1a2b3c4d")` 占 0 行；失败时返回单行 `failureRow(theme, error)`。
   - 终态展开（`options.expanded`）：显示最多 10 行正文，超出部分提供可点击的 `… +N lines`（打开 Buffer Inspector）。所有展示统一使用 8 位短 ID（`shortJobId`），不再打印 36 位 UUID。
4. **`epi:task-notify` 消息渲染器**：
   调用 `pi.registerMessageRenderer("epi:task-notify", ...)`，将后台唤醒消息渲染为紧凑单行（每任务一行 `✓ <agent|task> <id8> · <summary>`），替代默认的裸 custom 文本块。

### 11.5 实施拆分与文件预算（单包 `src/` 远低于 800 行红线）

| 子步骤 | 改动文件 | 预估行数变化 | 核心验证点 |
|---|---|---|---|
| **Step 1：可靠信箱 + 底栏状态** | `src/task-runtime.ts`、`src/extensions/task.ts` | +110 / -25 行 | ① 流式运行中落定后按 `Esc` / `Alt+Up`，底栏显示 `✓ 1 done`，下一轮用户提问通过 `before_agent_start` 捎带送达；② 手动 `/compact` 期间落定不并发调 `_startRun`；③ `/new` 切到新会话不乱唤醒，切回原会话或 `session_start` 后底栏仍在；④ 单查 `task_status({ jobId })` 后信箱销账。 |
| **Step 2：单列 `renderCall` + 实时 `onUpdate`** | `src/extensions/task.ts` | +95 / -40 行 | ① 前台 `task` / `task_wait` 运行中 `CallLine` 尾部每 250ms 更新 `turn N · <tool>`；② 完成后折叠占 0 行、展开可进 Inspector；③ 静默时 `fullRedraws` 增量为 0。 |

