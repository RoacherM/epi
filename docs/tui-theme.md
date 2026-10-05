# Epi TUI 配色映射

日期：2026-09-29。[tui-design.md](tui-design.md) 第 4.9 节的细节。

把 grok-build 的 groknight（暗）/ grokday（亮）配色映射到 Pi 主题的全部 token。Epi 启动时按这张表生成 `epi-grok-night.json`、`epi-grok-day.json`，写进 `~/.epi/pi/themes/`。

token 清单来自 0.87 的 `theme-schema.json`：前景（fg）必填 45 个、选填 4 个，背景（bg）必填 6 个、选填 1 个。`Theme` 构造函数要求所有必填 token 都给值。

"来源"一列的写法：
- 槽位名来自 grok 调研 3.1 节的主题槽位；
- `tm:` 开头的来自 grok 的 `grok-night.tmTheme` / `grok-day.tmTheme`（`crates/codegen/xai-grok-pager-render/assets/`）；
- **我定** 表示 grok 里没有对应的值，由我选定，需要你看截图时确认。

| Pi token | fg/bg | 必填 | 暗（groknight） | 亮（grokday） | 来源 |
|---|---|---|---|---|---|
| accent | fg | ✓ | #bb9af7 | #7D4BC6 | accent_assistant |
| border | fg | ✓ | #505058 | #A5A5AF | prompt_border_active |
| borderAccent | fg | ✓ | #bb9af7 | #7D4BC6 | accent_running |
| borderMuted | fg | ✓ | #323237 | #C8C8CD | prompt_border |
| success | fg | ✓ | #9ece6a | #378E23 | accent_success |
| error | fg | ✓ | #f7768e | #CD3048 | accent_error |
| warning | fg | ✓ | #FFDB8D | #A8780A | accent_plan |
| muted | fg | ✓ | #6c6c6c | #767676 | gray |
| dim | fg | ✓ | #585858 | #a5a5a5 | gray_dim |
| text | fg | ✓ | #e1e1e1 | #262626 | text_primary |
| thinkingText | fg | ✓ | #6c6c6c | #767676 | gray（grok 的 thinking 用 muted） |
| userMessageText | fg | ✓ | #e1e1e1 | #262626 | text_primary |
| customMessageText | fg | ✓ | #c8c8c8 | #444444 | text_secondary |
| customMessageLabel | fg | ✓ | #7aa2f7 | #2F64D2 | accent_system |
| toolTitle | fg | ✓ | #e1e1e1 | #262626 | text_primary |
| toolOutput | fg | ✓ | #c8c8c8 | #444444 | text_secondary |
| mdHeading | fg | ✓ | #1abc9c | #0A8E70 | md_h1（Pi 只有一个标题 token） |
| mdLink | fg | ✓ | #73daca | #0C947C | tm: link |
| mdLinkUrl | fg | ✓ | #6c6c6c | #767676 | gray |
| mdCode | fg | ✓ | #3A95AB | #0082AA | 暗：md_code；亮：tm: inline raw |
| mdCodeBlock | fg | ✓ | #89ddff | #0082AA | tm: fenced_code |
| mdCodeBlockBorder | fg | ✓ | #585858 | #a5a5a5 | gray_dim |
| mdQuote | fg | ✓ | #6c6c6c | #767676 | gray |
| mdQuoteBorder | fg | ✓ | #4e5579 | #b0b0b0 | tm: blockquote |
| mdHr | fg | ✓ | #585858 | #a5a5a5 | gray_dim |
| mdListBullet | fg | ✓ | #9abdf5 | #4A72B0 | tm: list_item |
| toolDiffAdded | fg | ✓ | #9ece6a | #378E23 | diff_insert_fg |
| toolDiffRemoved | fg | ✓ | #f7768e | #CD3048 | diff_delete_fg |
| toolDiffContext | fg | ✓ | #6c6c6c | #767676 | gray |
| syntaxComment | fg | ✓ | #51597d | #909090 | tm: comment |
| syntaxKeyword | fg | ✓ | #bb9af7 | #7D4BC6 | tm: keyword |
| syntaxFunction | fg | ✓ | #7aa2f7 | #2F64D2 | tm: entity.name.function |
| syntaxVariable | fg | ✓ | #c8c8c8 | #444444 | tm: variable |
| syntaxString | fg | ✓ | #9ece6a | #378E23 | tm: string |
| syntaxNumber | fg | ✓ | #ff9e64 | #C3691E | tm: constant |
| syntaxType | fg | ✓ | #0db9d7 | #0F87A2 | tm: support.type |
| syntaxOperator | fg | ✓ | #89ddff | #5580A8 | tm: keyword.operator |
| syntaxPunctuation | fg | ✓ | #9abdf5 | #4A72B0 | tm: punctuation.definition.block |
| thinkingOff | fg | ✓ | #505058 | #A5A5AF | 我定：和默认边框同色 |
| thinkingMinimal | fg | ✓ | #6c6c6c | #767676 | 我定 |
| thinkingLow | fg | ✓ | #7aa2f7 | #2F64D2 | 我定 |
| thinkingMedium | fg | ✓ | #bb9af7 | #7D4BC6 | 我定 |
| thinkingHigh | fg | ✓ | #7dcfff | #0082AA | 我定 |
| thinkingXhigh | fg | ✓ | #FFDB8D | #A8780A | 我定 |
| bashMode | fg | ✓ | #e0af68 | #A27612 | 暗：command；亮：tm: variable.other.global |
| thinkingMax | fg | 选填 | #f7768e | #CD3048 | 我定 |
| scrollbarTrack | fg | 选填 | #323237 | #C8C8CD | prompt_border |
| scrollbarThumb | fg | 选填 | #6c6c6c | #767676 | gray |
| searchMatchText | fg | 选填 | 不给 | 不给 | Pi 回落到 text |
| selectedBg | bg | ✓ | #363636 | #c6c6c6 | bg_visual |
| userMessageBg | bg | ✓ | #242424 | #dedede | bg_light |
| customMessageBg | bg | ✓ | #1c1c1c | #e4e4e4 | bg_dark |
| toolPendingBg | bg | ✓ | #1c1c1c | #e4e4e4 | bg_dark（grok 的工具输出面板） |
| toolSuccessBg | bg | ✓ | #1a211a | #e2ece2 | 我定：bg_dark 上微微偏绿 |
| toolErrorBg | bg | ✓ | #261a1c | #f2e2e4 | 我定：bg_dark 上微微偏红 |
| searchMatchBg | bg | 选填 | 不给 | 不给 | Pi 回落到 selectedBg |

两个 **我定** 的地方要说明：
- grok 用左侧竖条的颜色表示工具状态，工具框本身没有底色。Epi 自己画的工具卡片也照 grok 用竖条；这三个工具底色只在复用 Pi 组件的地方起作用，所以压得很淡。
- Pi 按思考档位给输入框边框换色，grok 没有这个概念。Epi 的输入框保留这个提示，档位越高颜色越亮，从灰色开始。

