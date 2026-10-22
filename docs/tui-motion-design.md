# TUI 动态视觉与 ASCII-Art 渲染层设计

日期：2026-10-20 起草；状态：**Phase 1（M1–M6）已实现**，分支 `feat/tui-motion-buffer-overlay`，实现与本文的差异见 §6（原型与离线 Probe：`scripts/probes/ascii-tui-prototype.mjs`）。
依据：
- 用户调研与方向确认（2026-10-20）：结合 `ascii-magic-art` 的轻量函数式帧生成、字符密度映射（Looks）与高斯脉冲着色，升级 Epi TUI 的静态节点。
- 实测与 Probe 验证：`scripts/probes/ascii-tui-prototype.mjs`（含 30FPS 实时终端预览与 `--probe` 离线宽度/帧耗时/xterm 缓冲区契约测试）。
- 既有设计基线：[tui-design.md](tui-design.md)、[tui-theme.md](tui-theme.md)、[statusbar-design.md](statusbar-design.md)。

---

## 1. 目标与边界

一句话目标：**在不引入外部重依赖、不破坏 `grok-build` 克制利落气质、不增加空闲 CPU 开销的前提下，为 Epi TUI 引入统一的轻量字符动效与流光着色管线。**

### 1.1 明确不做
- **不引入 `@zenbu-labs/pixel` 的同屏 Kitty 图像嵌入**：`TuiAltScreen` 在全屏重绘与图片行变更时会调用 `deleteAllKittyPlacements()` / `deleteAllKittyImages()`（`tui-alt-screen.js:1492-1502`），与子进程直接刷 TTY 像素帧冲突，且携带数以百 MB 计的定制 Electron 运行时。
- **不把 `ascii-magic-art` 的 634 个成品文件打进发布包**：只内化其核心的百行机制（`Grid` + Z-buffer 深度缓冲、`LOOKS` 字符集重绘器、高斯脉冲与主题色插值），所有动效直接读 Epi 的 `Theme` 语义色（`accent`、`syntaxFunction`、`thinkingHigh`、`borderMuted` 等）。
- **不在会话静止且离开欢迎页后跑后台定时器**：任何动画定时器必须遵循“仅在可见且活跃时 tick，不可见或完成后立即 `clearInterval` 并 `.unref()`”的硬性生命周期契约。

---

## 2. 全量动画节点全景与分期

### Phase 1：主界面高频层（第一批改造范围）

| # | 节点 | 目标文件 | 现状 | 改造规格 |
|---|---|---|---|---|
| **M1** | **启动欢迎页 Hero 区** | `src/startup-page.ts`<br>`src/extensions/runtime.ts` | `LOGO_PIXELS`（34×12 半块像素 → 6 行）纯静态渲染；`setHeader` 忽略了 `tui` 参数 | 默认采用 **双波流光半块 Logo**（高斯高光沿 `accent` 紫与 `syntaxFunction` 蓝扫掠）；支持可选 3D 几何体（`torus` / `icosa` / `helix`，10 行高 Z-buffer 渲染）与 5 种 `Look`（`original` / `dots` / `dither` / `ascii` / `binary`）。用户发送首条消息（`messageCount > 0`）后定时器自动停机 |
| **M2** | **启动页右侧分割线** | `src/startup-page.ts` (`assemblyRows`) | `ASSEMBLY` / `COMPOSITION` / `CONFIGURE` 之间为静态 `─` | 改为 **细线双向流光分割线（`renderPulseRule`）**：保持字符几何为 `─`/`━`（不使用会在部分字体下鼓包的连续 `●`），用 `borderMuted` → `accent` / `syntaxFunction` 的颜色亮度高斯波表现呼吸感 |
| **M3** | **回合等待状态行 (`TurnStatus`)** | `src/tui/chrome.ts`<br>`src/tui/ext-host.ts` | 单字符盲文 `SPINNER = ["⠋", …]`（133ms） | 升级为 6 列宽的微缩动效（默认 `comet`：`···•●` 带高斯拖尾与紫青渐变；可选 `wave` / `braille`）；同时打通 `ext-host.ts:57` 的 `ui.setWorkingIndicator`，允许扩展替换或切换指示器样式 |
| **M4** | **流式 Thinking 与运行中 Tool / Bash 竖轨** | `src/tui/assistant-block.ts`<br>`src/tui/tools/block.ts`<br>`src/tui/bash-block.ts` | 运行中第 0 列为纯色静态 `theme.fg("accent", "┃")` | 当块处于 `active / running` 状态时，第 0 列渲染自上而下滑动的高光脉冲轨（`│` ↔ `┃`，颜色在 `accent` 与 `thinkingHigh` 间按行高斯插值）；非流式或只有 1 行时退化为单色流光呼吸 |
| **M5** | **连续只读工具合并行 (`Reading…`)** | `src/tui/tools/group.ts` | 运行中显示静态 `┃  ◈ Reading…` | 运行中时左侧竖轨接入 M4 流光轨，`◈` 随帧脉冲呼吸（0.1.24 起改为旋转的 x，见 [tui-glyphs-design.md](tui-glyphs-design.md)） |
| **M6** | **完成闪烁过渡 (`Completion Flash`)** | `src/tui/tools/flash.ts` | 结束时硬切纯绿/纯红 `┃` 400ms，到期瞬间消失 | 改为 **400ms 指数衰减呼吸（Ease-out Glow）**：前 120ms 高亮峰值（`success` / `error`），随后向 `borderMuted` 平滑衰减直至消隐 |

