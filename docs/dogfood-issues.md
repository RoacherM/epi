# mmp 使用中发现的问题

用 mmp 干活（包括开发 mmp 自己）时看到的问题记在这里，按 [dev-workflow-herdr.md](dev-workflow-herdr.md) 第 6 节分级修复。

| 编号 | 级别 | 现象 | 复现 | 状态 |
|---|---|---|---|---|
| D1 | P3 | 扩展用 `pi.registerProvider` 注册模型时漏写 `cost`，发请求时只报 `Cannot read properties of undefined (reading 'tiers')`，看不出是哪个扩展、哪个模型、缺哪个字段 | 在 `~/.mmp/extensions/` 写一个不带 `cost` 的 provider 扩展，`mmp --provider <它> -p hi </dev/null` | 待修（可在注册时校验并指出扩展和字段；需要先看 Pi 0.99 是否已改） |
| D2 | P2 | 完整测试要约 3 分钟，拖慢每个开发任务。最慢的是界面测试（每个 10–14 秒，例如 Esc 放回排队消息 14.3 秒、`/login` 流程 13.9 秒），推测大多在等固定延时或超时，而不是等界面状态出现 | `node --test --test-reporter=tap test/*.test.mjs`，按每个测试的 `duration_ms` 排序 | 已修（合并 D2：完整测试 3 分钟 → 约 44 秒） |
| D3 | P2 | `-p` 时有一个 MCP 服务卡在连接（不回 `initialize`），第一条消息 10 秒后照常发出，但进程要等到那个服务的请求超时（默认 60 秒）才退出；等进程退出的 benchmark 会多等这么久。Pi 自己也一样（连接中的请求 `close()` 取消不了） | 测试夹具 `MMP_FIXTURE_HANG_INITIALIZE=1`，`mmp -p hi </dev/null` 计时 | 待定：MMP 在 print/json 结束后主动退出进程，或推动 Pi 修 |
| D4 | P3 | `mmp mcp list` 不支持 `--approve`（`mmp install -l` 支持），不信任的项目只能先 `/trust`；空配置提示 "Add them to … then run `mmp mcp add`" 语序别扭 | 在不信任的项目里 `mmp mcp list --approve` → Unknown option | 待修 |
| D5 | P2 | 用 magpie 的 sonnet-5.5、thinking `high` 时，大多数回答没有思考块，有的显示 "Thought for 0.0s"，内容只有一行摘要。直接调 magpie 接口（`reasoning_effort: "high"`）返回的 `reasoning_tokens` 也是 0，所以更可能是 magpie 没把思考设置传给 Claude，不是 MMP 的问题。连带影响：Ctrl+T 没有可切换的内容，看起来像失灵 | `curl` magpie 的 `/v1/chat/completions` 带 `reasoning_effort`，看 `usage.completion_tokens_details.reasoning_tokens` | 待查（magpie 侧）；Ctrl+T 已加提示（D12） |
| D6 | P3 | Pi 的 MCP 运行时本身加载失败时，`-p` / json 模式下 MMP 会把每个服务报成 "still connecting"，Pi 的 "MCP failed to load" 被吞掉（一个失败被报成另一个） | 需要让 Pi 的 MCP 模块加载失败，未复现 | 待修 |
| D7 | P1 | 在 Ghostty（以及 kitty、WezTerm 这类支持 kitty 键盘协议的终端）里，每个快捷键都会触发两次：Ctrl+V 贴出两张图；Ctrl+T、Ctrl+O 这类开关按了等于没按；Shift+Tab 一次跳两档。原因：终端会额外发送"按键松开"事件，MMP 的快捷键处理没有把它过滤掉 | Herdr 里 `send-text $'\e[118;5u'` 再 `send-text $'\e[118;5:3u'` | 已修（18b8ad6，工具版已升级） |
| D8 | P1 | 点一下输入框里的图片标签（看预览）之后，所有快捷键都失效：Ctrl+V 贴不了图、Shift+Tab、Esc、Ctrl+D 都没反应，只有打字还能用。原因：点击后 pi-tui 把焦点交给了包着输入框的 PromptFrame（它会把打字转给输入框），而 MMP 的快捷键只认输入框本身 | 贴一张图，鼠标点一下 `[Image #1]`，再按 Ctrl+V | 已修（见下一提交，工具版已升级） |
| D9 | P2 | Pi 0.99 会把图片缩放说明（`[Image: original WxH, displayed at …]`）追加到发给模型的文字里，MMP 的用户消息块把它原样显示出来；用户用"选中即复制"拖选这行后，Ctrl+V 贴出的是这段文字而不是图（用户会话里第二条消息实际没有图片，只有这行字） | 贴一张大于 2000px 的图并发送，看用户消息块 | 待定：界面隐藏缩放和格式转换说明（"Image omitted" 这类失败说明保留），模型照常收到 |
| D10 | P2 | Pi 0.99 新增的快捷键 MMP 没接：`app.model.cycleForward/Backward`、`tui.altScreen.previousPrompt/nextPrompt`、`tui.altScreen.search` | 对照 Pi 的 `core/keybindings.js` | 待排期 |
| D11 | P2 | 图片编号前后对不上：输入框里的标签按启动以来累加（第二张是 `[Image #2]`），发出去后对话区每条消息各自从 1 数，都显示 `[Image #1]` | 连发两条各带一张图的消息 | 修复中（任务 D11：整个会话统一编号，`/resume` 接着编，`/new` 从 1 开始） |
| D12 | P2 | 按 Ctrl+T 没有任何反馈：屏幕上没有思考内容时，看起来像按键失灵（用户报告）。Pi 会提示 "Thinking blocks: hidden/visible" | 在一个没有思考块的会话里按 Ctrl+T | 已修（Ctrl+T 在右下角闪 "Thinking: expanded/collapsed"） |
| D13 | P3 | 测试辅助只能看"写到屏幕上的所有输出"，看不到"现在屏幕上显示的是什么"。所以"某行本该消失却一直留着"这类 bug（比如中止后队列提示不消失）没有测试能抓到（D2 复审发现，A4–A6、C1 四个改坏场景） | D2 的 review-2.md 第 2 条 | 待排期：给 tui-harness 加一个读取当前屏幕内容的步骤 |
