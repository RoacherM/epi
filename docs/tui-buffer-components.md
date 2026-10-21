# 只读查看组件（`src/tui/buffer/`）与组合指南

状态：2026-10-21 主控拆分并实现（用户确认："不需要支持编辑功能，本次优先对 editor 的模块进行拆解，方便后续复用"）。设计背景与演进记录见 [tui-buffer-overlay-design.md](tui-buffer-overlay-design.md)；本文只讲现在有哪些模块、怎么组合。

## 1. 分层

```
  宿主（页面/悬浮窗）          画框、自己的键（w 折行、y 复制、]c、r Markdown……）、渲染行
        │ 用
        ▼
  BufferViewport  ───────────  一份带行号的文本：折行、行号槽、匹配高亮、位置读数
        │ 组合
        ▼
  TextNavigation  ───────────  动作键 + `/` 搜索 `n/N` + `:N`/`NG`，作用在一个 NavigationTarget 上
        │ 组合
        ▼
  MotionKeys + applyMotion     计数、gg/G、j/k、翻页 → 落点（只管移动）
  Finder + LinePrompt          查找与底栏输入（search.ts）
  scrollbar / scrollFromBar    一列滚动条与点击/拖动换算
```

拆分规则：**有两个以上真实使用者才抽成共享模块**（只有一个使用者的，比如悬浮窗的边框，留在原处）。例外是 `viewport.ts`：现在只有悬浮窗用它，单独成文件是为了让"带行号的文本视图"脱离悬浮框测试（折行、行号槽、`:N` 换算），等第二个使用者出现再看接口是否合适。每个模块只依赖它下面的层，不依赖 `src/extensions/`。

## 2. 模块

| 模块 | 接口 | 负责 | 不负责 | 使用者 |
|---|---|---|---|---|
| `motion-keys.ts` | `new MotionKeys({ counts?, space? })`；`handle(key) → pending \| motion \| key(count)`；`pending`；`applyMotion(motion, at, page, last, lineAt?)` | 计数（`10j`）、`gg`/`G`/`NG`/`Ngg`、`j k ↑ ↓`、`Ctrl+d/u`、`Space PageDown Ctrl+f`、`b PageUp Ctrl+b`、`Home End`；Esc 先清未完成的输入；落点夹在 `0..last` | `/` `:` `n` `N`；任何页面专属键 | `/preview` 文件列表、改动列表、`/review`、`/trace`、`TextNavigation` |
| `search.ts` | `Finder`（`query`、`matches`、`next`、`highlight`）；`LinePrompt`（`kind`、`text`、`handleInput → submit \| cancel`）；`printable(text)` | 按屏幕行查找（大写字母时区分大小写）、底栏单行输入、把控制/双向字符变成可安全显示的文本 | 滚动、状态文案 | `TextNavigation`、`/review`（批注输入）、`/trace`、`/preview` 文件模块 |
| `navigation.ts` | `new TextNavigation(target)`；`handle(key) → taken \| key(count)`；`scrollTo(row)`（视图自己的移动）；`prompt`、`status`（`{ text, tone: error\|info }`，下一个键清掉）、`pending`、`highlight(row, invert)` | 一个只读文本视图的全部导航键：动作、`/` + `n/N`（带 `[i/n]`，在末屏也能逐个前进）、`:N` 与 `NG`；所有落点的夹紧；把计数交还给宿主的键 | 怎么画；折行；关闭/复制等宿主动作 | `BufferViewport`、`/preview` 完整文件视图、单文件 diff |
| `scrollbar.ts` | `scrollbar(theme, total, visible, offset, height, style?)`；`scrollFromBar(row, height, total, visible)` | 一列滚动条（`style` 决定滑块/轨道颜色、全显示时空白还是画框线）；点击行换算滚动位置 | 鼠标事件路由 | `/preview`、`/review`、`/trace`、悬浮窗 |
| `viewport.ts` | `new BufferViewport({ lines, firstLineNumber? }, style)`；`handleInput → close \| yank \| handled \| ignored`；`render(width, height)`；`measure(width)`；`wheel(delta)`；`navigation`、`mode`、`scrollTop`、`maxScroll`、`rowCount`、`visibleLines()`、`wrap` | 一份已上色的文本：行号槽（或无槽）、`w` 折行且保持顶行不跳、匹配高亮 | 边框、滚动条、底栏 | 悬浮窗 |
| `inspector.ts` | `InspectTarget { title, subtitle?, lines, firstLineNumber?, text }`；`new BlockInspectorOverlay(theme, target, { close, copy, requestRender, terminalRows })` | 居中悬浮框：标题与 `[× Esc]`、右边框兼滚动条、底栏（模式/位置/提示/输入）、滚轮、`y` 复制及失败提示、高度不超过终端 82% | 何时打开、谁持有它 | `Transcript.inspect()`（工具块与 `!cmd` 块） |

