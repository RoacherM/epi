# 参照 grok-build 重构 Pi TUI：调研与路线

日期：2026-09-29。只做了调研，没改代码。

调研对象：
- xai-org/grok-build，commit `f0e3be1`（2026-09-23）
- Pi `v0.83.0`（MMP 当前锁定的版本）
- 上游 main `cb7969d`（0.87.1，2026-09-28）

方法：两路并行，都只读源码、官方文档和 CHANGELOG。每条结论的出处都在两份原始笔记里：

- [notes/research-grok-build-tui.md](notes/research-grok-build-tui.md)：grok-build 的技术栈、布局、视觉语言、交互、组件架构
- [notes/research-pi-tui.md](notes/research-pi-tui.md)：pi-tui 的渲染模型、InteractiveMode 结构、扩展 UI 接口、下沉路径、0.83 到 0.87 的变化、社区方案

本文只写结论和取舍。标"推断"的是我的判断，不是来源里的原话。

## 1. 结论

> 2026-09-29 更新：第 3 条的路线建议已被推翻。你决定走路线 C，即保留 Pi 的 SDK、自己写交互层，设计见 [tui-design.md](tui-design.md) v2。下面第 1、2、4 条的事实仍然成立。

1. **grok 的"好看"主要来自排版和状态表达的规则，和它用 Rust/ratatui 无关。** 第 4 节列出的 20 条设计点里，11 条能直接用 Pi 扩展的公开接口做，另有 3 条要实测。
2. **不改 Pi 内核能改到哪里**：Pi 扩展能改 header、footer、输入框、输入框上下方的 widget、工具卡片、主题配色，以及占住输入框位置的卡片。用户消息和助手消息的外框、thinking 块、布局顺序、内置选择器都改不了。
3. **建议走"扩展皮肤"路线（下文路线 A）**，做成 MMP 内置的 `mmp:ui` Extension，规模参考社区的 pi-grok-tui（997 行 TS）。不要复制 InteractiveMode（6,058 行，还在增长），也不要换 Ink 或 ratatui 重写，否则所有第三方扩展的 UI 都会失效，包括 MMP 内嵌的 MCP 面板。
4. **先决条件是 Pi 升级到 0.84 以上。** 从 0.84 起有全屏模式、布局组件和 `registerMarkdownTransformer`，社区的外框类扩展也都要求 0.84 以上。扩展 UI 接口在 0.83 到 0.87.1 之间逐字没变，所以路线 A 的升级成本低。这件事要你拍板（第 6 节）。

## 2. 两边的模型差异

| | grok-build | Pi 0.83 | Pi 0.84+ |
|---|---|---|---|
| 语言 / 框架 | Rust、ratatui 0.29、crossterm | TypeScript、pi-tui | 同左 |
| 组件接口 | `render(area: Rect, buf)` 写入 cell 缓冲区，可以画到任意坐标 | `render(width): string[]` 只输出行，没有高度和横向布局 | 同左，另有 `VStack`、`HStack`、`ScrollView` |
| 屏幕模式 | Fullscreen（默认）/ Inline / Minimal | 只有 inline | inline，或 `--tui-mode fullscreen` |
| 聊天历史归谁管 | 全屏时应用自己管（虚拟滚动、折叠、选中、吸顶） | 终端的 scrollback | 全屏时由 ScrollView 管 |
| 状态管理 | Elm 风格：Action → dispatch → Effect | InteractiveMode 单类里用一个大 switch 映射事件 | 同左 |
| 扩展 UI | 没有第三方 UI 扩展面 | `ctx.ui.*`，组件就是 pi-tui 的 Component | 接口不变 |

grok 自己的 **Minimal 模式**就是 xAI 在 inline 约束下做的取舍：定稿的消息块写进终端的 scrollback 以后不再改，底部只留一块差分重绘的活动区。它和 Pi 的 inline 模式最接近，是移植时最好的对照（原始笔记 grok 1.1 节，源码在 `crates/codegen/xai-grok-pager-minimal/`）。

## 3. 目标样子

下图按 grok 截图和布局代码还原，括号里是 Pi 里负责这一块的位置。

