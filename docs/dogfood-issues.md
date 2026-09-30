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
| D9 | P2 | Pi 0.99 会把图片缩放说明（`[Image: original WxH, displayed at …]`）追加到发给模型的文字里，MMP 的用户消息块把它原样显示出来；用户用"选中即复制"拖选这行后，Ctrl+V 贴出的是这段文字而不是图（用户会话里第二条消息实际没有图片，只有这行字） | 贴一张大于 2000px 的图并发送，看用户消息块 | 已修（合并 e1d545c，决策 T4） |
| D10 | P2 | Pi 0.99 新增的快捷键 MMP 没接：`app.model.cycleForward/Backward`、`tui.altScreen.previousPrompt/nextPrompt`、`tui.altScreen.search` | 对照 Pi 的 `core/keybindings.js` | 待排期 |
| D11 | P2 | 图片编号前后对不上：输入框里的标签按启动以来累加（第二张是 `[Image #2]`），发出去后对话区每条消息各自从 1 数，都显示 `[Image #1]` | 连发两条各带一张图的消息 | 已修（合并 e1d545c，决策 T4） |
| D12 | P2 | 按 Ctrl+T 没有任何反馈：屏幕上没有思考内容时，看起来像按键失灵（用户报告）。Pi 会提示 "Thinking blocks: hidden/visible" | 在一个没有思考块的会话里按 Ctrl+T | 已修（Ctrl+T 在右下角闪 "Thinking: expanded/collapsed"） |
| D13 | P3 | 测试辅助只能看"写到屏幕上的所有输出"，看不到"现在屏幕上显示的是什么"。所以"某行本该消失却一直留着"这类 bug（比如中止后队列提示不消失）没有测试能抓到（D2 复审发现，A4–A6、C1 四个改坏场景） | D2 的 review-2.md 第 2 条 | 待排期：给 tui-harness 加一个读取当前屏幕内容的步骤 |
| D14 | P3 | D2 的 worker（旧工具版 b0d88c4，跑了约 1.5 小时）空输入框按 Ctrl+D 等 15 秒没退出，输入 `/quit` 4 秒内退出。没有点过图片标签。同样旧版本的 reviewer 上 Ctrl+D 1 秒退出，没复现 | 长时间运行的会话里按 Ctrl+D | 待复现（在新版本上留意） |
| D15 | P0 | 上下文超长的自动恢复失败后，界面永远停在 "Compacting…"（实测 76 分钟），Esc 也停不下来。原因：Pi 在回合结束后的收尾阶段做恢复压缩，`compaction_end` 到达时 `isStreaming` 仍为 true，MMP 不清状态；之后的 `agent_settled` 也不清 | D11 worker 会话（magpie，约 176K token 时报 "Prompt is too long"） | 已修（合并 D15；另外修了两个同根的变体：回合结束后压缩成功也会卡住，回合中途压缩结束后状态不更新） |
| D16 | P1 | magpie 的上下文上限配错：MMP 的 magpie 扩展照抄了 magpie 给 Pi 的 100 万，实际约 20 万，所以 Pi 从不自动压缩，直接撞上 "Prompt is too long"；恢复时的摘要请求又被 magpie 以 `content_filter` 拒绝 | 长任务里看上下文用量 | 已修（`~/.mmp/extensions/magpie/index.mjs` 改为 200000）；`content_filter` 的原因待查 |
| D17 | P3 | D15 复审发现：自动重试的等待期间按 Esc，曾是另一个状态卡住的变体（已被 D15 的修复覆盖），但没有测试；D15 新增的两处清理（回合结束时、重试结束时）也没有单独的测试 | D15 的 review-1.md 第 1、2 条 | 待补测试 |
| D18 | P2 | 用退格删掉一个图片标签后立刻按回车，弹出的是路径补全（如 `see foo home/`），消息没有发出去；先随便打一个字再回车就正常（D11 worker 发现，D11 之前就存在） | `see foo `，Ctrl+V，退格，回车 | 待修 |
| D19 | P2 | 完整测试又变回约 5 分钟：D11 新增的 `test/tui-image-numbering.test.mjs` 里二十多个测试每个 17–24 秒，同一文件内串行执行，整个文件就要几分钟，抵消了 D2 的提速 | `node --test --test-reporter=tap test/*.test.mjs`，按耗时排序 | 待修：拆成多个文件，或加快假模型的输出速度 |
| D20 | P3 | D11 复审提出的小问题：同一条草稿里出现两次同一个标签会把图片发两次；`/fork` 一条没有标签的图片消息会丢图（D11 之前就有）；`/tree` 恢复图片没有测试 | D11 的 review-3.md | 待排期 |
| D21 | P2 | `/settings` 还没做（tui-design 第 7 节 P2 唯一剩下的命令）。Pi 的设置项里有些只对 Pi 自己的界面有意义，要先挑出适用于 MMP 的 | 输入 `/settings` | 待做（从旧待办迁来） |
| D22 | P3 | 展开后的思考内容里 markdown 没有渲染（`**标题**` 原样显示），缩进也和正文不一致（M4 Herdr 实测） | 用会输出思考的模型问一个问题，Ctrl+T 展开 | 待修（从旧待办迁来） |
| D23 | P3 | 回答进行中排队的追问，和原来的问题共用一行 `Worked for`；grok 是每轮各显示一行（M4 Fable 审查） | 运行中输入一句按 Enter 排队，等两轮都结束 | 待修（从旧待办迁来） |
| D24 | P3 | 思考结束时没有闪烁提示（grok 有；M4 Fable 审查） | 看一次思考结束 | 待修（从旧待办迁来） |
| D25 | P3 | 在 Herdr 里退出 mmp 后，pane 里留着退出前的最后一帧画面（Ghostty 里是否也有未确认） | Herdr pane 里启动再 Ctrl+D | 待查（从旧待办迁来；可能是 Herdr 对备用屏幕的处理） |
| D26 | P3 | `mmp:hooks` 的 `user_prompt` 钩子拦下一轮时，界面上可能看不到拦截原因（旧待办的简记，细节没留下；钩子启动失败的情况已按"失败要可见"修过） | 写一个返回 block 的 `user_prompt` 钩子，发一句话 | 待复现 |
