# mmp 使用中发现的问题

用 mmp 干活（包括开发 mmp 自己）时看到的问题记在这里，按 [dev-workflow-herdr.md](dev-workflow-herdr.md) 第 6 节分级修复。

| 编号 | 级别 | 现象 | 复现 | 状态 |
|---|---|---|---|---|
| D1 | P3 | 扩展用 `pi.registerProvider` 注册模型时漏写 `cost`，发请求时只报 `Cannot read properties of undefined (reading 'tiers')`，看不出是哪个扩展、哪个模型、缺哪个字段 | 在 `~/.mmp/extensions/` 写一个不带 `cost` 的 provider 扩展，`mmp --provider <它> -p hi </dev/null` | 待修（可在注册时校验并指出扩展和字段；需要先看 Pi 0.99 是否已改） |
| D2 | P2 | 完整测试要约 3 分钟，拖慢每个开发任务。最慢的是界面测试（每个 10–14 秒，例如 Esc 放回排队消息 14.3 秒、`/login` 流程 13.9 秒），推测大多在等固定延时或超时，而不是等界面状态出现 | `node --test --test-reporter=tap test/*.test.mjs`，按每个测试的 `duration_ms` 排序 | 待修：计划作为 mmp 自己开发的第一个试跑任务 |
