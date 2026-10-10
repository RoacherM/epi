# 状态行：token 统计，可替换

日期：2026-10-06 起草；2026-10-06 按用户意见修订（位置、内容、可替换性）并实现（`feat/statusline` 分支，测试 `test/tui-statusline.test.mjs`）；状态：已实现。
来源：用户要求（"支持显示 tokens 的输出速度、缓存命中率" → "只放在输入框的右下角……还得考虑扩展性，用户不喜欢可以自行修改；UI 只是我们内置的一套" → "context 在顶栏右上角已有，状态行重复了，底栏去掉"）。

## 1. 做什么

两处展示，一静一动：

| 位置 | 内容 | 时机 |
|---|---|---|
| **输入框底边框右下角**（`PromptFrame` 已有的 grok 式 label 位，现在是 `model (level)`） | `gpt-5 (high) · ⇡12k ⇣3.1k · cache 91%` | 常驻 |
| 状态行（4.4 节，运行中那一行） | 末尾加 `· 87 tok/s` | 只在运行时 |

**context 占用不进状态行**：顶栏右上角已有（`12.9K / 272K`，2026-10-06 用户指出两处重复后定下这个分工）。取舍：≤16 行的矮屏会隐藏顶栏，那时 context 哪里都不显示——用户接受。`StatusLineStats` 仍带 `contextTokens`/`contextWindow`，扩展自定义格式可用。

不放：MCP/扩展连接状态、成本（用户没列，先不做）。会话级聚合口径；task 子任务是独立进程，usage 不进主会话，不算（写明，不处理）。

## 2. 数据口径

全部读已有数据，不改 SDK、不新增持久状态、不加配置项：

- `⇡ in` = 本会话发给模型的全部 prompt tokens = `input + cacheRead + cacheWrite`（pi-ai 已把各家归一：OpenAI 系的 `input` 已扣除 cached_tokens，见 `pi-ai/dist/api/openai-completions.js` 的 `parseChunkUsage`）。运行中把 `turn.outputTokens` 的实时值加进 `⇣`，让数字在流式时也在动。
- `⇣ out` = `output` 累计。tok/s = `turn.outputTokens / (now - turn.startedAt)`，render 时现算（整轮平均，含工具等待）；估算口径时带 `~`（4.4 节先例）。
- `cache` = `cacheRead / (input + cacheRead + cacheWrite)`。整段没有 token，或从没缓存过（cacheRead/cacheWrite 都是 0，包括 provider 不报缓存计数的情况）时这一段不显示——"0%"区分不了"没命中"和"没报"，不如不显示。
- `ctx` 不进状态行（在顶栏）；口径同顶栏现有的 `session.getContextUsage()`。
- 聚合源都是 `session.getSessionStats()` / `getContextUsage()`：`/new`、`/resume`、fork 后天然正确，不用写重置；`/reload` 保留累计。

## 3. 可替换设计：状态行是一个 slot，内置格式只是默认实现

对齐 architecture.md §3.5（扩展一视同仁）和用户说的"UI 只是我们内置的一套"：**格式化的入口对所有扩展开放，内置的那套就是默认值，不是特权代码**。

```
┌─ chrome.ts ─────────────┐   ┌─ app.ts ─────────────────┐   ┌─ ext-host.ts ──────────────┐
│ defaultStatusLine(stats)│←──│ statusLineSlot:          │←──│ pi.ui.setStatusLine(fn?)   │
│  内置默认格式（本规格）  │   │  当前生效的 formatter，  │   │  扩展第 29 个界面方法：    │
└─────────────────────────┘   │  初始 = defaultStatusLine│   │  传 fn 替换，传 undefined  │
                              │  PromptFrame 底边框每次  │   │  恢复默认                  │
                              │  render 现调            │   └────────────────────────────┘
                              └──────────────────────────┘
```

- 扩展 API：`pi.ui.setStatusLine(format: (stats: StatusLineStats) => string | undefined)`。返回 `undefined`/空串 = 该帧不显示统计段；`setStatusLine(undefined)` 恢复内置默认。用户想换样式，写一个几行的 Manifest 扩展即可（显示成本、换分隔符、加模型提供方……）。
- `StatusLineStats`：`{ model, thinkingLevel, input, output, liveOutputTokens, outputEstimated, cacheRead, cacheWrite, cacheHitRate: number | undefined, contextTokens, contextWindow, cost }`。一次给全，扩展不用碰 session internals；`model` 不预拼档位，由 formatter 自己拼。
- 和 `/new`、`/resume`、`/reload` 的关系：formatter 挂在 app 层不挂 session 上，换会话不清（不同于 footer/widget——那些是扩展为*这个会话*设置的界面，4.5 节语义）。stats 每次 render 从当前 session 现读，内容天然跟着会话走。
- 否掉的做法：settings.json 里的模板字符串（`"{in} {out}"`）。能改分隔符但改不了逻辑（比如"只在 cache 命中率低于 50% 时才显示"），两套自定义机制并存；扩展 API 一个机制覆盖全部，符合 Epi 的装配哲学。模板需求真出现了再加，formatter 签名不变。