### Phase 2：二级面板与扩展卡片层（后续按需接入）

| # | 节点 | 目标文件 | 改造方向 |
|---|---|---|---|
| **M7** | **Subagent 任务卡片 (`epi:task`)** | `src/extensions/task.ts` | 运行中的前台/后台 Subagent 状态行接入盲文 spinner 与微缩脉冲条 |
| **M8** | **`/trace` 顶栏状态与空状态** | `src/extensions/trace/page.ts` | `● running` 接入呼吸点；`No steps recorded` 空状态配紧凑示波器动效 |
| **M9** | **`/preview` 顶栏状态与 `loading…` 占位** | `src/extensions/preview/page.ts`<br>`player-pane.ts` / `view.ts` | 视频/大文件首帧加载前的 `loading…` 居中区替换为动态骨架屏 |
| **M10** | **`/share` 模态等待框** | `src/tui/share-commands.ts` | 替换朴素 `BorderedLoader` 为带流光边框的 Epi Loader 卡片 |

---

## 3. 核心渲染原语设计（`src/tui/motion.ts`）

所有动画节点共用一个零外部依赖的纯函数模块 `src/tui/motion.ts`：

```
┌────────────────────────────────────────────────────────────────┐
│                       src/tui/motion.ts                        │
│  • mixThemeRgb(theme, tokenA, tokenB, t)                       │
│      基于 pi-tui 的 mixColors / capabilities，自动适配          │
│      truecolor (24-bit) 与 256-color 降级，支持 dark/light 主题 │
│  • Grid(cols, rows) + set(x, y, ch, color, lum) + setZ(...)    │
│      轻量字符+深度缓冲网格，单帧耗时 < 1.5ms                     │
│  • restyleLook(grid, look: "original"|"dots"|"dither"|...)     │
│      按亮度与 Bayer 4x4 矩阵将任意网格实时重绘为点阵/抖动/ASCII   │
│  • pulseRule(theme, width, t)                                  │
│      生成 `─`/`━` 双向高斯流光分割线                             │
│  • railGlyph(theme, row, t)  运行中竖轨的流光采样               │
│      状态行彗星指示器与左侧竖轨流光采样函数                       │
└────────────────────────────────────────────────────────────────┘
```

### 3.1 颜色与终端能力降级
- **不硬编码死夜间模式 Hex**：通过 `theme`（或 `src/tui/theme.ts` 的当前调色板 `NIGHT_FG` / `DAY_FG`）读取语义色起点与终点，保证 `epi-grok-night` 和 `epi-grok-day` 下的对比度都正确。
- **Truecolor vs 256-color vs `NO_COLOR`**：
  - `piTui.getCapabilities().trueColor === true` 时输出 `\x1b[38;2;r;g;bm` 连续渐变；
  - 256 色终端下量化到最近的 6×6×6 色立方体索引（避免在 macOS Terminal.app 等不支持 24-bit 的终端下乱码）；
  - 窄屏（`< 60` 列）或矮屏（`≤ 16` 行）严格遵守既有降级规则，绝不因动画字符挤占正文列宽。

