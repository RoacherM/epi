# Preview 设计

状态：2026-10-04 用户确认方向（"先不考虑修改功能，做好 preview 操作即可"）。本文是 `mmp:preview` 的设计文档；使用说明在 [guide/preview.md](guide/preview.md)，原则在 [architecture.md](architecture.md) §3.3，更早的讨论在 [notes/workspace-views.md](notes/workspace-views.md)。

## 1. 目标和范围

让人在 MMP 里看清 agent 改了什么，不用离开去开编辑器。

| 做 | 不做（以后再说） |
|---|---|
| 改动列表、diff、完整文件、搜索、跳到行号、整页形态、agent 状态 | 任何修改：内置编辑、`E` 外部编辑器、把人的修改告诉 agent |
| 文件浏览（0.1 已有） | 批注 |
| | 从对话里的工具卡片直接打开（对话区还没有"选中一张卡片"的操作） |
| | 会话恢复后还能看到之前的改动（快照只在内存里） |

## 2. 改动的基准：变更账

agent 每次调用 `write` 或 `edit` 工具、工具还没执行时，preview 扩展记下这个文件当时的内容（Pi 的 `tool_call` 事件）。

| 账上记什么 | 用途 |
|---|---|
| 文件路径 | 改动列表里的一行 |
| 本次会话里第一次被改之前的内容（文件原来不存在时记"新文件"） | "本次会话"的 diff 基准 |
| 最近一轮里第一次被改之前的内容，以及那是第几轮 | "上一轮"的 diff 基准 |

- 一轮 = 用户发一条消息后 agent 的一次运行（Pi 的 `agent_start`）。
- diff 的另一边永远是磁盘上现在的内容。
- 换会话（`/new`、`/resume`）时账清空。
- 超过 4 MB 的文件不记内容，只记"太大"。
- 看不到的改动：agent 用 bash 改的文件、外部程序改的文件。这一点在使用说明里写明。
- 账在工具执行前记，所以编辑失败或没改出差别的文件也在账上；列表只列和"之前"确实不同的文件。
- 一轮按 `agent_start` 计。Pi 的自动重试会再发一次 `agent_start`，扩展分不出来（`agent_end` 的 `willRetry` 只给 Pi 自己的监听者），所以重试算新的一轮。

## 3. 界面

整页（占满终端），Esc 一层层退出，最外层 Esc 回到对话，停在原来的位置。

```text
/preview ──▶ 改动（有改动时）  ◀─Tab─▶  文件（0.1 的三栏浏览器）
               │ Enter                      │ Enter
               ▼                            ▼
             diff  ──d──▶ 完整文件        完整文件
```

最下面一行常驻 agent 的状态：`● agent running` 或 `○ agent idle`，以及本轮改了几个文件。

### 3.1 改动列表

每行：路径、`+增 -删`、`new` 标记（新文件）。`t` 在"本次会话"和"上一轮"之间切换。

### 3.2 diff

- 统一格式：旧行号、新行号、`+`/`-`/空格、内容；每段改动前后各留 3 行上下文。
- 增删的行用 diff 的颜色，行内具体改动的词反显（两行合起来超过 2000 个字符时不做：逐词比较没有上限，长行会卡住界面）；上下文行有语法高亮。
- `]c` / `[c` 跳到下一段、上一段改动；`d` 打开完整文件。

### 3.3 搜索和跳转（diff 和完整文件里都有）

- `/` 输入要找的文字，回车；`n` / `N` 下一个、上一个；匹配处反显。
- `:` 输入行号，回车跳过去（diff 里按新文件的行号）。
- 每个文件记住上次看到的位置，在同一次 MMP 运行里有效。

### 3.4 实时

页面开着时 agent 继续改文件：改动列表和打开的 diff 在下一次重绘时更新。

## 4. 实现

| 模块 | 内容 |
|---|---|
| `preview/ledger.ts` | 变更账：监听 `tool_call` 和 `agent_start`，存快照，给出改动列表 |
| `preview/diff.ts` | 用 Pi 自带的 `diff` 包（`structuredPatch`、`diffWordsWithSpace`）算出带行号的 diff 行 |
| `preview/search.ts` | 搜索和行号输入，diff 和完整文件共用 |
| `preview/changes.ts` | 改动列表和 diff 视图 |
| `preview/page.ts` | 整页：在"改动"和"文件"之间切换，底部状态行 |

只用 Pi 的扩展接口，不碰内核，模型看到的内容不变。

## 5. 给其他扩展用的播放器（0.3.0）

2026-10-05 用户确认："由 preview 通过 Pi 的事件总线对外提供播放器接口"，接口做成"播放面板"。下面的接口细节是主控定的。

### 5.1 为什么

用户自己的扩展（在 `~/.mmp/extensions`，不随 MMP 发布）要在自己的界面里播放视频。以前它们用相对路径引用本机 yazi 扩展的 `Player` 类；yazi 收进仓库成为 `/preview` 以后，那份文件不再维护。内置扩展装在 MMP 的安装目录里，没有对外导出，扩展之间按 Pi 的做法通过 `pi.events` 通信（architecture.md：内置扩展用的接口和第三方扩展一样）。