```
  ░ ❯ explain the universe                            8:19 AM ░   用户消息：整块底色，没有边框   (UserMessageComponent，改不了*)
     ◆ Thought for 2.0s                                           thinking 结束后折叠成一行     (只能改占位文字*)
     The Universe, briefly                                        助手 markdown：去掉 # 和 **   (registerMarkdownTransformer，0.84+)
     • Vast — about 93 billion light-years ...
  ┃  ◆ Run cargo test                                             运行中工具：紫色 ┃ 竖条        (registerTool 覆盖渲染 ✓)
  ┃    … +120 lines
     ◆ Read 2 files, Searched 1 pattern                           连续只读工具合并成一行        (需验证，见 4 节 #6)
  ⠧ Responding… 15s                           17s ⇣9.45k [stop]   运行状态行，只在工作时出现    (setWorkingIndicator/Message ✓)
  ╭────────────────────────────────────────────────────────────╮
  │ ❯ █                                                        │  圆角输入框                    (setEditorComponent ✓)
  ╰──────────────────────── Grok 4.5 (high) · always-approve ─╯  模型、思考档位、模式写在底边
  ~/proj  main │ 9.5K / 500K     Shift+Tab:mode │ Ctrl+c:cancel   路径、上下文、快捷键合在一行  (setFooter ✓)
```

`*` 表示公开接口做不到，见第 5 节。

grok 的顶部状态栏（cwd、上下文占用）在 Pi 里没法固定：header 在 inline 模式下会滚走，全屏模式下也放在会滚动的 `documentContainer` 里。所以把这些信息并进底部的 footer。

## 4. grok 设计点逐条映射到 Pi

路线说明：
- **A**：公开扩展接口能做。
- **A\***：公开接口能做，但写法绕，要实测。
- **P**：只能 patch Pi 内部组件的 prototype。
- **✗**：inline 模型下做不到，要等全屏模式或自研 TUI。

| # | grok 设计点 | Pi 里的实现位置 | 路线 |
|---|---|---|---|
| 1 | 行栈布局：可选行为空时连同间隔一起消失，矮屏逐级去掉装饰 | 输入框上下方的 widget、working 行都可以输出 0 行；按 `process.stdout.rows` 裁剪 | A |
| 2 | 输入框元信息写在边框上（模型、effort、权限模式、`Stashed`、plan 模式边框变色） | `setEditorComponent`，继承 `CustomEditor`，重写边框行。0.85 起 working 指示器也嵌进编辑器边框，要设 `embedWorkingStatus` | A |
| 3 | 运行状态行 `⠧ 活动… 阶段耗时 ⋯ 总耗时 ⇣tokens` | `setWorkingIndicator`（帧）+ `setWorkingMessage`（文字），数据来自 `tool_execution_*`、`message_update` 事件。位置固定在输入框正上方，和 grok 一致 | A |
| 4 | 阻塞卡片占住输入框位置：竖条加底色、数字键直选、拒绝时可以直接打字写理由、Esc 只让出焦点不算拒绝 | `ctx.ui.custom(factory)` 不加 overlay 时，正好渲染在编辑器的位置。但 MMP 目前没有自己的确认对话框（项目信任走 `--approve`，Hooks 只调用 `notify`），MCP adapter 的 `ui.select` 用的是 Pi 内置样式，改不了；所以 v1 没有使用方 | A |
| 5 | 工具块三态（折叠 / 截断 / 展开），默认状态按工具类型定：bash 折叠，Read 显示头 5 行尾 3 行 | `registerTool` 用同名覆盖 7 个内置工具，只替换 `renderCall`/`renderResult`，读 `expanded` 标志；`renderShell: "self"` 去掉默认外框 | A |
| 6 | 动词分组：连续只读调用合并成 `Read 2 files, Searched 1 pattern` | 每个工具卡片单独渲染，没有合并的钩子。可能的做法：用共享状态，让组内第一张卡片显示汇总、后面的卡片输出 0 行。Pi 每帧都重新 render，所以这样可行，但要实测 | A\* |
| 7 | 用竖条和 bullet 的颜色表示状态：运行中紫色、完成绿色、失败红色 | 在工具渲染器里按状态上色。grok 的波浪动画和完成闪烁要不断触发重绘，建议不做 | A（只做静态颜色） |
| 8 | markdown 去标记：隐藏 `#`、`**`；`-` 变 `•`，`---` 变 `───` | 0.84 新增的 `registerMarkdownTransformer(md, {messageType, isStreaming, availableWidth}) => md` 只能改 markdown 文本，不能改外框。标题颜色可以用主题 token `mdHeading` 等设置。Pi 0.83 只在 H3 及以下显示 `#` 前缀（`packages/tui/src/components/markdown.ts:338-356`） | A\*（需 0.84+） |
| 9 | 流式 markdown 分段冻结，只重渲最后一段 | Pi 内部的性能问题，只和自研 TUI 有关 | 不适用 |
| 10 | diff 不用 `+`/`-` 列，只靠行底色和彩色行号；hunk 之间显示 `… N unchanged lines` | 覆盖 edit 工具的 `renderResult`；Pi 导出了 `renderDiff` 可以参考 | A |
| 11 | 一张快捷键表同时驱动按键、底部提示和命令面板 | 对 MMP 自己的 `registerShortcut`/`registerCommand` 能做到。Pi 内置按键可以通过 `keyHint` 读出来显示 | A（限 MMP 自己的按键） |
| 12 | 语义主题 token + 色深降级 + 字形的 ASCII 回退 | `ctx.ui.setTheme(Theme)` 传入 groknight 配色（色值在原始笔记 grok 3.1 节）。token 集合固定，不能新增。字形回退由 MMP 自己实现 | A |
| 13 | 同步输出包帧、resize 去抖、渲染合批 | pi-tui 已经做了：DEC 2026 同步输出、16ms 合批 | 已有 |
| 14 | 运行中按 Enter 排队，可以插话 | Pi 已有 steer / follow-up 排队（`pendingMessagesContainer`），样式改不了 | 已有 |
| 15 | 用户消息块：整块底色、`❯` 前缀、时间戳，滚动时吸顶 | 底色可以用主题 token `userMessageBg`；`❯` 前缀和时间戳要 patch `UserMessageComponent`；吸顶做不到 | 底色 A；其余 P / ✗ |
| 16 | thinking 结束后折叠成 `◆ Thought for 2.0s` | 只有 `setHiddenThinkingLabel` 能改隐藏时的占位文字；要按耗时折叠得 patch `AssistantMessageComponent` | P |
| 17 | 终端集成：tab 标题带 spinner、`⚠ Action Required`；OSC 9;4 进度条 | `ctx.ui.setTitle`；OSC 9;4 要直接往 stdout 写转义序列，会不会和 pi-tui 冲突需要实测 | A / A\* |
| 18 | 欢迎页：logo 加菜单，宽屏时左右并排 | MMP 已经用 `setHeader` 做了启动页（`src/startup-page.ts`），可以按 grok 的样子重排。下面 Pi 自己的 loadedResources 列表去不掉 | A |
| 19 | 全屏 scrollback：事后折叠或展开任意历史块、逐块选中、鼠标点击、`▲`/`▼` 跳转 | 0.83 做不到。0.84 全屏模式下聊天在 ScrollView 里；pi-cc-extensions 在全屏模式上做了点击展开，但用的是 patch。扩展能不能拿到 ScrollView 没有验证 | ✗ / P |
| 20 | 浮层下拉和弹窗 | pi-tui 有 overlay（`showOverlay`）；扩展用 `custom(..., {overlay: true})`，文档标为 Experimental | A |

