# 0.2.0 特性展示

[← 特性展示](../README.md)

0.2.0 的主题是**子代理的可靠交付**:`epi:task` 从"发出去就忘"变成"发出去有回执"。设计与实现见 [subagents-design.md](../../subagents-design.md) §11。

本版本主要界面变化:

- **底栏 `epi-task` 微提示**:右下角常驻一行 `◐ 2 tasks` / `◐ 2+1 tasks` / `✓ 1 done` / `✗ 1 failed`,运行中、排队、未收取的结果各算各的,零定时器、纯事件驱动,`/new`、`/reload` 之后自动重刷。
- **任务调用单行化**:`task`/`task_status`/`task_wait`/`task_cancel` 的调用行只有一条 `◆ task worker "refactor…"`(后台带 `bg` 尾注、`steer`/`resume` 带 8 位短 ID);运行中同行尾部实时刷 `turn 2 · bash: npm test`,成功后折叠占 0 行,失败一行 `✗`。
- **后台唤醒消息**:子代理结束推送的 `epi:task-notify` 渲染为每任务一行 `✓ task abcdef12 · summary`,不再是裸 custom 块。

## 文件

| 文件 | 用途 |
|---|---|
| (待补) `turn.mp4` / `turn.gif` | 一轮对话:后台子代理落定 → 底栏 `✓ 1 done` → 通知送达 |
| (待补) `notify.png` | `epi:task-notify` 渲染效果 |

> 录屏由 `node scripts/docs/capture-showcase.mjs 0.2.0` 生成;场景脚本 `scripts/docs/showcase/0.2.0.mjs` 待补。
