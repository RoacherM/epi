---
title: Dispatch 异步调度与多代理协同扩展设计
description: 标准可移植 Pi 扩展（内置于 Epi src/extensions/dispatch/），以 bash（进程作业）、task（单/具名子代理）、board（同伴共享白板）、timer 与 outbox 五个正交原语统一后台任务与 Always-On 运行时。
---

# Dispatch 异步调度与多代理协同扩展设计（`src/extensions/dispatch/`）

状态：**已确认，分阶段实现中**（2026-11-17，决策 `DP1`；扩展独立版本起点 `DISPATCH_EXT_VERSION = "0.1.0"`，tag 前缀 `dispatch-v*`）。
核对基线：Epi `0.2.6`、`@earendil-works/pi-coding-agent@1.4.0`、`@earendil-works/pi-agent-core@1.4.0`、Node `v26.12.1`（`engines.node >= 22.19.0`），参考 Anthropic《[Building always-on agents](https://claude.com/resources/articles/building-always-on-agents)》（William Hu，2026-11-13），并经 `claude-fable-5-2-high` 多轮源码级辩论收敛。

与现有代码和文档的关系：
- **抽离迁移而非推倒重写**：现有单层任务系统共 4,618 行（`src/extensions/task.ts`、`src/task-runtime.ts`、`src/worker.ts`、`src/extensions/task-notify.ts`、`src/worker-reaper.ts`、`src/task-worktree.ts`）。实施上先做行为不变的纯抽离解耦（现有 `test/task*.test.mjs` 全绿），再增量接入异步 `bash`、共享 `board`、Timer、外部事件收件箱与 Outbox/`/approve` 护栏。
- **消除 `Swarm` 伪双轨，统一为「具名 `task` + 共享 `board`」**：工程协作需要的不是无主蚁群（Leaderless Swarm），而是「主控切清模块边界 + 专职子代理执行 + 同伴间按 `@name` 点对点交接」。因此不另造一套重复的 `swarm add/kill/status` 管理工具——所有后台 Agent 统一由 `task` 派生、由 `task_{status,wait,cancel}` 管控；传了 `name` 的具名子代理自动接入当前会话的共享 `board`（`board_post` / `board_read` / `board_wait`）。
- **与 `epi:monitor` 解耦**：`src/extensions/index.ts:65-72` 将 `epi:monitor` 从 `buildTaskPair` 拆出，作为独立的流式日志/WebSocket 监听扩展保留；有限耗时命令与本地常驻测试服务统一走异步 `bash`。
- 开发期 `src/extensions/dispatch/` 独立单测，最后阶段切换 `src/extensions/index.ts` 后归档旧 `task.ts` 与 [`archive-subagents-design.md`](notes/archive-subagents-design.md)（`epi.json` 内仍兼容 `disable: ["epi:task"]` 开关）。

---

## 1. 现状问题与第一性原理剪裁

### 1.1 要补齐的真实缺口

1. **【独立活体 Bug，Stage 0 先行修复】运行中后台通知在 TUI 隐身**：`src/extensions/task-notify.ts:340-349` 在 `turn_end` 与 `agent_before_settle` 提交边界草稿时，Pi 内核 `_commitBoundaryDrafts`（`agent-session.js:635-640`）只发 `entry_appended`、不发 `message_start/end`。原生 Pi 在 `interactive-mode.js:2737-2751` 处理了它，而 `src/tui/transcript.ts:230-297` 漏了 `case "entry_appended"`，导致通知虽已写入 JSONL 喂给模型，屏幕上却看不见，直到 `/reload` 才刷出。
2. **缺通用后台 `bash`，子代理内无长命令通道**：`src/bash-guard.ts:39,258-272,352-354` 拦截 `nohup`/`setsid`/`&` 并在 `:59-82` 限死默认 120s、上限 600s 超时即杀；`src/monitor-stream.ts:106-147` 持续高输出满 30s 直接判 `flooded` 强杀进程树；子代理因剥离 `epi:task`（`src/assembly.ts:177-179`）连带失去 `epi:monitor`，无法拉起本地测试服务再跑验收。
3. **缺 Always-On 休眠自唤醒闭环与无头模式完结排空**：缺 `timer`（`follow_up` 自设闹钟 / `schedule` 周期计划）、外部 Webhook/CLI 收件目录与静默优先 `outbox`；`src/noninteractive.ts:136-153,202-223` 在首轮 `session.prompt()` 返回后立即 `disposeRuntime()` 强杀所有在途后台任务。
4. **子代理间无法点对点交接，且缺分支防误删门禁**：现有 `epi:task` 子代理彼此失明，上下游交接（如编码 → 审查）只能靠主会话居中复读污染主上下文；`src/task-worktree.ts:50` 只建 `--detach` 匿名头，无命名分支、写时复制工作树及取消前脏改动检查。

### 1.2 四刀架构剪裁（不把云端 SaaS 复杂度搬进本地单宿主进程）

1. **单宿主内存持有内部状态，不引入多进程 SQLite 与 `/tmp` Socket 门铃**：后台命令退出、Worker 落定、定时器到点、看板 `@mention` 全部产生在根宿主进程（或直连 `fd 3` 管道的子进程）内，直接进内存态 `NotificationLedger`；仅外部进程（Webhook 桥、CLI 投递器）走按目标隔离的磁盘目录队列 `<stateDir>/inbox/<target>/{tmp,pending,done}/`。
2. **「0 进程休眠」放在根会话 Run 之间；活跃 Worker 保持热驻留直到终态（`Terminal`）**：等待态的 `AgentSession` 本身就是 **0 Token、0% CPU**，热驻留保住了子代理内已连接的有状态 stdio MCP 服务与子进程句柄，并守住「Worker 进程退出 === 任务终结并回收孤儿树」的不变量。具名协作子代理设空闲上限（默认 15m），到期以 `partial` 落定，后续可按 `jobId`/`name` 重新打开 `.jsonl` 原地续跑。
3. **不包一层 `durable-runner` 守护进程，由所属宿主/Worker 直接 `spawn` 管控**：TUI `/reload` 通过 `globalThis` 单例保留运行中 `ChildProcess`（不捕获旧 `pi`/`ctx`）；`epi -p` 与 Worker 通过共用 `agent_settled` 排空屏障保活到有限命令结束；`--mode rpc` 常驻宿主本身不退出。直接持有 `ChildProcess` 让前台 `bash` 超窗或按 `Alt+B` 放手变成纯粹「提前 resolve 工具等待 Promise」，零重跑副作用、内存直写 `stdin`、内核直接投递 `exit`。
4. **不另建 `<stateDir>/memory/` 平行文件记忆层**（决策 `DP1`）：复用工作区文件、`AGENTS.md`/`epi.json` 与 `outbox` `dedupKey` 硬去重 + 压缩后单行在途状态摘要，不造绕过 Manifest 信任门禁的第二套隐式规则通道。

---

## 2. 可移植边界与正交原语切片

### 2.1 100% 公开 SDK 标准 Pi 扩展 + Epi 薄适配

`src/extensions/dispatch/**` 零引用外层 Epi 模块（单测静态扫描 `import` 强校验），只依赖 Node 内置模块、`@earendil-works/pi-coding-agent`（兼容 `@mariozechner/*` 别名）、`@earendil-works/pi-tui` 与 `typebox`：

- **`fd 3` 独立协议管道替代非公开 `takeOverStdout()`**：`pi-worker.ts` 使用 `stdio: ["pipe", "ignore", "pipe", "pipe"]` 的 `fd 3` 传输父子 JSONL 协议，插件或 MCP 往 `stdout`（`fd 1`）打任何日志都不污染协议流，**零 `pi-internals.md` 新增依赖**。启动胶囊显式传入解析后的 Node 可执行路径与宿主 SDK 入口 URL。
- **双入口**：
  1. **`export default function (pi: ExtensionAPI): void`**：供外部环境 `pi -e dist/extensions/dispatch/index.js` 零配置加载（通过 `globalThis[Symbol.for("pi.dispatch.runtime.v1")]` 按 `agentDir` 跨 `/reload` 复用进程表）。
  2. **`export function createDispatchExtension(host?: DispatchHostAdapter): ExtensionFactory`**：Epi 在 `src/extensions/index.ts` 注入 `stateDir: join(epiHome, "runtime", "dispatch")`、Epi Worker 装配钩子（加载 `.epi/agents` 与 Magpie Provider）、可选 `classifyToolCall` 策略、共享守护进程豁免名单（如 `herdr`）与按键/视图适配。

### 2.2 固定单层拓扑（Depth = 1）与静态工具集

通过胶囊角色与可继承环境变量 **`PI_DISPATCH_DEPTH=1`** 双重封死嵌套（Worker 在 `bash` 里跑 `epi -p` / `pi -p` 时检测到 `PI_DISPATCH_DEPTH >= 1` 同样不注册 `task`）。工具集在会话启动时一次定型，跨回合绝不动态增删以保住 KV Cache：

| 会话角色 | 挂载的静态工具集 | 边界说明 |
|---|---|---|
| **根会话 (`root`)** | `bash`、`task`、`task_status`、`task_wait`、`task_cancel`、`task_input`、`board_post`、`board_read`、`board_wait`、`timer`、`outbox`（Epi 内另保 `todo`） | 完整调度权；`timer` 只负责创建（返回 `tm_<id>`），查询与取消统一走 `task_status` / `task_cancel` |
| **匿名子代理 (`task-worker`)** | `bash`、`task_status`、`task_wait`、`task_cancel`（限自身 `bg_*` / `tm_*`）、`task_input`（仅自身 `bg_*`）、`timer`（仅单次 `follow_up`）、`report_progress` | 自带异步 Shell 与定时自唤醒闭环；**无 `task`、无 `outbox`**（遇阻塞问题以 `partial` 返回父会话） |
| **具名协作子代理 (`peer-worker`)** | 同上 `task-worker` 工具集（不含 `report_progress`）+ `board_post` + `board_read` + `board_wait` | `task` 指定了 `name` 时启用：共享白板按 `@name` 横向交接 + 自身异步 Shell/定时调度；**不可派生新子代理** |

### 2.3 模块结构（高内聚可扩展骨架）

```text
src/extensions/dispatch/
  index.ts            # 标准默认入口（globalThis 跨 reload 保持）+ createDispatchExtension 工厂
  types.ts            # 统一 Job / Board / Timer / HostAdapter 扩展契约接口
  notify-ledger.ts    # 统一内存账本、entry_appended 销账、PollGuard、agent_settled 完结排空
  inbox-spool.ts      # 按 target 隔离的外部事件目录队列 inbox/<target>/{tmp,pending,done}/（link() 去重）
  timers.ts           # 会话内 appendEntry 定时器 + 按 target 隔离的 schedules/<target>/ + 内存最小堆
  bg-bash.ts          # 自定义 bash execute（保 BashToolDetails 兼容）、同步窗口/放手、bg/<id>.json 对账
  reaper.ts           # 自装 SIGINT/SIGTERM/SIGHUP 钩子 + BASH_ENV PGID 账本 + Cookie 全局清扫
  worktree.ts         # inherit / branch / CoW share 工作区隔离与基线脏改动检查
  worker-host.ts      # 热驻留单/具名 Worker 池、forkableBranch（含同伴 forkFrom）、出口 verifyCommand
  pi-worker.ts        # fd 3 JSONL 协议独立子进程入口 + 挂载 task-worker / peer-worker 静态切片
  board.ts            # 单写者 board.jsonl、@name 路由、三路唤醒 board_wait 与去重停滞检测
  outbox-guard.ts     # outbox 工具（dedupKey 硬去重）+ 根进程纯内存 pending/grants 与 /approve 命令护栏
  tui-views.ts        # 公开 @earendil-works/pi-tui 底栏与 /tasks、/board 浮层（Epi 经适配器接专用视图）
```

---

## 3. 核心机制与状态机契约

```text
           ┌─────────────────────┐   ┌────────────────────┐
           │ Webhook / CLI Spool │   │ Timers & Schedules │
           └──────────┬──────────┘   └──────────┬─────────┘
                      └────────────┬────────────┘
                                   ▼
                      ┌─────────────────────────┐                             settle / @mention
                      │ Host NotificationLedger │◄─────────────────────────────────────────────┬┐
                      └────────────┬────────────┘                                              ││
                                   │                                                           ││
                                   ▼wake / boundary                                            ││
                       ┌───────────────────────┐                                               ││
                       │ Root Session (0 token │                                               ││
                       │         idle)         │                                               ││
                       └──────────┬▲───────────┘                                               ││
          ┌───────────────────────┼┴──────────────────────────┐                                ││
          ▼outbox / /approve      ▼                           ▼                                ││
 ┌─────────────────┐   ┌─────────────────────┐   ┌─────────────────────────┐                   ││
 │ User / RPC Host │   │ Warm Workers (fd 3, │   │ BgProcessRuntime (PGID) ├───────────────────┘│
 └─────────────────┘   │      Depth=1)       ├───└─────────────────────────┘────────────────────┘
                       └─────────────────────┘
```
*(注：最下方中框 `Warm Workers` 与右框 `BgProcessRuntime` 的完成/留言通知是两条独立回线，均直接汇入 `Host NotificationLedger`。)*

### 3.1 统一内存账本（`notify-ledger.ts`）与多宿主安全的外部收件目录（`inbox-spool.ts`）

1. **内部事件走纯内存 `NotificationLedger`**：
   - 会话级单一实例统一合并 `bg_bash` 退出、`task` 完结/里程碑、`timer` 到期与 `board` `@coordinator` 点名/停滞告警（`250ms` 微批窗口，单批上限 `12 KiB`，外部文本转义 `<system-reminder|system|user|assistant>` 标签）。
   - **精确销账**：边界草稿（`turn_end` / `agent_before_settle`）只发 `entry_appended` 不发 `message_end`；空闲直投发 `message_end`。账本在 `details.receiptIds` 打标，收到匹配的 **`entry_appended`、`message_end` 或分支树对账**任一确认即销账；运行中被 `Esc` 清队列未落盘的条目在 `agent_settled` 退回 `unsent`（仅交互用户在 `root` 显式按 `Esc` 时置会话级 `abortedLatch = true` 暂停自动开轮）。
   - **拉取即销账 + `PollGuard` + 压缩后摘要**：主动调 `task_status({ id })`（已终态）、`task_wait` 或 `board_read` 读走对应消息时撤回待发通知；10s 内重复轮询同一未变快照返回缓存提示；`compaction_end` 后的首次唤醒消息头部自动附带一行宿主生成的在途 `bg_*` / `tm_*` / `job_*` 摘要。
2. **按 `<target>` 隔离的外部目录队列 `<stateDir>/inbox/<target>/{tmp,pending,done}/`**：
   - **明确归属与锁冲突可见**：`<target>` 为具名守护通道（`host.inboxTarget` 或 `PI_DISPATCH_INBOX=<name>`）或精确 `sessionId`。普通交互 TUI 默认不挂载公共外部收件箱。绑定具名 `<target>` 的宿主启动时校验 `<target>/owner.lock`（`{ pid, startedAt }`）：若对应进程仍存活直接抛启动错误（`architecture.md` §3.8 失败可见）；接管死锁后每次扫描前重读锁文件确认 `pid === process.pid`。
   - **原子无损写入与去重**：外部投递方先写 `tmp/<uuid>.tmp` 并 `fsync`，再调 **`fs.linkSync(tmpPath, pending/<sha256(dedupKey)>.json)`** 后 `unlinkSync(tmpPath)`（`link()` 遇同名原子报 `EEXIST`）。宿主消费前先查 `existsSync(done/<sha256>.json)` 防重放，收到落盘回执后 `rename` 进 `done/`（清理 `> 7` 天旧文件）。`fs.watch` 仅作提示，每次触发跑全量 `readdir`，辅以启动首扫与 `1s` `.unref()` 兜底扫描（规避 macOS FSEvents 新建目录异步注册窗与硬链接合并漏报）。

### 3.2 `Timers`：会话内 `appendEntry` 闹钟与按 `<target>` 绑定的周期计划（`timers.ts`）

- **会话内单次闹钟 `follow_up`（`root` 与 `worker` 均可用）**：
  - `root` 会话通过公开接口 **`pi.appendEntry("dispatch:timer", { op: "set" | "fired" | "cancel", id, originSessionId, dueAt, prompt })`**（`extensions/types.d.ts:1272`，不发给模型）写进当前 `.jsonl` 流；`session_start` 折叠重建时严格要求 `originSessionId === ctx.sessionManager.getSessionId()`（防 `/fork` 双触发）。
  - 热驻留 `worker` 内 `follow_up` 为内存 `setTimeout`（要求 `delaySeconds` 小于 Worker 剩余 `timeoutSeconds`），计入该 Worker 的有限在途工作。
- **跨会话周期计划 `schedule`（仅绑定了具名 `<target>` 的常驻 `root` 宿主可用）**：
  - 初版支持 `'every:<N><s|m|h>'` 与本地时区 `'daily:HH:MM'`，存于 `<stateDir>/schedules/<target>/<id>.json`。离线错过的周期在下次启动时合并补发一次；`sessionMode: "fresh"` 统一派生单层 `task-worker` 执行。

### 3.3 进程内受管异步 `bash` 与分离式崩溃对账（`bg-bash.ts` + `reaper.ts`）

1. **自定义 `execute`（兼容原生 `BashToolDetails`）与零重跑放手**：
   - 同步完成时严格保持 `BashToolDetails`（`truncation`、`fullOutputPath`）结构；输出写尾部环形缓冲与 `<stateDir>/bg/<id>.log`（`0600`，`20 MiB` 封顶后停止写盘但持续排空管道防 `SIGPIPE`）。
   - 前台竞速 `[exitPromise, syncWindowTimer, manualDetachSignal]`：超窗、`isDaemon: true` 或按放手快捷键时提前返回 `{ status: "running", id: "bg_<id>", logPath }`，同一 `ChildProcess` 留在内存注册表并在 `exit` 时推入账本。
2. **分离「进程终态 (`status`)」与「会话通知 (`notified`)」的崩溃对账**：
   - 转后台时写 `<stateDir>/bg/<id>.json`（`{ id, sessionId, hostPid, cookie, command, logPath, status: "running", exitCode?: number, notified: false }`）；正常退出写 `status: "exited"` 与 `exitCode`，收到 `entry_appended`/`message_end` 回执后置 `notified: true`。
   - **任意宿主启动时分两步扫描全部 `bg/*.json`**：① 先对所有 `status === "running"` 且不在本进程内存注册表（跨会话记录判原 `hostPid` 已不存在）的条目，按 `cookie` 清扫残留孤儿进程组，改标 `status: "lost"`（保持 `notified: false`）；② 再对属于当前恢复 `sessionId` 且 **`status !== "running" && notified === false`** 的全部终态条目，按 `id` 幂等补压完成或 `bg_lost` 通知，收到落盘回执后置 `notified: true`。
3. **可移植信号钩子**：`SIGINT` / `SIGTERM` / `SIGHUP` 退出清理由扩展内 `reaper.ts` 引用计数安装，原生 `pi -p -e` 与 `epi -p` 行为一致。

### 3.4 共用完结排空屏障与父会话 `steer` 原角色穿透

`print`/`json` 根会话与热驻留 `pi-worker.js` 共用同一段 `pi.on("agent_settled")` 排空逻辑：
- 只要当前会话仍有**有限在途工作**（运行中 `!isDaemon` 的 `bg_bash`、活跃 `task` 子代理、或未到期的 `follow_up` 闹钟），就在 `agent_settled` 等待下一次 `NotificationLedger.flush()` 触发 `_deferredSettledActions` 续跑。
- 在 `pi-worker.js` 中，父会话经 `fd 3` 发来的 `steer` 直接唤醒屏障退出等待，并按现有 `src/worker.ts:224-236` 原样作为 `user` 指令送入下一轮 `session.prompt()`（不套系统背景事件前缀）。屏障设总时限 `drainMaxMs`（对齐在途任务最大剩余寿命 + 5s 宽限）。

### 3.5 具名 `task` + 共享 `board` 协同机制（`board.ts`）

- **具名子代理即看板成员**：调用 `task({ name: "parser", task: "...", ... })` 时，校验 `name` 在当前活跃具名任务中唯一，自动以 `peer-worker` 角色启动并将首条任务说明记为看板消息；`task_status` / `task_wait` / `task_cancel` 与 `task({ jobId })` 均支持直接传 `name` 或 `job_<id>`。
- **保持工具并行度，不标 `executionMode: "sequential"`**：`board_post`、`board_read`、`board_wait` 均保持默认并行模式（避免拖慢同批并行 `read`）；`board_post` 在首个 `await` 前同步完成 `fd 3` FIFO 写入。
- **`board_wait` 三路唤醒**：任一到达即 resolve（不设 `terminate`）：① `seq > since` 的匹配 `@name`/`@all` 消息；② `fd 3` 收到父会话 `steer`；③ `signal` 中止或达到 15m 空闲上限（以 `partial` 收束落盘，后续被 `@name` 或 `task({ jobId })` 自动打开 `.jsonl` 续跑）。
- **去重停滞检测**：当存在未完结的具名协作组，全体具名成员均不在运行、无有限 `bg_bash`/`follow_up` 且无未投递通知时，按 `stall:<boardEpoch>:<maxSeq>` 向根会话发**单次** `[board stall]` 诊断。
- **三档工作区隔离**：`inherit`（默认共享）、`branch`（`git worktree add -b` + 软链 `node_modules`，拦截改写共享软链的包安装命令）、`share`（APFS `cp -cR` / Linux `cp --reflink=auto`，创建时记录工作树状态基线哈希，`task_cancel` 时仅拦截相对基线有新增未提交/未合入改动的目录，除非传 `forceDirty: true`）。

### 3.6 静默优先 `outbox` 与 30 行纯内存 `/approve` 护栏（`outbox-guard.ts`）

- **`outbox({ action: "notify" | "ask", summary, details?, dedupKey? })`**：无人值守 Run 无需汇报时直接静默结束；需通知或提问时调 `outbox`（按 `dedupKey` 硬去重，触发 `host.onOutbox`）。
- **纯内存 `/approve` 护栏**：`host.classifyToolCall` 默认全放行（沿用决策 H3）。返回 `"defer"` 时：Worker 一律硬拒交回父会话；根会话将 `{ id, key: toolName + "\0" + canonicalJson(input) }` 存入根进程内存 `pending` Map 并结束本轮休眠。用户或 `--mode rpc` 宿主通过可信扩展命令 **`/approve <id> [allow|deny]`** 写入内存 `grants` Map（30m 单次有效）并附原始参数唤醒重发。

---

## 4. 模型可见工具契约摘要

1. **`bash({ command, timeout?, waitMsBeforeAsync?, isDaemon?, stdin? })`**：前台默认 `timeout = 120s`；转后台有限任务默认总寿命 `1800s`（上限 `4h`）。
2. **`task({ task, name?, agent?, tasks?, jobId?, strategy?: "steer"|"enqueue"|"interrupt", background?, context?: "fresh"|"fork", forkFrom?: string, workspace?: "inherit"|"branch"|"share", model?, verifyCommand?, maxTurns?, timeoutSeconds? })`**（匿名 Worker 配套 `report_progress`）。
3. **`task_status({ id? })` / `task_wait({ ids, mode?: "all"|"any", timeoutSeconds? })` / `task_cancel({ id, forceDirty? })` / `task_input({ id, input?, end? })`**：按前缀或具名统一路由 `bg_*`、`job_*`（或 `<name>`）、`tm_*`；`task_input` 专管 `bg_*` 的 `stdin`。
4. **`board_post({ text, channel? })`**、**`board_read({ since?, seqs?, limit?, channel? })`**、**`board_wait({ since, mentions_only? })`**。
5. **`timer({ kind: "follow_up"|"schedule", delaySeconds?, cadence?, prompt, sessionMode?: "resume"|"fresh" })`**（Worker Schema 仅含 `follow_up` + `delaySeconds` + `prompt`）。
6. **`outbox({ action: "notify"|"ask", summary, details?, dedupKey? })`**（仅 `root`）与 **`todo`**（Epi 兼容保留）。

---

## 5. Pi `1.4.0` 内核对接硬规则汇总

1. **空闲门禁只用公开事件计数**：监听 `ui_prompt_start` / `ui_prompt_end` 计数，结合 `ctx.isIdle() === true` 与 `session_before_compact` / `session_compact` 标志放行空闲唤醒。
2. **边界草稿保留前置条目**：`turn_end` 与 `agent_before_settle` 返回 `{ entries: [...event.entries, customMessageDraft] }`。
3. **`fork` 缓存预期**：同为 `peer-worker` 的具名同伴间 `forkFrom: "<name>"` 系统提示词与工具集逐字节一致，首轮直中 Token-0 缓存；从 `root` 向 `worker` 做 `context: "fork"` 因工具集裁剪，仅继承干净历史，第 2 轮起命中子会话自身缓存。
4. **放手快捷键不抢 `Ctrl+B`**：避开 `pi-tui` 默认 `cursorLeft`（`keybindings.js:14`），前台放手统一用 **`Alt+B` + `/bg` 命令**。

---

## 6. 分阶段实施与提交路线（关键节点原子提交，配 Herdr 端到端实测）

| 阶段 | 交付与回滚检查点 | 核心验收条件 |
|---|---|---|
| **Stage 0：活体缺陷修复 + 解耦 `epi:monitor`** | 修 `src/tui/transcript.ts` 漏处理 `entry_appended`；`src/extensions/index.ts` 将 `epi:monitor` 从 `buildTaskPair` 独立拆出 | 先红后绿单测验证运行中边界草稿实时上屏，Herdr 终端跑通现有全套单测，独立 commit |
| **Stage 1A：纯搬迁构建 `src/extensions/dispatch/` 骨架** | 抽离现有 `task-*` 迁入 `src/extensions/dispatch/` 并抽出 `DispatchHostAdapter` 接口（保持行为不变） | 现有 `test/task*.test.mjs` 全量通过，独立 commit |
| **Stage 1B：`fd 3` 协议 + 异步 `bash` / Timer / 收件箱 / 护栏** | `pi-worker.ts` 切 `fd 3` 零内部依赖；落地 `bg-bash.ts`、`timers.ts`、`inbox-spool.ts`、`outbox-guard.ts` | 静态扫描 `src/extensions/dispatch/` 零私有 import；单测 + Herdr 真实终端跑原生 `pi -e` 与 `epi -p` 完结排空冒烟，独立 commit |
| **Stage 2：具名 `task` + 共享 `board` + 工作区隔离** | 落地 `board.ts`、`forkFrom` 同伴分支、`branch`/`share` 基线防误删与去重停滞检测 | 单测覆盖 `board_post + board_wait` FIFO、三路唤醒、脏工作区拒删与停滞告警，Herdr 端到端实测，独立 commit |
| **Stage 3：WF6 原型与专用视图收口** | 交付 `scripts/probes/dispatch-tui-prototype.html`；落地 `Alt+B`/`/bg` 与 `/tasks`、`/board` 视图并归档旧文件 | `npm test`、`npm run typecheck`、`model-snapshot.mjs --diff`、`ub-mode` 与 Herdr TUI 冒烟全过 |

---

## 7. 实现备注（2026-11-17，核对 `@earendil-works/pi-coding-agent@1.4.0`）

1. **模块清单**：在 §2.3 基础上包含 `registry.ts`（`bg_*`/`job_*`/`tm_*` 统一路由）、`protocol.ts`（胶囊与 `fd 3` JSONL 通道，双向复用同一 socketpair）、`runtime.ts`（按角色组装全部原语）、`status-tools.ts`、`task-tool.ts` 与 `tui-views.ts`。Epi 薄适配为 `src/extensions/dispatch-epi-host.ts`、`src/extensions/dispatch-epi-ui.ts` 与 `src/dispatch-epi-worker.ts`。
2. **工具渐进暴露与 `bash` 共存**：`board_post`/`board_read`/`board_wait` 在同伴 Worker 内首轮即激活，在根会话默认 `defaultActive: false`，当首次启动具名同伴（或恢复已有白板会话）时自动激活；`outbox` 仅在绑定 `inboxTarget`、`host.onOutbox` 或存在活跃 `schedule` 时自动激活，避免普通交互会话浪费上下文。`bash` 在 `session_start` 时检测若已有外部扩展覆盖 `bash`（如 `minilfs`），自动让出而不报冲突。
3. **`entry_appended` 销账**：Pi 1.4 的 `entry_appended`/`compaction_end` 只是 `AgentSessionEvent`（`session.subscribe`），扩展 API 收不到。账本因此公开 `onEntryAppended(entry)`：Worker 由 `pi-worker.ts` 的 `session.subscribe` 喂入；纯 `pi -e` 根会话靠 `message_end`、边界草稿提交后的 `setImmediate` 分支对账与 `turn_start`/`agent_settled` 分支对账三路兜底。压缩后摘要挂在扩展事件 `session_compact` 上。
4. **`bash` 参数语义**：`timeout` 沿用 Pi 语义＝命令总寿命（到点杀进程组），前台超时报错文案与 Pi 一致；`waitMsBeforeAsync`＝同步窗口（默认 `120000`，上限 `600000`，`isDaemon` 默认 `0`）。转后台的有限命令默认寿命 `1800s`、上限 `14400s`，守护进程默认不限寿命且退出时同样通知一次；被 `task_cancel` 停掉的不再通知。前台按 `Esc` 仍按 Pi 语义杀掉命令。
5. **具名任务**：传 `name` 默认 `background: true`（否则停在 `board_wait` 的同伴会卡住前台调用）；名字须匹配 `^[a-z][a-z0-9-]{0,31}$` 且不得为 `all`/`coordinator`，根会话在看板上的身份为 `@coordinator`，只有点名 `@coordinator` 的消息进根账本。同伴系统提示追加一段看板说明（含启动时 `seq`）。
6. **`board_wait`**：`mentions_only` 默认 `true`。除 §3.5 三路唤醒外，Worker 自己的后台项（`bg_*`/`tm_*`）入账时也会唤醒等待（避免同伴等看板时自身命令结束却无人可见）；空闲上限（默认 15m，`host.boardIdleMs` 可调）到期后本轮以 `partial`（`stoppedBy: "idle"`）收束，之后被 `@name` 点名即按原 `.jsonl` 续跑。
7. **停滞检测**：`stall:<boardEpoch>:<maxSeq>` 中 `boardEpoch` 在每次启动具名任务时递增；检测做 300ms 去抖，且宿主向已停泊的被点名同伴推送消息时立即视其为已唤醒，避免 Worker 回报 `parked:false` 前的竞态误报。
8. **`task_cancel` 工作区门禁**：取消总会停止任务；隔离工作区相对基线（`share`）或相对主检出 `HEAD`（`branch`：未提交改动或未合入提交）有改动时保留目录并在结果里给出 `diffStat` 与 `forceDirty: true` 提示，干净的直接删除（`branch` 同时删分支）。
9. **Stage 3 视图与旧栈归档**：`tui-views.ts` 提供 `<= 14` 列底栏状态、`Alt+B` 条件热键 + `/bg` 前台放手、88% 宽 `Items` / `Board` 双页签浮层与 `.jsonl`/日志实时下钻；`dispatch-epi-ui.ts` 提供 Epi grok 工具行零行折叠渲染、行点击下钻（`CallLine.inspect`）、`TaskMonitorBridge` 联动与 `todo`；`bash-guard.ts` 放行 `isDaemon`/`waitMsBeforeAsync` 异步模式（上限 4h，保留拦截裸 `nohup`/`&` 与交互式 TUI）；旧 `src/{worker,worker-reaper,task-*}.ts` 与 `src/extensions/{task,task-view}.ts` 已移除，旧子代理设计归档至 [`notes/archive-subagents-design.md`](notes/archive-subagents-design.md)。