统计：共 20 条。A 类 11 条；A\* 类 3 条（#6、#8、#17）；#15 只能做一部分；Pi 已有 2 条（#13、#14）；P / ✗ 类 2 条（#16、#19）；不适用 1 条（#9）。

## 5. 做不到的部分怎么办

| 想要的效果 | 办法 | 代价 |
|---|---|---|
| 用户消息的 `❯` 前缀和时间戳、thinking 折叠 | patch `UserMessageComponent`、`AssistantMessageComponent` 的 prototype。pi-zentui、pi-cc-extensions 都这么做 | 每次升级 Pi 都要回归测试。0.84 起部分内部引用变成惰性 Proxy，"先保存原方法再包一层"的写法会无限递归（pi-cc-extensions 的注释和 `tests/lazy-proxy-regression.test.ts`）。这也违反 MMP"不碰 Pi 内部"的原则 |
| 全屏式历史交互（折叠历史、吸顶、鼠标） | 先试 Pi 0.84+ 的全屏模式能到哪一步；不够再走路线 C | 路线 C 要新增 3,000–6,000 行（估算，第 7 节） |
| 固定顶栏 | 并进 footer | 没有 |

推断：第一版不做 P 类。用户消息只换底色，thinking 用 Pi 默认的显示。先看路线 A 做出来的效果，再决定值不值得承担 patch 的维护成本。

## 6. 需要你拍板的事

1. **Pi 从 0.83 升到 0.87.x？** 推荐升级。
   - 不升级的话，`registerMarkdownTransformer`、全屏模式、`embedWorkingStatus` 都用不了，社区的外框扩展也装不上。
   - 升级影响 README、`host.ts` 里的版本锁定和 benchmark 契约测试。
   - 扩展 UI 接口两版一致，但 0.84 把 `TUI` 从类改成接口，0.87 新增了事件类型，MMP 自己用到的地方要回归。
