# 0.2.5 特性展示

[← 特性展示](../README.md)

0.2.5 为内置 `epi:task` 带来异步子代理中段即时通知、运行中纠偏策略、Git Worktree 隔离与内置 `Monitor` 流式后台监控工具，同时修复了微信粘贴图片 `EPERM` 崩溃并同步了 Magpie Antigravity Gemini 轨迹规范化。

本版本没有改变主界面布局，不附新录屏。

## 1. 异步子代理（`epi:task`）升级

- **运行中即时消费后台通知**：当主控正在执行工具循环时，后台子代理完成或发送里程碑（`report_progress({ summary, notifyParent: true })`）会在 `turn_end`（有工具结果时）与 `agent_before_settle` 即时通过 `steer` 注入当前轮，并在分支上按 `${jobId}:${run}` 记录回执避免后续 `task_wait` 重复投递。
- **三种运行中纠偏策略**：`task({ jobId, task, strategy })` 与 `agents/*.md` frontmatter `updateStrategy` 支持 `"steer"`（当前工具结束后注入）、`"enqueue"`（当前轮结束后排队跟进）、`"interrupt"`（立即中止当前轮并重跑）。
- **Git Worktree 隔离（`isolation: "worktree"`）**：子代理在 `<EPI_HOME>/runtime/tasks/<id>/worktree` 的独立分离头工作树中运行，保留子目录相对 `cwd`；结束时未改动自动清理，有改动则保留工作树并汇报 `worktreePath` 与 `diffStat`。
- **批量并行控制**：支持 `task({ tasks: [...] })`、`task_wait({ jobIds, mode: "all" | "any" })`、`task_cancel({ jobIds, all: true })` 及 `agents/*.md` frontmatter `background`/`async`、`isolation`、`updateStrategy`。

## 2. 内置流式后台监控（`Monitor` / `monitor_stop` / `monitor_list`）

- 随 `epi:task` 内置提供 `Monitor`（支持后台 `command` 标准输出行流与 `ws` WebSocket 帧流）、`monitor_stop`、`monitor_list`。
- 200ms 窗口批量聚合（单行 500 字符、单批 3000 字符、尾部缓冲上限 1 MiB）与令牌桶限流（突发 10、每 2s 恢复 1、连续抑制 30s 自动熔断）。
- 非 Windows 下以独立进程组启动并在停止/退出时通过 `killTree(-pid)` 清理整棵进程树，日志落盘至 `<EPI_HOME>/runtime/monitors/<id>.{out,err}.log`。

## 3. 微信复制图片粘贴 `EPERM` 修复与 Magpie Gemini 轨迹规范化

- **微信粘贴图片 `EPERM` 回退**：粘贴微信沙盒容器下不可读的图片路径时捕获 `EPERM`/`EACCES`，自动回退读取系统剪贴板中的图片位图并生成 `[Image #N]` chip，不再崩溃退出。
- **Magpie Antigravity Gemini 轨迹规范化**：保留 Antigravity 自有 `thoughtSignature`，空白文本分片携带有效签名时自动转移至同轮 `functionCall`，剔除空回合并合并连续同角色回合（`functionResponse` 置前）。