### 3.2 帧率与单一定时器合并（Tick Coalescing）
- **欢迎页（Header）**：20–24 FPS（`42ms` 间隔）。
  - **关键生命周期**：`Transcript`（`src/tui/transcript.ts:72`）仅在 `this.messageCount === 0` 时调用 `this.header.render(width)`，发首条消息后不会主动通知 Header 卸载。
  - **自停机协议**：Header 组件维护 `renderedSinceLastTick` 标志——每次 `render()` 置为 `true`；定时器 tick 时若发现上一拍未被 `render()` 消费（说明 `messageCount > 0` 或被 Overlay 完全遮挡），**立即 `clearInterval` 自停**；当 `/new` 清空会话重新触发 `header.render()` 时再按需重启定时器。
- **运行态节点（`TurnStatus` + 流式 `ThinkingBlock` / `ToolEntry` / `UserBashBlock`）**：
  - 共用 `TurnStatus` 已有的运行期刷新节奏（由 `133ms` 提升至 `80ms` ≈ 12.5 FPS，所有定时器均 `.unref()`），无需每个 Tool 块各自开 `setInterval`。

---

## 4. 状态清单（`dev-workflow.md §3` 要求）

| 状态 | 归属模块 | 新增/改动 | 读写与重置时机（启动 / 换会话 / `/new` / `/resume` / `/reload` / 退出） |
|---|---|---|---|
| `headerTimer` & `renderedSinceLastTick` | `src/extensions/runtime.ts` (或 `startup-page.ts`) | 新增：驱动欢迎页流光与分割线脉冲 | `render()` 首帧且 `messageCount === 0` 时启动（`.unref()`）；下一拍未被 `render()` 调用时自动 `clearInterval`；`session_shutdown` 与 `/reload` 销毁旧 header 时清理 |
| `workingIndicator` | `src/tui/app.ts` & `ext-host.ts` | 新增：实现 `ui.setWorkingIndicator` | 扩展调用时更新当前指示器渲染函数；`session_invalidate`（`/new`、`/resume`、`/reload`）时重置为内置默认 `comet` |
| `FlashState.startedAt` | `src/tui/tools/flash.ts` | 改动：在原有 `until` 基础上记录起始时间戳以计算衰减系数 `(until - now) / FLASH_MS` | `startFlash()` 写入并启动 80ms 步进重绘直至 `now >= until`；`disposeFlash()` 与 `Transcript.reset()` 清理所有未到期 timer |

---

## 5. 测试计划与实现拆分

### 5.1 测试要求
1. **宽度与纯文本不变量（`test/startup-page.test.mjs`、`test/tui-chrome.test.mjs`）**：
   - 任意时间参数 `t`、任意 `Look`、在 `12 / 40 / 80 / 108` 列宽下，每行 `visibleWidth(line) <= width`。
   - `stripTerminalSequences` 后的文字结构与契约字段（`epi v<version>`、`ASSEMBLY`、`COMPOSITION`、`CONFIGURE`）保持不变，确保现有启动页快照测试兼容。
2. **欢迎页定时器自停机测试（新增单测）**：
   - 断言 `messageCount === 0` 时定时器正常推进帧；一旦模拟首条消息提交（不再调用 `header.render()`），最多 1 个 tick 后定时器自动停止，不再触发 `tui.requestRender()`。
3. **运行态竖轨与衰减闪烁测试（`test/tui-thinking.test.mjs`、`test/tui-tools-group.test.mjs`）**：
   - 运行中块第 0 列带流光竖轨；完成瞬间进入衰减闪烁，400ms 后恢复空白轨；回放历史（`/resume`）绝不触发闪烁。
4. **模型可见内容零改动验证**：
   - `node scripts/model-snapshot.mjs --diff` 必须无差异。

### 5.2 任务拆分（文件边界清晰，可独立交付）
- **Task 1A（基础动效引擎 + 欢迎页流光）**：`src/tui/motion.ts`、`src/startup-page.ts`、`src/extensions/runtime.ts`、`test/startup-page.test.mjs`。
- **Task 1B（状态行 Comet Spinner + 流光竖轨 + 衰减闪烁）**：`src/tui/chrome.ts`、`src/tui/ext-host.ts`、`src/tui/assistant-block.ts`、`src/tui/tools/block.ts`、`src/tui/tools/flash.ts`、`src/tui/bash-block.ts` 及对应单测。