## 3. 不变量（改这些模块时必须保持）

- **键的先后顺序**：底栏输入（`prompt`）打开时所有键都给它；其次是动作键；最后才是宿主的键。计数只有经过 `MotionKeys` 才会交给宿主（`3n` 由导航处理，`3w` 以 `count: 3` 交还）。宿主若有自己的前缀键（diff 的 `]`/`[`），在调用导航之前先处理，且只在 `prompt` 关闭时处理。
- **Esc 分层**：先清未完成的计数或 `g`，再退出 `/`、`:` 输入，最后才轮到宿主（关闭/返回）。
- **`g` 前缀**：`gg` 到顶；`g` 后跟其他键时丢弃 `g`，那个键照常处理（给将来的 `gj`/`gd` 留位置）。
- **滚动位置只经过导航改、只由导航夹紧**：键（`handle`）和视图自己的移动（滚轮、拖滚动条、diff 的 `]c`）都走导航——后者调 `nav.scrollTo(row)`。`setTop(row)` 收到的一定在 `0..maxTop()` 内；`goToLine` 只返回 `{ row }`（或 `{ error }`），不直接改滚动位置。`maxTop()` 必须是"总行数 − 正文高度，至少 0"（导航用它算哪些行在屏上）。render 里按新尺寸再夹一次是允许的。
- **`n`/`N` 从上一个匹配继续**：上一次落到的行如果此刻仍在屏上、而且那一行的文本没变（按当前的 `rows()` 检查），就从它接着找；否则从顶行找。末屏上多个匹配时顶行被夹在 `maxTop`，从顶行找会一直找到同一个，所以要这样。视图重建了行（折行、Markdown/源码切换、窗口变宽变窄、文件重新加载）时，同一下标的文本变了，自然不再沿用，视图不必通知导航。任何移动（键、`:N`/`NG`、`scrollTo`）都会忘掉它。顶行在 render 之前可能还没夹紧，导航的所有计算（动作键、新搜索、`n`/`N` 起点）都按夹紧后的值算。重建后同一下标恰好是一模一样的一行时会沿用——屏上所有匹配高亮相同、看不出哪个是"当前"，从它往后找与平常的 `n` 一致（主控定，2026-10-21 第 5 轮审查）。
- **搜索看的是显示出来的行**：`rows()` 返回屏幕行（折行后的），不含行号槽；不是文件文本的行（diff 的折叠标记）返回空串。
- **状态只活一个键**：`status` 在下一个非等待键时清空；宿主自己的提示（折行开关、"no change below"、复制结果）写进同一个 `status`，不另设字段。`/preview` 只显示 `tone: "error"`，悬浮窗两种都显示。
- **不给编辑留口子**：这一层只读。`Enter` 和 `h` 不绑定，由宿主决定。

## 4. 组合方式

### 4.1 一个可搜索的只读文本视图（最常见）

```ts
import type { Theme } from "@earendil-works/pi-coding-agent";

import { TextNavigation } from "../../tui/buffer/navigation.js";
import { scrollbar } from "../../tui/buffer/scrollbar.js";
import { printable } from "../../tui/buffer/search.js";
import { piTui } from "../../tui/pi-tui.js";

const { matchesKey, truncateToWidth, visibleWidth } = piTui;
const pad = (text: string, width: number) => {
  const cut = truncateToWidth(text, width, "…");
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
};

class LogView {
  private scroll = 0;
  private height = 1;
  private readonly nav: TextNavigation;

  constructor(private readonly theme: Theme, private readonly rows: string[]) {
    this.nav = new TextNavigation({
      rows: () => this.rows,
      top: () => this.scroll,
      setTop: (row) => { this.scroll = row; },
      maxTop: () => Math.max(0, this.rows.length - this.height),
      page: () => Math.max(1, this.height - 1),
      // 可选：行号不等于行下标时（折行、diff）提供，返回 { row } 或 { error }。
    });
  }

  /** 正在输入 `/` 或 `:` 时，宿主不要让全局键（Tab 切页等）抢键。 */
  get busy(): boolean { return this.nav.prompt !== undefined; }

  handleInput(data: string): "back" | undefined {
    const result = this.nav.handle(data);
    if (result.kind === "taken") return undefined;
    if (data === "q" || matchesKey(data, "escape")) return "back";
    // 宿主自己的键在这里；result.count 是之前敲的计数。
    return undefined;
  }

  /** `height` 行：正文 height − 1 行，最后一行是底栏。 */
  render(width: number, height: number): string[] {
    this.height = Math.max(1, height - 1);
    const bar = scrollbar(this.theme, this.rows.length, this.height, this.scroll, this.height);
    const body = Array.from({ length: this.height }, (_, i) =>
      pad(this.nav.highlight(this.rows[this.scroll + i] ?? "", (t) => this.theme.inverse(t)), width - 1) + bar[i]);
    const { prompt, status } = this.nav;
    const footer = prompt ? `${prompt.kind}${printable(prompt.text)}▏` : status?.text ?? "j/k · gg/G · / search · : line";
    return [...body, pad(footer, width)];
  }
}
```

