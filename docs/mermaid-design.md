# Mermaid 图表渲染设计

状态：**已确认**（2026-10-22，"ok。先新增功能"）。用户已定方向：TUI first，图表画成终端字符，渲染引擎用 lovely-mermaid（"我们是TUI first。看起来还是lovely-mermaid吧"）。

## 1. 目标和范围

回复里的 ```` ```mermaid ```` 代码块，在对话区直接显示成 Unicode 框线图，不再显示 Mermaid 源码。只改显示：模型收到的内容、会话记录、复制出来的文字都不变（`model-snapshot` 无差异）。

| 做 | 不做（以后再说） |
|---|---|
| 助手回复里的顶层 ```` ```mermaid ```` 代码块 | 嵌在列表、引用里的 mermaid 代码块（仍显示源码，见 §4.5） |
| flowchart/graph、sequence、state、class、ER、pie、mindmap、timeline、gitGraph（引擎支持的全部种类） | 图片模式（SVG → kitty/iTerm2 图片），见 §6 |
| 画不出、放不下时显示源码，并用一行暗色说明原因 | `classDef` 作者配色（R5 色彩纪律：图表只用主题色） |
| 流式输出时，代码块闭合后才画 | 思考块、用户消息、`/preview` 的 Markdown 查看器（后续可复用同一个组件） |
| | 提示模型多用 Mermaid（改 prompt 属于另一件事，需单独决定） |

## 2. 引擎选择（实测，2026-10-22，本机 Node 26）

候选：lovely-mermaid 0.3.3（`mmd2txt` 用的引擎），以及 Ondine 0.0.3（wevm，Rust 编译成 wasm，输出 SVG）。用同两张图（一张 6 节点流程图，一张 3 个参与者的时序图）对比：

| | lovely-mermaid 0.3.3 | Ondine 0.0.3 |
|---|---|---|
| 输出 | Unicode 框线字符，每段带用途（边框、文字、连线等） | SVG；文字输出是把 SVG 按格子反推成 `+-\|` |
| 转成终端文字的耗时（预热后） | 98–154µs | 生成 SVG 14–39µs，再转成文字 165–538µs；第一次调用 12ms（加载 wasm） |
| 终端文字的效果 | 框线连续，箭头、虚线返回、自环都清楚 | 连线错位、箭头和框不对齐 |
| 依赖与体积 | 零依赖，解包后 0.8MB，Apache-2.0 | 包 29MB，依赖 `incur`（会带进 MCP server alpha、zod 等）；转图片还要 `@resvg/resvg-wasm`，MIT |
| 成熟度 | 2026-08 发布 0.3.3 | 2026-10-20 发布 0.0.3 |

结论：TUI first 选 lovely-mermaid。Ondine 的 SVG 很好看，适合以后的图片模式（§6）。两个引擎都在 1ms 以内，一帧有 16ms，速度不是瓶颈；差别在终端字符的效果和依赖体积。

依赖方式：Epi 直接依赖 `lovely-mermaid`，锁定 `0.3.3`（同 0.1.20 起的规则：直接依赖精确锁定，`npm-shrinkwrap.json` 同步更新）。它零依赖，不会引入新的间接依赖。不依赖 `mmd2txt`：它的可执行文件一被 import 就会执行命令行逻辑、读取 stdin（源码实测），而它多出来的功能（放不下时换方向、源码框）在 Epi 里各十几行就能写。

## 3. 放在哪里

**在 Epi 的正文排版组件里原生实现，不走 Pi 的 Markdown 转换接口。**

Pi 的 `registerMarkdownTransformer` 只能把一段 markdown 换成另一段 markdown。Mermaid 换成 ```` ```text ```` 以后，`MeasuredMarkdown.codeRows()` 会把它当普通代码：整块套上 `mdCodeBlock` 颜色，宽度超了还会折行（`wrapTextWithAnsi`），框线图会被折断；也没法按用途给边框、连线分别上色。

所以在 `src/tui/markdown-layout.ts` 里处理：`splitMarkdownSegments` 已经把顶层代码块单独切成段，`renderSegment` 遇到语言为 `mermaid` 的代码段时交给新的图表渲染函数（新文件 `src/tui/mermaid.ts`）。

- 不是 Manifest 能力，也不是扩展：同 `/preview`，属于随 Epi 一起提供的界面功能，模型看不到。Manifest v1 不变。
- 扩展注册的 Markdown 转换照常先执行：如果有扩展把 mermaid 代码块改写成了别的内容，就按改写后的内容显示，Epi 不再画图。

## 4. 显示规则

### 4.1 版式

和代码块同一个容器：第 3 列一条 `borderMuted` 暗竖线，内容从第 5 列开始，上方一行暗色标签 `mermaid`（同代码块的语言标签）。图表属于数据，不受 76 列正文限宽，可用宽度同代码块（`width - 5`）。图表行不折行、不截断：放不下时整张换方案（§4.3）。

### 4.2 配色（按引擎标出的用途）

| 用途 | 主题色 | 理由 |
|---|---|---|
| `border` 框线、子图边框 | `muted` | 结构是次要信息（R2） |
| `text` 节点、参与者文字 | `text` | 内容 |
| `edge` 连线、箭头 | `mdCode`（夜 `#8fb3c0` / 日 `#4f6f7a`） | 和行内代码同色阶，低饱和，不引入新强调色（R5） |
| `edgeLabel` 连线上的文字 | `muted` | |
| `title` 标题 | `dim` | |