## 4. 渲染与降级

- `PromptFrame` 底边框的 label 现在是单个回调，接收扣除滚动 hint 和连接符后的 label 预算（仍含边框预留的 6 列）；边框已有"放不下就整段丢"的兜底，在它之前先按段降级：先丢 `cache`，再丢 `⇡/⇣`，最后只剩 `model (level)`。
- 状态行 tok/s：<80 列丢这一段（<60 列丢 phase 是已有先例）。
- 矮屏 ≤16/≤12 行的既有降级不变（状态行在输入框边框上，不占行数）。
- footer、widget、扩展状态区：不动。

## 5. 状态清单（dev-workflow.md §3 要求）

| 状态 | 新增/改动 | 读写时机 |
|---|---|---|
| `statusLineSlot`（app.ts） | 新增：当前 formatter，默认 `defaultStatusLine` | 写：扩展 `setStatusLine`；读：`PromptFrame` label 回调每次 render。/new、/resume、/reload 不动它 |
| `TurnState.committedOutput`（chrome.ts） | 新增字段：本轮已结束消息的输出 token 总和；`outputTokens` 语义变为"仅在途消息" | 写：`message_end` 折叠（用最终 usage，不是最后一次流式估算）；读：`TurnStatus` 显示 `committedOutput + outputTokens`、statusline 只加在途部分，两者不重复计数 |
| `lastTurnMessages`（transcript） | 本轮不再改它：footer 汇总的方案被用户的位置决定取代，本轮数据直接看状态行和 statusline | — |

## 6. 测试计划

按 code-quality.md：修复前失败、临时 HOME/EPI_HOME、不联网。

- `defaultStatusLine`：格式拼段、cache 分母为 0 时省略、`~` 估算标记、窄屏逐段降级顺序。
- slot 语义：扩展 `setStatusLine` 替换/恢复默认；换会话后 stats 跟着新会话走、formatter 不被清。
- `PromptFrame`：label 超长时整段丢的既有兜底不回归；滚动 hint 和 label 共存。
- `TurnStatus`：tok/s 出现、idle 零行、窄屏丢弃。
- 交叉场景：/new 后统计归零；/resume 后显示被恢复会话的聚合。
- 快照：`node scripts/model-snapshot.mjs --diff` 应无变化（模型可见内容不动）。

## 7. 实现拆分（一个任务即可，文件不重叠）

- `src/tui/chrome.ts`：`defaultStatusLine`、`PromptFrame` label 拼接与逐段降级、`TurnStatus` 加 tok/s。
- `src/tui/app.ts`：`statusLineSlot`、stats 组装（读 `getSessionStats`/`getContextUsage`/`turn`）。
- `src/tui/ext-host.ts`：`setStatusLine`（Epi 在 Pi 的 28 个界面方法之外自己加的一个；类型上由 `EpiExtensionUIContext extends ExtensionUIContext` 声明，不属于 Pi 内部接口，不进 pi-internals.md）。
- `docs/tui-design.md` 4.1/4.3/4.4/6.1/6.3 节同步。

## 8. 实现注记（2026-10-06）

- formatter 拥有整个底边 label（含模型段），不是只拼统计段：返回空串就是整行不显示，扩展要保留模型时自己拼 `stats.model`。
- `⇡` 的口径是 `input + cacheRead + cacheWrite`；聚合在纯函数 `aggregateStatusLineStats` 里，单测钉死精确值（审出来的变异：漏加 cacheWrite 也能过宽松断言）。harness 里 faux 的口径不严谨（首个请求 cacheWrite 和 input 都记全量），所以底边数字只断言段的存在；需要精确 usage 时用 `faux-late-usage.mjs`（自定义流式 provider：partial 零 usage、最终消息带真值），faux core 做不到这一点——它一开始就算好 usage，每个 partial 都带。
- 审查（epi 内部模型独立会话，2026-10-06 第一轮）修掉四项 P2：message_end 折叠用最终 usage 而非流式估算；`StatusLineStats` 补齐 `thinkingLevel`/`liveOutputTokens` 且 `model` 不预拼；`PromptFrame` 先把滚动 hint 的宽度从 label 预算里扣掉再让 formatter 降级；聚合断言收紧为精确值。另加 /new 归零、formatter 跨 /new 保留的 harness 测试。