对外的是一个画好的面板，不是 `Player` 类：调用方只给视频地址，拿回画好的行，按键和鼠标交给面板。这样 `Player` 的内部（ffmpeg 参数、帧格式、字段）可以继续改，不会弄坏别人的扩展；preview 自己的视频查看器也改用同一个面板，播放界面只有一份代码。

### 5.2 怎么拿到

```
其他扩展                                preview
  request = {}
  pi.events.emit("mmp/preview/player/v1", request) ──▶ 监听方：request.player = api
  （emit 返回时 request.player 已经填好）
  pane = await request.player.createPane(source, { tui, theme, hint })
```

- Pi 的 `pi.events.emit` 同步调用每个监听方（Node 的 EventEmitter），所以 `emit` 返回时请求对象已经填好。`src/hook-events.ts` 的 `mmp/hooks/task/v1` 已经这样用；这依赖 Pi 的实现，登记在 pi-internals.md。
- 什么时候拿：用到时再拿（例如按下"播放"时），不在扩展加载时拿，所以和扩展的加载顺序无关。
- 拿不到（`request.player` 还是 `undefined`）：没有 preview（非交互模式、老版本 MMP、纯 Pi）。调用方自己显示错误，preview 不管。
- 频道名带 `v1`：接口有不兼容的改动时换新频道，旧频道可以同时保留。
- `/reload` 以后 Pi 会取消旧的订阅（`loader.js` 的 `trackEventBusSubscription`），新的 preview 重新订阅，不会有两个监听方。

### 5.3 接口

```ts
interface PaneSource {
  video: string;                     // 文件路径或 URL（ffmpeg 的 -i）
  audio?: string;                    // 单独的音频流；不给就用 video 里的声音
  headers?: Record<string, string>;  // 读 video 和 audio 时带的 HTTP 头
  duration?: number;                 // 秒；进度条和点击跳转要用，不给就只显示已播放时间
  fps?: number;                      // 来源的帧率；不给按 24
  loop?: boolean;                    // 播完从头再来（GIF）
  label?: string;                    // 终端不能显示图片时，文字占位里的名字
}
interface PlayerHost {
  tui: TUI;                          // ctx.ui.custom() 给的；新帧到了调 requestRender()
  theme: Theme;
  hint?: string;                     // 调用方自己的按键说明，接在面板的说明后面
}
interface PlayerPane {
  /** body 正好 height 行：画面加一行音量波形；status 是一行：状态、时间、进度条、按键说明。 */
  render(width: number, height: number): { body: string[]; status: string };
  /** 空格/p 暂停继续，←/→ 和 h/l 跳 5 秒，g/0 回到开头；用了这个键返回 true。 */
  handleInput(data: string): boolean;
  /** x、y 相对 body 左上角；y === height 是 status 行。点画面暂停，点或拖进度条跳转。 */
  handleMouse(event: TuiMouseEvent, x: number, y: number): boolean;
  /** 停掉 ffmpeg 和 ffplay。可以调多次。 */
  dispose(): void;
}
interface PreviewPlayerApi {
  createPane(source: PaneSource, host: PlayerHost): Promise<PlayerPane>;
}
```

- `createPane` 是 async：播放代码在第一次用到时才加载（和 `/preview` 本身一样）。
- 参数不对时 `createPane` 直接 reject，错误里说明是哪一项：`video` 为空；`headers` 的名字或值里有换行（会把 ffmpeg 的 `-headers` 拆成别的头）。
- 播放出错（没装 ffmpeg、地址打不开）不 reject，显示在面板的画面里，和 `/preview` 一样。
- 面板由调用方回收：退出播放、关掉界面时调用 `dispose()`。preview 也记下自己发出、还没回收的面板，在它的 `session_shutdown`（`/new`、`/resume`、`/fork`、`/reload`、退出）时全部 `dispose()`：这几种情况进程不退出，`stopMediaProcesses` 只在进程退出时运行，漏掉的 ffplay 会一直出声。被回收的面板之后的 `render` 只显示"已停止"，不重新开始播放。
- 总线的监听方不能 `await`、不能抛错：Pi 在第一个 `await` 之前同步运行它，抛出的错误只会 `console.error` 弄脏界面。不是对象的请求直接忽略。
- 在扩展加载时（factory 里）发请求拿不到：用户声明的扩展比内置扩展先加载。
- 尺寸变了（终端缩放）由面板自己处理：从当前位置用新尺寸接着播放，暂停状态不变。
- 面板不读文件、不探测（ffprobe）来源；时长和帧率由调用方给。preview 自己的查看器先探测再建面板。

### 5.4 模块

| 模块 | 内容 |
|---|---|
| `preview/player-pane.ts` | `PlayerPane`：从 `view.ts` 的视频部分搬出来，查看器和其他扩展共用；构造是同步的，查看器直接 `new`。公开的来源类型叫 `PaneSource`，和 `media.ts` 内部的 `PlayerSource` 区分 |
| `preview.ts` | 订阅 `mmp/preview/player/v1`，回应 `createPane`（async，里面才 `import`）；记下发出的面板，`session_shutdown` 时回收 |
