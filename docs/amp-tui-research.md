# Amp CLI TUI 配色与字符渲染调研

日期：2026-10-26。只读调研，没改代码。给后续 Epi TUI 的配色和字体显示升级做参照。

调研对象：Amp CLI `0.0.1792972877-g78a0d4`（2026-10-26 构建；Bun 1.4.4 单文件可执行，`~/.amp/bin/amp`，约 135 MB）。

方法两路，下文每条结论都标了取证方式：

1. **读二进制**：`strings` 提取 TUI 框架、主题 token、终端能力探测的符号。
2. **抓真帧**：用 `pty` 起 TUI，改环境变量对比（真彩 / 无 `COLORTERM` / `TERM=xterm` / `TERM=dumb` / `NO_COLOR` / `--no-color`），并模拟终端回报不同背景色。抓帧只把 TUI 挂到一条既有线程上，没有发消息。

## 1. 结论

1. **文本输出和全屏 TUI 是两条完全不同的渲染路径。** 文本输出（`amp threads list` 这类）走 chalk 式能力探测、16 色 + 默认色，遵守 `NO_COLOR` / `--no-color`；全屏 TUI 自绘，恒定输出 24 位真彩。
2. **主题是一张语义 token 表**（60 多个），组件只取 token，不写死颜色。
3. **取值分三层**：终端默认色 → ANSI 调色板索引 → 固定真彩。前两层跟着用户终端主题走，只有品牌和强调色写死。
4. **层级主要靠属性**（dim / bold / italic），不是靠颜色堆叠。
5. **亮暗不是两套主题，是对比度变体**：启动时用 OSC 11 读终端背景色，亮度过阈值就把少数高亮 token 换成深色版。
6. **TUI 不做能力降级**：`TERM=dumb`、`NO_COLOR=1`、`--no-color` 下依然输出真彩；公开设置里没有 theme 项，用户只能改自己终端。

## 2. 渲染管线

| 证据（二进制符号 / 抓到的序列） | 结论 |
|---|---|
| `WidgetsBinding`、`BuildOwner`、`PipelineOwner`、`RenderObject`、`Element`、`MediaQuery`、`InheritedWidget`，调试横幅 `Gotta Go Fast` | 界面层是 Flutter 式的 widget / 渲染对象模型（自研或移植） |
| `_vaxis` 字段；启动时查询 OSC 10/11/12、`CSI ?2026$p`、`?2027$p`、`?1016$p`、`?2031$p`、`>0q`（XTVERSION）、`P+q4d73`（剪贴板）、`_Gi=1,a=q`（kitty 图形）、`_25a1;s`（字形协议）、DA1 | 推断：终端引擎是 Zig 的 vaxis 或它的移植，能力探测集和 vaxis 一致 |
| 抓帧里成对的 `CSI ?2026h` / `?2026l` | 整帧用同步输出提交，避免撕裂 |
| 抓帧里的 `CSI ?1049h` | 全屏走备用屏幕 |

能力探测里和字体直接相关的只有两项：`?2027$p`（emoji 宽度模式）和 `_25a1;s`（字形协议）。没看到对 ambiguous width 的探测或补偿。

## 3. 配色结构

### 3.1 token 表

核心（`Theme` 接口，13 个 + `colorScheme`）：

`foreground` `background` `mutedForeground` `cursor` `primary` `secondary` `accent` `border` `success` `destructive` `selection` `copyHighlight` `tableBorder`

业务态（约 50 个，按界面区域分）：

`fileBuffer` `toolRunning` `toolSuccess` `toolError` `toolCancelled` `toolName` `userMessage` `assistantMessage` `systemMessage` `codeBlock` `inlineCode` `syntaxHighlight` `fileReference` `processing` `waiting` `completed` `recommendation` `suggestion` `filename` `keybind` `button` `shellMode` `shellModeHidden` `handoffMode` `handoffModeDim` `queueMode` `diffAdded` `diffRemoved` `diffChanged` `diffContext` `ideConnected` `ideDisconnected` `ideWarning` `scrollbarThumb` `scrollbarTrack` `selectionBackground` `selectionForeground` `selectedMessage` `agentModeLabelTheme` `threadGraphNode` `threadGraphNodeSelected` `threadGraphConnector`

### 3.2 三层取值（抓帧实测）

| 层 | 用在哪 | 证据 |
|---|---|---|
| 终端默认前景 | 正文、助手回复、状态行文字 | `\x1b[39m`，一次抓帧 113 次 |
| ANSI 调色板索引 | 用户消息 `2`、运行中 spinner `4`、输入框和面板边框 `12` | `\x1b[38;5;2m` / `38;5;4m` / `38;5;12m` |
| 固定真彩 | 模型名 `#60a5fa`、推理档位 `#3dffa6`、欢迎页蓝色渐变（60 多档，程序生成） | `\x1b[38;2;96;165;250m` 等，一次抓帧 1000 多次 |
| 背景 | 不画 | 一次抓帧里 `48;2` / `48;5` 都是 0 次 |

### 3.3 属性

同一次抓帧里 dim（`\x1b[2m`）70 次、bold（`\x1b[1m`）11 次、italic（`\x1b[3m`）1 次。提示行、耗时、次要说明都是 dim，不用另配一种灰。

## 4. 亮/暗判定

启动时发 OSC 11 问背景色，按回报值切换。实测（同一屏、同一内容，只改回报值）：

