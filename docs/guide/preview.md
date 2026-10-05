# Preview：在 Epi 里看 agent 改了什么

[← 使用文档](README.md)

`/preview` 打开一个整页的视图，不用离开 Epi 去开编辑器：

- **改动**：这次会话里 agent 改过的文件，每个文件的 diff。
- **文件**：三栏文件浏览，查看代码、渲染后的 Markdown、图片和视频。

它是内置扩展 `epi:preview`，只在交互界面里加载，模型看不到它。设计见 [preview-design.md](../preview-design.md)。

当前版本：**0.3.0**（扩展有自己的版本号，和 Epi 的版本分开，见文末的更新记录）。

## 打开

| 输入 | 效果 |
|---|---|
| `/preview` | agent 改过文件时打开"改动"，否则打开"文件" |
| `/preview src` | 在 `src` 目录打开"文件" |
| `/preview docs/guide/preview.md` | 直接打开这个文件 |
| `/preview ~/Downloads/demo.mp4` | 直接播放这个视频 |

整页打开，最下面一行显示 agent 的状态（`● agent running` 或 `○ agent idle`）和本次会话改了几个文件。`Tab` 在"改动"和"文件"之间切换；`Esc` 一层层退出，最外层回到对话。

## 改动

列出 agent 用写入、编辑工具改过的文件：`M` 修改，`A` 新建，`D` 已删除，右边是增删的行数。

| 键 | 作用 |
|---|---|
| `j` / `k` | 上下移动 |
| 回车、`l` | 打开这个文件的 diff |
| `t` | 在"本次会话"和"上一轮"之间切换 |
| `i` | 把 `@路径` 插进输入框并关闭 |
| `Tab` | 切到"文件" |
| `q`、Esc | 关闭 |

"本次会话"对比的是 agent 第一次改这个文件之前的样子；"上一轮"对比的是最近一轮开始改它之前的样子。另一边永远是磁盘上现在的内容。

### diff

旧行号、新行号、`-` / `+`，没变的行折叠成 `⋯ N unchanged lines`，每段改动前后留 3 行。增删的行里具体改了的词会反显。

| 键 | 作用 |
|---|---|
| `j`/`k`、空格/`b`、`Ctrl+D`/`Ctrl+U`、`g`/`G` | 滚动、翻页、到头尾 |
| `]c` / `[c` | 下一段、上一段改动 |
| `/` 文字，回车；`n` / `N` | 搜索；下一个、上一个。全小写时不分大小写 |
| `:` 行号，回车 | 跳到这一行（按现在的文件算） |
| `d` | 打开完整文件，`q` 回到 diff |
| `w` | 自动换行开关 |
| `i` | 插入 `@路径` |
| `q`、Esc、`h` | 回到列表 |

### 看不到的改动

- agent 用 bash 改的文件、外部程序改的文件不在列表里（只记写入和编辑工具）。
- 记录只在这次 Epi 运行的内存里：`/new`、`/resume`、`/reload` 之后清空，恢复旧会话时也看不到之前的改动。
- 改之前超过 4 MB 的文件只记"太大"，不显示 diff；一次改动太多（如整个文件重写）时也不显示 diff，用 `d` 看完整文件。很长的行（合起来超过 2000 个字符）不反显改了的词，只按整行显示增删。
- agent 改了又改回去、或编辑没成功的文件，和原来一样，不列出。
- 只改了换行符（CRLF/LF）、制表符或文件末尾换行的文件照样列出，打开时说明只改了这些（diff 按显示的样子比较，这些差别画不出来）。
- 自动重试的那次运行算作新的一轮，所以 `t` 看到的"上一轮"只含重试之后的改动（Pi 不告诉扩展一次运行会不会被重试）。

## 文件

### 浏览器

三栏：上级目录 | 当前目录 | 预览。光标停在哪个条目上，右栏就预览哪个：目录显示它的内容，文本显示带行号和语法高亮的前几屏，图片和视频显示一帧画面。

| 键 | 作用 |
|---|---|
| `j` / `k`，`↓` / `↑` | 上下移动 |
| `l`、`→`、回车 | 进入目录，或打开文件的查看器 |
| `h`、`←` | 回上级目录 |
| `g` / `G` | 到顶 / 到底 |
| `Ctrl+D` / `Ctrl+U` | 翻半页 |
| `J` / `K` | 滚动右栏的预览 |
| `/` | 按名字过滤（回车确认，Esc 清除） |
| `.` | 显示或隐藏以 `.` 开头的文件 |
| `~` | 回到家目录 |
| 空格 | 标记或取消标记 |
| `i` | 把 `@路径` 插进输入框并关闭；有标记时插入所有标记的文件。路径里有空格时写成 `@"路径"`；名字里有换行的文件不插入，会提示是哪个 |
| `Tab` | 切到"改动" |
| `q`、Esc | 关闭 |

