# mmp 使用中发现的问题

用 mmp 干活（包括开发 mmp 自己）时看到的问题记在这里，按 [dev-workflow-herdr.md](dev-workflow-herdr.md) 第 6 节分级修复。

| 编号 | 级别 | 现象 | 复现 | 状态 |
|---|---|---|---|---|
| D1 | P3 | 扩展用 `pi.registerProvider` 注册模型时漏写 `cost`，发请求时只报 `Cannot read properties of undefined (reading 'tiers')`，看不出是哪个扩展、哪个模型、缺哪个字段 | 在 `~/.mmp/extensions/` 写一个不带 `cost` 的 provider 扩展，`mmp --provider <它> -p hi </dev/null` | 待修（可在注册时校验并指出扩展和字段；需要先看 Pi 0.99 是否已改） |
| D2 | P2 | 完整测试要约 3 分钟，拖慢每个开发任务。最慢的是界面测试（每个 10–14 秒，例如 Esc 放回排队消息 14.3 秒、`/login` 流程 13.9 秒），推测大多在等固定延时或超时，而不是等界面状态出现 | `node --test --test-reporter=tap test/*.test.mjs`，按每个测试的 `duration_ms` 排序 | 待修：计划作为 mmp 自己开发的第一个试跑任务 |
| D3 | P2 | `-p` 时有一个 MCP 服务卡在连接（不回 `initialize`），第一条消息 10 秒后照常发出，但进程要等到那个服务的请求超时（默认 60 秒）才退出；等进程退出的 benchmark 会多等这么久。Pi 自己也一样（连接中的请求 `close()` 取消不了） | 测试夹具 `MMP_FIXTURE_HANG_INITIALIZE=1`，`mmp -p hi </dev/null` 计时 | 待定：MMP 在 print/json 结束后主动退出进程，或推动 Pi 修 |
| D4 | P3 | `mmp mcp list` 不支持 `--approve`（`mmp install -l` 支持），不信任的项目只能先 `/trust`；空配置提示 "Add them to … then run `mmp mcp add`" 语序别扭 | 在不信任的项目里 `mmp mcp list --approve` → Unknown option | 待修 |
| D5 | P2 | 用 magpie 的 sonnet-5.5、thinking `high` 时，界面显示 "Thought for 0.0s"，看起来并没有真的开思考（magpie 走 openai-completions，reasoning 参数可能没传到 Claude） | Herdr 里 `mmp --provider magpie --model claude/claude-sonnet-5-5 --thinking high`，随便问一个要推理的问题 | 待查：先确认请求里有没有 reasoning 参数 |
| D6 | P3 | Pi 的 MCP 运行时本身加载失败时，`-p` / json 模式下 MMP 会把每个服务报成 "still connecting"，Pi 的 "MCP failed to load" 被吞掉（一个失败被报成另一个） | 需要让 Pi 的 MCP 模块加载失败，未复现 | 待修 |
| D7 | P1 | 在 Ghostty（以及 kitty、WezTerm 这类支持 kitty 键盘协议的终端）里，每个快捷键都会触发两次：Ctrl+V 贴出两张图；Ctrl+T、Ctrl+O 这类开关按了等于没按；Shift+Tab 一次跳两档。原因：终端会额外发送"按键松开"事件，MMP 的快捷键处理没有把它过滤掉 | Herdr 里 `send-text $'\e[118;5u'` 再 `send-text $'\e[118;5:3u'` | 已修（18b8ad6，工具版已升级） |
| D8 | P2 | 用户报告：发出带图片的消息后，下一条消息里就粘贴不了了。在 Herdr 里用测试剪贴板文件没能复现，模拟按下/松开事件也没有复现 | 待用户在 D7 修好的版本上重试，并说明当时按的键和剪贴板里的内容 | 待复现 |