| 回报的背景 | 推理档位颜色 | 判定 |
|---|---|---|
| `#000000` | `#3dffa6` | 暗 |
| `#808080` | `#3dffa6` | 暗 |
| `#a0a0a0` | `#008c46` | 亮 |
| `#ffffff` | `#008c46` | 亮 |

阈值在 `0x80` 和 `0xa0` 之间，约等于感知亮度 0.5。变体只换少数高亮 token，正文始终是终端默认前景，边框仍用索引色，所以整体观感不会翻成另一套主题。

## 5. 降级矩阵

| 环境 | 一次 6 秒抓帧里的真彩序列数 | 结论 |
|---|---|---|
| `COLORTERM=truecolor` | 1038 | 基准 |
| `TERM=xterm-256color`，无 `COLORTERM` | 1002 | 不降级 |
| `TERM=xterm` | 1024 | 不降级 |
| `TERM=dumb` | 956 | 不降级，仍进备用屏幕 |
| `NO_COLOR=1` | 1102 | TUI 忽略 |
| `--no-color` | 1027 | TUI 忽略 |
| 文本输出 + `NO_COLOR=1` | 0 | 遵守 |

公开的 settings schema 只有 22 项，没有 theme；`--color` / `--no-color` 的帮助文字也写明只按 stdout/stderr 是否 TTY 判断，管的是文本输出。

## 6. 字符集与字体

一次抓帧里出现的非 ASCII 字符共 32 个，绝大多数是 East Asian Width A（Ambiguous），少数 N（Neutral），`¯` 是 Na（Narrow）：

`• ● · ─ │ ┃ ╭ ╮ ╰ ╯ ▌ ▒ ≈ ∼ ≋ ¯ ⁰ ¹ ² ³ ⁴ ⁵ ⁶ ⁷ ₀ ₁ ₂ ₃ ₄ ₅ ₆ ₇`

次数：`•` 862、`●` 569、`·` 527、`─` 390，其余都在 20 次以内。

- 没有 emoji、没有 CJK、没有宽字符。
- 运行中动画是 `≈ ∼ ≋` 三帧轮转，不是盲文 spinner。
- 欢迎页的球体用 `• ● · : .` 五档字符画渐变，颜色由程序生成。

对字体升级的意义：这批字符绝大多数落在 Ambiguous 区。Epi 的 `visibleWidth` 走 pi-tui（`pi-tui/dist/utils.js:180` 调 `get-east-asian-width`，默认 `ambiguousAsWide: false`），把它们都算 1 格；而部分终端（不少 CJK 字体配置）把 A 类画成 2 格，于是框线和图标会错位。Amp 的 `?2027$p` 只问 emoji 宽度，管不到这里。Epi 现在用的是同一套字符区（[tui-glyphs-design.md](tui-glyphs-design.md) §2 规定单格宽、不用 emoji），字体升级要覆盖的就是这个场景，不是再加新符号。

## 7. 对 Epi 的启示

1. [tui-theme.md](tui-theme.md) 现在是两套完整主题（groknight / grokday），token 已经齐了。Amp 的三层取值可以作为一个补充方向：正文用默认前景、结构用 ANSI 索引、只在品牌处写死 hex。是否采用要单独定，不在这份调研里下结论。
2. Amp 不画底色，换终端主题时不会和背景打架；Epi 现在给消息块加 `userMessageBg` 这类底色，升级配色时可以拿 Amp 的帧做对照。
3. 字符集规则和 Epi 一致（单格宽、无 emoji），字体升级的重点应放在 ambiguous width 和字体回退，而不是扩充符号。
4. 亮暗：Epi 已有完整双主题，不必照搬「对比度变体」；但用 OSC 11 探测背景色来自动选 groknight / grokday 这件事可以做。

## 8. 复现

```bash
# 1) 读符号（不反编译，只看字符串）
strings -a ~/.amp/bin/amp | rg '_vaxis|mutedForeground|2026\$p|38;2;'
```

```python
# 2) 抓帧：pty 起 TUI，应答 OSC 10/11，再按 SGR 统计颜色
import os, pty, select, time, fcntl, termios, struct
env = {"HOME": os.environ["HOME"], "TERM": "xterm-256color", "COLORTERM": "truecolor",
       "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"}
pid, fd = pty.fork()
if pid == 0:
    os.chdir("/tmp")
    os.execvpe(os.path.expanduser("~/.amp/bin/amp"), ["amp", "threads", "continue", "<thread-id>"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
buf, start = b"", time.time()
while time.time() - start < 6:
    r, _, _ = select.select([fd], [], [], 0.2)
    if not r:
        continue
    chunk = os.read(fd, 65536)
    buf += chunk
    if b"\x1b]11;?" in chunk:          # 想测亮色就回 ffff/ffff/ffff
        os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
os.kill(pid, 9)
```

然后按 `\x1b\[38;2;R;G;Bm` / `38;5;N` / `39` 分类计数，用 `\x1b\[<行>;<列>H` 回放成屏幕看每个元素取的是哪一层。

## 9. 未验证

- 二进制里搜不到字面色值（`60a5fa`、`3dffa6` 都没有），主题色值只能靠抓帧。只覆盖了主界面可见元素，diff、工具调用、错误态的色值没抓到。
- 亮暗变体覆盖多少 token 没穷举，只确认了推理档位这一个。
- "不降级"是按环境变量试出来的（`TERM` 改到 `dumb` 仍真彩），但没有在真实的 16 色终端里跑过；如果 Amp 还会看 `TERM_PROGRAM` 之类的信号，结论可能要修正。
