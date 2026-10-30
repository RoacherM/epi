# 0.2.3 特性展示

[← 特性展示](../README.md)

0.2.3 只有一个主题：**子代理不再把主会话按在那里等**。设计见 [subagents-design.md](../../subagents-design.md) §13，决策 D96。

本版本**没有新增界面元素**，所以没有录屏：变化发生在时间里，不在画面上。原来一次前台 `task` 调用，主会话会一直停在那一行工具调用上，直到子代理跑完——工具批不返回，模型就不会发下一次请求，唯一的边界是子代理自己的 600 秒超时。现在它最多停 5 分钟。

## 到达预算时模型看到什么

子代理仍在跑，调用行换成一张回执（走的是现有的工具结果块，没有新组件）：

```text
Job 3f9a2c81-… is running and keeps running in the background (it did not finish within 300s).
Its answer arrives as a new message that starts a turn, so do not restart this work: go on with
something that does not need it, or end the turn. Call task_wait only if you cannot continue
without it; task_cancel stops it.
```

子代理落定时，那条答案照常作为 `epi:task-notify` 送回来，并自己开一轮。

## 三条边界

- **只在交互 TUI 放手**：`epi -p`、`--mode json`、`--mode rpc` 仍然等到落定。它们的进程可能在子代理落定前就结束，放手等于把结果连着子代理一起丢掉。
- **`task_wait` 同一预算**：不设上限的话，模型转后台后顺手一次 `task_wait`，阻塞又变无界。到点返回的是几行进度，不是整份快照 JSON。
- **Esc 与预算的区别只有一处**：Esc 是用户说「停」，结果只搭下一条用户提问；预算是模型想要答案，落定时自己开一轮。

## 顺带修掉的两处

- 唤醒以前可能重复投递：会话正在跑时通知排进 Pi 的 follow-up 队列，之后 `task_wait` 收走同一份结果也撤不回它。现在只往空闲会话发，忙时留到这一轮结束再冲。
- `task_stop` hook 返回 `block`/`cancel`（对该事件不合法）时，后台作业的结果不再只写进 stderr。
