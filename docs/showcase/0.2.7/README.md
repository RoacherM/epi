# 0.2.7 特性展示

[← 特性展示](../README.md)

0.2.7 将内置子代理升级为可移植的统一异步调度与多代理协同引擎 `dispatch`（`src/extensions/dispatch/`，决策 DP1）：在不引入独立 Swarm 双轨工具的前提下，用同一套 `bg_*` / `job_*` / `tm_*` 状态与回执账本打通受管异步 `bash`、具名看板同伴、定时自唤醒、非阻塞工作区隔离与 `/tasks`、`/board` 双页签浮层，且整包可脱离 Epi 直接通过 `pi -e dist/extensions/dispatch/index.js` 在外部 Pi 环境加载。

## 1. 可移植 `dispatch` 引擎与受管异步 `bash`

- **公开契约与 `fd 3` 协议管道**：`src/extensions/dispatch/` 仅依赖 Node 内置模块、公开 Pi SDK、`pi-tui` 与 `typebox`；Worker 通过独立 `fd 3` 双向 JSONL 管道与父进程通信，插件或 MCP 往 `stdout` 输出任何日志都不污染协议流；`PI_DISPATCH_DEPTH=1` 与累积式 `PI_DISPATCH_COOKIE` / `PI_DISPATCH_PARENT_PGID_LEDGER` 封死嵌套派生并在收尾时完整收割后台孤儿进程组。
- **受管异步 `bash` 与前台一键放手（`Alt+B` / `/bg`）**：支持 `waitMsBeforeAsync` 同步窗口、`isDaemon` 守护模式与 `task_input` 标准输入写入；前台 `bash`、`task` 或 `task_wait` 等待期间按 `Alt+B`（空闲时不抢编辑器左移词热键）或执行 `/bg` 即可不断连转入后台，结束时经 `NotificationLedger` 自动唤醒，`epi -p` 与 Worker 由 `DrainBarrier` 在收尾前自动等待有限后台项汇报。
- **闹钟、外部收件箱与出口门禁**：`timer` 支持单次持久化 `follow_up`（跨 `/fork` 防重放）与按目标绑定的周期 `schedule`；`inbox-spool` 以 `link()` 原子去重投递外部事件；`task` 支持 `verifyCommand` 出口校验门禁与单次调用 `tools` / `excludeTools` / `systemPrompt` 裁剪。

## 2. 具名同伴与共享看板（`board_post` / `board_read` / `board_wait`）

- **单层同伴直接交接**：`task({ name, task, workspace })` 将子代理作为具名同伴加入当前会话隔离的共享看板，同伴间用 `@name` 直接交接唤醒，无需主会话中转复述；`board_post` 同步入队 `fd 3` 并等待宿主写盘回推序号以保证立即 `board_read` 强一致。
- **分支继承、空闲复活与停滞告警**：支持 `forkFrom: "<name>"` 从同伴闭合历史分支上下文；`board_wait` 空闲满上限以 `partial`（`stoppedBy: "idle"`）收束，后续被 `@name` 点名自动从原会话续跑；当全部存活同伴停泊在看板且无在途工作时，去重触发一次 `[board stall]` 提醒主会话介入。

## 3. 非阻塞异步工作区与双页签交互视图

- **零主线程阻塞的 `branch` / `share` 隔离**：工作区创建、脏检查与清理全部改为异步非阻塞执行，`share` 模式同 `branch` 直接软链 `node_modules` 并跳过 `.dev` 等本地缓存目录，大仓库并发启动也不阻塞终端输入与 `fd 3` 管道；含未提交或未合入改动（含分离 `HEAD` 分支提交）的工作区在取消或同名重开时默认保留防丢数据。
- **`/tasks` 与 `/board` 双页签浮层**：底栏维持 `<= 14` 列紧凑状态计数，`/tasks` 与 `/board` 打开 88% 宽 `Items` / `Board` 双页签浮层，支持键盘 `Tab`/`Enter`/`Esc` 与鼠标点击下钻实时跟随子代理 `.jsonl` 会话和 `bg_*` 输出日志，并对全部渲染路径统一剥离 OSC 52 / CSI / CR / C0 / C1 / bidi 控制序列。