---

## 6. 实现记录（Phase 1，主控定）

| 项 | 实现 | 与上文的差异及理由 |
|---|---|---|
| `src/tui/motion.ts` | `blend`/`blendFg`（用 `Theme.colors` + pi-tui `mixColors`/`foregroundAnsi`，跟随 Theme 的 truecolor/256 色模式）、`paintRuns`、`pulseRule`、`railGlyph`、`FrameTicker`（`breathe` 在 0.1.24 去掉：`◈`、`∴` 改成旋转的 x，见 [tui-glyphs-design.md](tui-glyphs-design.md)） | 没做 `Grid`/Z-buffer/`restyleLook`：只服务 3D Hero 与 5 种 Look，而它们还没有选择入口（设置项或命令），先不加无人调用的代码 |
| M1/M2 欢迎页 | 双波流光 Logo + 两条错相位脉冲分割线，24 FPS（`FrameTicker`，下一拍未被 render 即自停） | **只播一段 4s 开场**（3s 全强度 + 1s ease-out），之后静止在静态帧、定时器停止；`/new`、`/resume`、`/reload` 新建 header 时重播。实测常驻流光在空闲欢迎页约 90–130 KB/s 终端输出，违反 §1「不增加空闲开销」，也让依赖「画面静止」的测试失效。要改回常驻，改 `welcomeMotionStrength` 即可 |
| M3 状态行 | 保留原有单字符盲文 spinner（`⠋⠙⠹…`，accent，133ms 一帧），所有宽度相同；`ui.setWorkingIndicator` 已打通（自定义帧原样绘制、`[]` 隐藏、`undefined` 恢复），会话失效时复位 | **不做 comet 等新指示器**：用户实测 6 列 comet 后认为从左到右扫动"不够优雅克制"，试过原地呼吸的 `●` 后，确认更喜欢原来的盲文 spinner（2026-10-21）。状态行右侧（耗时、tokens、速度、`[stop]`）和输入框右下的模型标签保持静态文字。刷新节拍由 133ms 改为 80ms（驱动运行中竖轨），spinner 帧仍按 133ms 取；扩展自定义 `intervalMs` 按 80ms 节拍取整 |
| M4/M5 运行中竖轨 | 工具块、`!cmd` 块、流式 Thinking、只读分组：`┃` 颜色随脉冲沿行下移（accent ↔ thinkingHigh），分组 `◈` 呼吸；共用 TurnStatus 80ms 节拍，不另开定时器 | **字形固定为 `┃`，不在 `│`/`┃` 间切换**：e2e 测试与用户都以「`┃` 消失」判断块已结束；没有活动回合时（单独的 `!cmd`）竖轨不动画 |
| M6 完成闪烁 | 前 120ms 满色，之后指数 ease-out 向 `borderMuted`，400ms 消失；80ms 步进重绘，定时器 `unref` | 无 |
| M4/M6 并入回合脊柱（2026-10-21，[对话区排版](tui-transcript-layout-implementation.md) W8） | 各块不再自画第 0 列竖轨：脉冲改由 `src/tui/spine.ts` 画在第 1 列的回合脊柱上（`railBlend` 取色），运行中工具的 `├─` 常亮，完成闪烁照亮该块那一段脊柱（`flashBlend`，字形 `│`/`├─`） | **只有运行中回合的末端 8 行（tip）在动**，其上的行已是沉淀后的样子：pi-tui 主屏渲染只能改写屏内行，屏外行一变就整屏重绘（清空 scrollback 重写全部历史），整条脊柱一起动在超过一屏的回合上每帧都会这样（terminal-progress 测试因此超时）。单独的 `!cmd` 没有脊柱，也就没有脉冲（只有 `Running…` 文案） |
| 测试 | `test/tui-motion.test.mjs`（新）、`test/startup-page.test.mjs`（12/40/44/80/88/108/120 列、帧文本与静态页一致、256 色、开场收敛、自停机） | 12 列时标题原本就溢出（静态页既有问题），已一并修正 |