### 4.2 一个移动光标的列表

列表不需要搜索导航时，只用动作键，落点施加到光标上：

```ts
private readonly motions = new MotionKeys();        // 页面把 Space 占用了就 { space: false }

handleInput(data: string) {
  const keys = this.motions.handle(data);
  if (keys.kind === "pending") return;
  if (keys.kind === "motion") {
    this.cursor = applyMotion(keys.motion, this.cursor, this.pageRows(), this.items.length - 1);
    return;
  }
  // 页面自己的键（Enter 打开、/ 过滤……）
}
```

`NG` 在列表里是"第 N 项"（`applyMotion` 默认把 line N 换成下标 N − 1）；`/review` 的行是屏幕行（文件头、改动行、折叠行都算一行），所以 `NG` 是第 N 个屏幕行。需要副作用的动作单独处理再交给 `applyMotion`：`/review` 的 `G`/`NG` 先载入全部文件，`/trace` 的 `gg` 停止跟随、`G` 恢复跟随（其他移动按"是否停在最后一步"决定是否跟随）。数字另有用途的页面（`/trace` 详情的 `1-5`）用 `{ counts: false }`。

### 4.3 在悬浮窗里看任意一段内容

不必自己组合：构造一个 `InspectTarget`，交给 `Transcript.inspect(target)`（或扩展里拿到的 `CommandHost.inspect`）。它负责只开一个、换会话时关闭、焦点回到输入框。

```ts
host.inspect({
  title: "$ npm test",
  subtitle: "120 lines · exit 1",
  lines: output.map((line) => theme.fg("toolOutput", line)),
  firstLineNumber: 1,          // 内容自带行号（diff）时省略，不画行号槽
  text: output.join("\n"),     // y 复制的纯文本
});
```

在工具块里让某一行可点击打开：渲染器返回 `new LinesComponent(lines, { rows: [行下标], target })`（`src/tui/tools/common.ts`），`toolBlock` 的外框会把这一行的左键点击转给 `onInspect`。

### 4.4 只要滚动条

`scrollbar(theme, total, visible, offset, height)` 画在正文右侧一列；可拖动时在鼠标的 press/drag 事件里用 `scrollFromBar(row, height, total, visible)` 换算滚动位置（`/preview` 文件视图是现成的例子）。视图用了 `TextNavigation` 时，滚轮和拖动的结果交给 `nav.scrollTo()`，不要直接写滚动值。作为框线一侧时传 `{ thumb, track, fits }`，全显示时画成普通边线（悬浮窗）。

## 5. 什么时候不要用这些模块

- 页面的 `/` 不是"跳到下一个匹配"：文件列表是实时过滤，`/review` 是写批注，`/trace` 会切到详情面板——它们直接用 `Finder`/`LinePrompt`，不用 `TextNavigation`。
- 内容不是一行一行的文本：图片、视频交给 `/preview` 的 `imageBody` 和播放面板。
- 需要编辑：这一层是只读的，当前也不计划编辑（[tui-buffer-overlay-design.md](tui-buffer-overlay-design.md) §7）。

## 6. 测试

| 模块 | 测试 |
|---|---|
| `motion-keys.ts` | `test/tui-motion-keys.test.mjs` |
| `navigation.ts`、`viewport.ts`、`inspector.ts` | `test/tui-buffer-viewport.test.mjs` |
| 工具块点击打开悬浮窗 | `test/tui-block-inspector.test.mjs`（含真实 app 的 SGR 点击） |
| `scrollbar.ts` | `test/tui-scrollbar.test.mjs` |
| 组合到页面后的行为 | `test/preview.test.mjs`、`test/preview-changes.test.mjs`、`test/review-page.test.mjs`、`test/trace-page.test.mjs` |

新宿主接入时，至少测：键的先后顺序（输入框打开时 `j` 进输入框）、Esc 分层、`gg`/`NG` 落点、40/80/120 列下每行 `visibleWidth ≤ width`。