鼠标：滚轮滚动，单击选中，双击打开，点击或拖动滚动条跳转。

### 查看器

| 文件 | 显示 | 键 |
|---|---|---|
| 文本、代码 | 行号加语法高亮 | `j`/`k` 滚动，空格 / `b` 翻页，`g`/`G` 到头尾，`w` 切换自动换行，`/` 搜索、`n`/`N`，`:` 跳到行号 |
| Markdown | 渲染后的样子 | 同上，`r` 在渲染和源码之间切换 |
| 二进制 | 十六进制 | 同文本 |
| 图片 | 原图，居中 | — |
| 视频、GIF | 按视频自己的帧率播放（最高每秒 30 帧），带进度条和音量波形 | 空格播放 / 暂停，`←`/`→` 跳 5 秒，`g` 回到开头；点画面暂停，点进度条跳转 |
| PDF、HEIC、Office 文档等 | macOS 的 Quick Look 缩略图 | — |

所有查看器里：`i` 把这个文件的 `@路径` 插进输入框并关闭，`q` 或 Esc 回到浏览器。

大文件只读前 4 MB，二进制只显示前 64 KB，超出时最后一行会说明。

#### 视频怎么播放

- **帧率**：用视频自己的帧率，最高每秒 30 帧（60 帧的视频按 30 帧显示）。
- **画质**：每帧长边缩到 640 像素，再由终端放大到面板大小，所以大面板上画面会偏软。这是有意的：按面板的完整像素出图时每帧有几 MB，播放会卡。
- **音画同步**：声音由 `ffplay` 播放，画面跟着它报告的播放位置走。声音还没开始时画面停在第一帧等它；来不及显示的帧直接丢掉，画面不会越播越落后。没有声音（或没装 `ffplay`）时按系统时钟走。
- GIF 也走这个播放器，所以同样需要 `ffmpeg`。

## 要求

- **图片和视频画面**需要终端支持图形协议（kitty 协议或 iTerm2 协议，例如 Ghostty、kitty、iTerm2、WezTerm）。不支持时显示文字占位。
- **视频**需要本机装有 `ffmpeg`（出画面）、`ffprobe`（读时长和尺寸）和 `ffplay`（出声音）。没有时查看器会显示 `ffmpeg not found: install ffmpeg to view video`，其他功能不受影响。Epi 不自带也不安装它们。
- **Quick Look 缩略图**只在 macOS 上有。
- 设 `EPI_PREVIEW_NERD=1` 用 Nerd Font 图标显示文件类型。
- 文件名和文件内容里的控制字符不会被终端执行：ESC 显示成 `␛`，其他控制字符被去掉。命名管道、设备这类不是普通文件的条目不会被打开，显示 `not a regular file`。
- 如果你自己的扩展也注册了 `/preview`，Epi 启动时就报错并说明是哪个扩展，请把那个命令改名。两个扩展不能注册同名命令（内置的也一样）。
- 正在看的文件或目录被删了，会显示 `xxx not found`；没有权限读的目录显示 `cannot read: permission denied`，不会显示成空目录。

## 给其他扩展用：播放器

你自己的扩展可以借用 `/preview` 的视频播放器，在自己的界面里放视频。preview 给的是一个画好的面板：你给视频地址，它给你画好的行；按键和鼠标交给它。设计见 [preview-design.md](../preview-design.md) 第 5 节。

### 怎么拿到