2. **默认 inline 还是全屏？** 推荐第一版保留 inline，全屏作为选项。
   - grok 默认全屏；Pi 0.84+ 两种都支持。
   - inline 保留终端原生的滚动和复制，风险小。
3. **消息区要不要走 patch？** 推荐第一版不走（见第 5 节）。
4. **皮肤是 MMP 内置，还是作为独立 Extension 在 Manifest 里声明？**
   - 推断：按 DEVELOPMENT.md 的分层，"Extension owns capability"，应该做成独立 Extension。更正：按 README"资源必须在 Manifest 显式声明"，应该声明了才启用，不默认开启（见 [tui-design.md](tui-design.md) H4）。
   - `setHeader`、`setFooter`、`setEditorComponent` 各只有一个槽位，最后加载的生效。更正：第三方扩展由 Pi 通过 `--extension` 加载，MMP 装配时看不到它们调用哪些 `set*`，所以检测不了冲突，只能写进文档作为已知限制。

## 7. 四条路线对比

| | A 扩展皮肤（推荐） | B 复制 InteractiveMode | C 自研 TUI，仍用 pi-tui | C' 换 Ink / ratatui |
|---|---|---|---|---|
| 接入方式 | 继续用 `main(args, {extensionFactories})` | 改用 `createAgentSessionRuntime`，加上一份改造过的 InteractiveMode | 改用 `createAgentSessionRuntime`，自己订阅事件、自己实现 `ExtensionUIContext` | 同 C，但换渲染栈 |
| 能改的范围 | 第 4 节里的 A 类 | 全部布局，但仍受 inline 限制（0.83） | 全部 | 全部 |
| MMP 新增代码 | 约 1,000–2,000 行（参照 pi-grok-tui 的 997 行 TS；Pi 调研笔记记为 1,173 行，统计口径不同） | 6,058 行起步，还要带上约 25 个未导出的内部模块 | 3,000–6,000 行（估算） | 5,000–10,000 行（估算） |
| 第三方扩展 UI | 完全兼容 | 兼容 | 自己实现 `ctx.ui` 才兼容 | 大面积失效，MCP 面板首当其冲 |
| 跟随 Pi 升级 | 低：接口稳定 | 高：上游已涨到 6,888 行 | 中 | 中 |

路线 C 的时机：路线 A 加全屏模式仍然满足不了（例如要侧栏、多会话 Dashboard、子代理全屏接管）时再考虑。那时 DEVELOPMENT.md 写的"下沉到 createAgentSessionRuntime"就成立了。

## 8. 路线 A 的第一版范围（已被 [tui-design.md](tui-design.md) 取代）

按用户能看到的效果排序，每一步都能单独交付：

| 步 | 内容 | Pi 接口 |
|---|---|---|
| 1 | groknight / grokday 主题 | `setTheme` |
| 2 | 圆角输入框，模型、思考档位、模式写在底边 | `setEditorComponent` |
| 3 | 底部一行：路径、分支、上下文占用、快捷键提示 | `setFooter` |
| 4 | 运行状态行（braille spinner、活动、耗时、tokens） | `setWorkingIndicator`、`setWorkingMessage` |
| 5 | 7 个内置工具的竖条卡片、三态截断、无 `+`/`-` diff | `registerTool` 覆盖渲染 |
| 6 | ~~MMP 自己的确认卡片~~（更正：MMP 没有自己的确认对话框，此步取消） | — |
| 7 | 启动页按 grok 的样子重排 | `setHeader` |
| 8 | markdown 去标记、动词分组（需 0.84+，要实测） | `registerMarkdownTransformer`、共享状态 |

验证方法：每一步都在 80 列和 120 列、暗色和亮色终端下截图对比，再跑一次真实会话。

## 9. 没验证的

- 0.84+ 全屏模式下，扩展能不能拿到 ScrollView，能不能做历史块的折叠。
- 动词分组的共享状态写法（第 4 节 #6）；OSC 9;4 直接写 stdout 会不会和 pi-tui 冲突。
- `--no-themes` 下，扩展通过 `resources_discover.themePaths` 注册主题是否生效。MMP 启动时带了这个参数；`setTheme(Theme 对象)` 不受它影响。
- 路线 B、C、C' 的行数是估算，不是测量。
- grok 截图和源码有两处不一致（底边信息的对齐方式、列表 bullet 的字符），可能是版本差异。