实现时对着截图再定一次稿，日夜两个主题各出一张。

### 4.3 放不下、画不出时

按顺序尝试，每一步都看得见：

1. 正常画；宽度不超过可用宽度，直接显示。
2. 超宽，且是 flowchart/graph：把方向换一下（`LR` ↔ `TD`）再画一次，放得下就用它，标签行加暗色 ` · re-laid out top-down`（或 `left-right`）。
3. 还放不下，或引擎不支持这种图、一条语句都没解析出来、图太大被拒绝：照常显示源码代码块，标签行改成暗色说明，例如 `mermaid · 94 columns, wider than 80: showing source`、`mermaid · gantt is not supported: showing source`。

引擎丢掉了部分语句（`warnings` 非空）时，仍然画图，标签行加暗色 ` · dropped 2 statements`。图只是不完整，不该因此不画（引擎文档也这样要求）。

不吞错误（硬规则"失败要可见"）：引擎抛异常时也走第 3 步，说明里带上异常的第一行。

### 4.4 流式输出

代码块还没闭合（正在输出的最后一段）时显示源码，同现有代码块；闭合后再画成图。理由：引擎在半截源码上会画出不断跳动的半成品，而且每个中间状态都会有 warnings。`MeasuredMarkdown` 已经知道哪一段是最后一段（`trimPartialClosingFence`），闭合判断用 marked token 的 `raw` 是否以结束围栏收尾。

### 4.5 不处理的情况

- 嵌在列表、引用里的 mermaid 代码块：`splitMarkdownSegments` 只切顶层（避免序号重置，见 tui-transcript-layout-implementation.md W6），这些交给 Pi 的 `Markdown` 照常显示源码。LLM 的回复里很少把图表嵌在列表里。
- 思考块：思考块折叠时只显示一行，展开后仍显示源码。

### 4.6 性能

每个代码段按「源码 + 可用宽度」缓存渲染结果。`MeasuredMarkdown` 本来就按宽度缓存，图表的结果只在宽度变化或 `invalidate()` 时重算；单张图 0.1–0.2ms，换方向重试最多两次。

## 5. 测试与验收

- 单元测试（新 `test/tui-mermaid.test.mjs`）：闭合的 mermaid 画成框线图、颜色按 §4.2；流式未闭合显示源码；超宽的 flowchart 换方向；换方向后仍超宽、不支持的图、空源码、引擎异常都显示源码加说明；warnings 显示丢掉的语句数；嵌在列表里的不处理。
- 宽度属性：40/80/120/230 列下每行 `visibleWidth ≤ width`（同 W6）。
- 脊柱：图表行和代码行一样，第 1–2 列留空给脊柱，`test/tui-spine.test.mjs` 加一个带图表的回合。
- 回放：`/resume` 和实时输出画出同样的图。
- 不变量：`model-snapshot` 无差异；依赖锁定测试覆盖新依赖。
- 实测：Orca 真实终端加真实模型，让模型画一张流程图和一张时序图，日夜两个主题各一遍。

## 6. 以后：图片模式

在支持图形协议的终端（Ghostty、kitty、iTerm2）里，可以选择把图表显示成图片：Ondine 生成 SVG，resvg 转成 PNG，再用 kitty 或 iTerm2 协议显示。实测效果很好：注入 Epi 夜间主题色、用 JetBrains Mono 字体，转一张图 8–33ms。前提：

- 主题色要注入 SVG 根样式里的 `--ondine-*` 变量，再把 `var()` 替换成具体颜色（resvg 不认 CSS 变量；Ondine 自带的 `flatten` 只支持浅色）。
- 渲染是异步的，需要在排版组件里先显示文字版，图片好了再替换。
- 图片不能选中复制，tmux、ssh 里默认显示不了，所以文字模式一直保留，作为默认和退路。
- 等 Ondine 稳定（至少过了 0.0.x）再评估，避免锁定一个刚发布的依赖。

渲染接口从第一版就按「源码 + 宽度 → 若干行」设计，以后加图片模式或换别的引擎（如 D2 + TALA）只是多一种实现。
