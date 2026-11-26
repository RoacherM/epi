# 0.2.8 特性展示

[← 特性展示](../README.md)

0.2.8 修复无头模式（`epi -p`、`--mode json` 与 `pi -p -e dist/extensions/dispatch/index.js`）在正常退出时终止 `bash({ isDaemon: true })` 常驻后台服务的问题（`#16`），打通单次命令行调用启动常驻 HTTP/gRPC 服务后跨进程存活、防断管 `SIGPIPE` 日志写入、跨次启动对账豁免与会话恢复管控的完整闭环。

本版本没有改变主界面布局，不附新录屏。

## 1. 无头根会话守护进程跨退出保活与防 `SIGPIPE`（#16）

- **文件描述符直连防 `SIGPIPE` / `EPIPE`**：`isDaemon: true` 守护命令在 `spawn` 时直接将 `stdout` 与 `stderr` 绑定到 `<stateDir>/bg/<id>.log` 文件描述符（`O_APPEND`，父进程立即关闭自身副本，`task_status` 与 `/tasks` 按偏移仅读文件尾部 `64 KiB`），消除宿主退出关闭管道后服务在下次写访问日志时因 `SIGPIPE`/`EPIPE` 崩溃的问题；非守护命令（`!isDaemon`）保持原有管道与 `20 MiB` 落盘封顶排空语义。
- **无头正常退出解绑与零事件循环挂起**：根会话在 `print` / `json` 模式下正常 `session_shutdown({ reason: "quit" })`（且未触发 `SIGINT`/`SIGTERM`/`SIGHUP` 信号强退）时，对运行中的 `isDaemon: true` 作业执行 `detachDaemons()`——写入 `detached: true, notified: true`、关闭父侧 `stdin` 管道、清理监听器并调用 `child.unref()`，使 `epi -p` 与原生 `pi -p` 均立即退出且保留后台服务存活。
- **跨次启动 `reconcile` 豁免与严格作用域边界**：后续同 `EPI_HOME` 启动的会话在 `reconcile()` 中识别存活的 `detached: true` 记录并跳过 `reapOrphans()` 孤儿进程组清扫；使用 `--continue` / `--session` 恢复原会话时仍可通过 `task_status` 查看退出后新增日志，或通过 `task_cancel` 显式终止该服务（含 `KILL_GRACE_MS` 退避与 `SIGKILL` 兜底）。交互式 TUI、RPC、Worker 子代理退出、信号中断与宿主异常崩溃残留仍照常完整终止并回收进程树。