在 `pi.events` 上发一个空对象，`emit` 返回时 preview 已经把 `player` 填进去了：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let pane: PlayerPane | undefined;
  // /new、/resume、/reload 和退出时停掉还在放的视频
  pi.on("session_shutdown", () => pane?.dispose());

  pi.registerCommand("play", {
    description: "在界面里播放视频",
    handler: async (args, ctx) => {
      // 用到时再拿，不要在扩展加载时拿
      const request: { player?: PreviewPlayerApi } = {};
      pi.events.emit("epi/preview/player/v1", request);
      const player = request.player;
      if (!player) {
        ctx.ui.notify("没有 /preview 的播放器：需要 Epi 的交互界面", "error");
        return;
      }
      const error = await ctx.ui.custom<string | undefined>(async (tui, theme, _keybindings, done) => {
        try {
          pane = await player.createPane({ video: args.trim() }, { tui, theme, hint: "q 返回" });
        } catch (error) {
          done(error instanceof Error ? error.message : String(error));
          return { render: () => [], invalidate() {} };
        }
        const current = pane;
        return {
          render(width: number) {
            const { body, status } = current.render(width, Math.max(3, tui.terminal.rows - 2));
            return [...body, status];
          },
          handleInput(data: string) {
            if (data === "q") {
              current.dispose();
              done(undefined);
            } else if (current.handleInput(data)) {
              tui.requestRender();
            }
          },
          handleMouse(event: TuiMouseEvent) {
            if (current.handleMouse(event, event.x, event.y)) tui.requestRender();
            return event.type === "press" ? { capture: true } : { handled: true };
          },
          invalidate() {},
          dispose: () => current.dispose(),
        };
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } });
      pane = undefined;
      if (error) ctx.ui.notify(error, "error");
    },
  });
}
```

要点：

- **用到时再拿**（例如执行命令、按下"播放"时）。在扩展加载时（factory 里）拿不到：你的扩展比 preview 先加载。
- **在 `ctx.ui.custom` 里建面板**：面板要用它给的 `tui` 和 `theme`，新的一帧到了它会自己调 `tui.requestRender()`。
- **自己回收**：退出播放、关掉界面时调 `dispose()`；在 `session_shutdown` 里也调一次。`dispose()` 可以调多次。
- 面板不读文件、不探测视频：时长、帧率由你给。

### 接口

Epi 不导出这些类型，复制到你的扩展里：

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

`TUI`、`TuiMouseEvent` 来自 `@earendil-works/pi-tui`，`Theme` 来自 `@earendil-works/pi-coding-agent`。面板不处理 `q`、Esc 这类退出键（`handleInput` 返回 `false`），由你决定怎么退出。

### 出错时

| 情况 | 结果 |
|---|---|
| 非交互模式（`-p`、json、rpc）、没有 preview 的 Epi、纯 Pi | `request.player` 还是 `undefined`，你自己提示 |
| 在扩展加载时（factory 里）发请求 | 同上：preview 还没加载 |
| `video` 为空 | `createPane` reject：`createPane: video is empty` |
| `headers` 的名字或值里有换行 | `createPane` reject，错误里写明是哪个头（换行会把 ffmpeg 的 `-headers` 拆成别的头） |
| 没装 ffmpeg、地址打不开 | 不 reject，错误显示在面板的画面里，和 `/preview` 一样 |
| `/new`、`/resume`、`/fork`、`/reload`、退出 | preview 回收它发出、还没回收的面板；之后 `render` 只显示 `stopped`，不会重新开始播放 |
| 留着上一个会话拿到的 API 对象（`/new`、`/resume`、`/fork`、`/reload` 之前的）再调 `createPane` | reject：`createPane: this player belongs to a session that has ended; ask on epi/preview/player/v1 again`。用的时候重新发请求 |

频道名里的 `v1` 是接口的版本：有不兼容的改动时换新频道，旧的可以同时保留。

## 更新记录

扩展的版本和 Epi 的版本分开：tag 是 `preview-v*`，只在这个扩展有改动时才变。

| 版本 | 随 Epi（formerly MMP） | 内容 |
|---|---|---|
| 0.3.0 | 0.1.13 | 通过 `pi.events` 给其他扩展提供视频播放面板（`epi/preview/player/v1`）；`/preview` 自己的视频查看器也改用这个面板，看起来和以前一样 |
| 0.2.0 | 0.1.12 | "改动"：agent 改过的文件和 diff（本次会话 / 上一轮）；整页形态和 agent 状态行；diff 和完整文件里的搜索、跳到行号；记住每个文件看到的位置 |
| 0.1.1 | 0.1.11 | 文件或目录被删后显示 `not found`，读不了的目录说明原因，不再显示成空目录；另一个扩展也注册 `/preview` 时启动报错；名字里有换行的文件不插入并提示 |
| 0.1.0 | 0.1.10 | 首个版本。三栏浏览器；文本、Markdown、二进制、图片、视频、Quick Look 查看器；鼠标；`i` 插入 `@路径`；`/preview <文件>` 直接打开文件 |
