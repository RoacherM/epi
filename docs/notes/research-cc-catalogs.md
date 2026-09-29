# Pi 编程智能体扩展生态调研（pi-cc-extensions 与社区目录）

调研时间：2026-09-14。数据来自 GitHub API（gh api）、npm registry、以及各仓库的 README 原文，未参考第三方博客总结。

## 名词说明

- Pi：由 earendil-works（原作者 Mario Zechner，GitHub 用户名 badlogic）开发的终端 AI 编程智能体（coding agent）框架。仓库地址 https://github.com/earendil-works/pi
- pi-mono：Pi 仓库的旧名字。npm 包 @earendil-works/pi-coding-agent 的 homepage 字段目前仍写着 github.com/earendil-works/pi-mono#readme，说明仓库确实经历过改名，从 pi-mono 改成了现在的 pi。来源 https://registry.npmjs.org/@earendil-works/pi-coding-agent
- Extension（扩展）：一段 TypeScript 代码，可以给 Pi 注册新命令、新工具、修改系统提示词、拦截事件等，通常打包成 npm 包或 git 仓库分发。
- pi install：Pi 自带的包管理命令，支持 npm:包名、git:仓库地址、本地路径三种来源。安装后一般要执行 /reload 才生效。
- Monorepo（单仓多包）：一个 Git 仓库里放多个可以独立安装的扩展包，和"一个仓库只发布一个包"的单包模式相对。

## earendil-works/pi 本体现状（背景数据）

- 当前仓库名 earendil-works/pi，是一个 monorepo，包含 pi-coding-agent（命令行主程序）、pi-agent-core、pi-ai、pi-tui、chord、pi-telemetry 等子包。来源 https://github.com/earendil-works/pi
- Star 数 104771，Fork 数 13150（gh api 实时查询）。来源 https://api.github.com/repos/earendil-works/pi
- 最近一次 push 时间为 2026-09-13T21:26:54Z，仓库处于活跃维护状态。来源同上。

## 第一部分：pi-cc-extensions 及同类项目

### 主项目：minuque/pi-cc-extensions

- 仓库地址 https://github.com/minuque/pi-cc-extensions
- 作者是 GitHub 用户 minuque。来源 https://api.github.com/repos/minuque/pi-cc-extensions
- Star 数 90，Fork 数 17（gh api 实时查询，2026-09-14）。来源同上。
- 最近一次 push 时间为 2026-09-13T10:16:57Z，即调研前一天，属于活跃维护。来源同上。
- 组织方式：单一 npm 包，不是 monorepo。包内部按功能拆成多个源文件（早期版本 0.1.x 分三个入口 claude-code-style.ts、context.ts、session-reference/index.ts，最新版 0.8.70 合并成一个 extensions/index.ts 入口）。来源 https://registry.npmjs.org/pi-cc-extensions
- 安装方式：`pi install npm:pi-cc-extensions`，或 `pi install git:github.com/minuque/pi-cc-extensions`，装完要执行 `/reload`。来源 https://raw.githubusercontent.com/minuque/pi-cc-extensions/main/README.md
- 兼容性要求 Node.js ≥22.19.0，Pi ^0.84.0，License 为 MIT。来源同上。
- 包含的功能（README 原文按功能列出，逐条对应一个入口命令或自动生效）：
  - Claude Code UI（命令 `/ccstyle`）：工具调用摘要、折叠展开、rich diff（edit/write 的富文本对比视图），提供 on/compact/off 三种显示模式。
  - Markdown 增强：自动生效，支持 Mermaid 图、提示框（callout）、URL 自动转链接。
  - Fullscreen 模式（`TUIMODE=fullscreen` 或 `--tui-mode fullscreen`）：工具卡/分组可单击展开双击收起，带预览和 hover 高亮，以及回到底部按钮。
  - 配置面板（`/ccstyle`）：Style、Diff、Thinking、UI、Feature 五个页签。
  - 上下文检查（`/context`）：查看上下文占用比例，预览 system prompt、memory、skills、tool definitions 和消息内容。
  - Session/Subagent 引用（`@` 触发）：搜索并把历史 Session 或已有 Subagent 的上下文注入当前对话。
  - 主题：内置 CC Dark、CC Light 两套 Claude Code 风格主题，用 `/theme` 切换。
  - 来源（以上全部）https://raw.githubusercontent.com/minuque/pi-cc-extensions/main/README.md
- 该项目 README 里还列出"推荐搭配"的其它扩展（@tintinweb/pi-subagents、@tintinweb/pi-tasks、pi-mcp-adapter、@ff-labs/pi-fff、pi-web-access、@narumitw/pi-usage、ponytail），这些是作者推荐的互补包，不属于本项目自身内容。来源同上。

### 容易和 pi-cc-extensions 混淆但目的不同的项目

- ilovepixelart/pi-code：Star 21，最近 push 2026-09-10。它不是单纯的 UI 风格移植，而是直接读取用户 `.claude` 目录下的配置（rules、commands、skills、hooks、output styles、MCP、agents），并额外加上 todo、checkpoint、memory、web 搜索、subagent 能力，覆盖范围比 pi-cc-extensions 更广。来源 https://api.github.com/repos/ilovepixelart/pi-code
- luongnv89/pi-extensions 目录里有个叫 claude-code-pi 的子扩展，名字带 "claude-code" 但功能是把本地 `claude -p` 命令桥接成 Pi 的模型提供方（可以在 Pi 里选用 sonnet/opus），并不是 Claude Code 界面或工作流特性的移植，容易望文生义搞混，详情见第二部分。来源 https://raw.githubusercontent.com/luongnv89/pi-extensions/main/README.md
- rchern/pi-claude-cli 和 agustinsacco/pi-claude-cli：搜索结果显示两者描述几乎相同，都是"通过 Claude Code CLI 路由 LLM 调用"的扩展，同样是模型桥接类型而非 UI 移植；未逐一核实 star 数和最近提交时间，标记为未验证。
- slipros/pi-plugin-cc：描述为"把任务和代码审查委托给 Pi 能访问的任意模型，可按次选模型和系统提示词"，也不是 Claude Code UI/工作流移植；具体仓库数据未核实，标记为未验证。

### 官方仓库自带的对照示例（不是独立扩展项目，但同属"把 Claude Code 特性搬进 Pi"）

- earendil-works/pi 仓库自己的 examples/extensions 目录里有 plan-mode（Claude Code 风格的只读 `/plan` 探索与步骤跟踪）、todo.ts（待办列表工具 + `/todos` 命令）、claude-rules.ts（扫描 `.claude/rules/` 目录并列进系统提示词）。这些是官方示例代码，用来教开发者怎么写扩展，本身不是一个可独立安装的"pi-cc-extensions 项目"。来源 https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/README.md

## 第二部分：Pi 扩展的社区目录 / 收藏

### luongnv89/pi-extensions

- 仓库地址 https://github.com/luongnv89/pi-extensions
- 维护者 luongnv89，Star 116，最近 push 2026-09-11。来源 https://api.github.com/repos/luongnv89/pi-extensions
- 组织方式：monorepo，README 原文写明包含"12 个扩展、1 个技能（skill）、4 个主题"。来源 https://raw.githubusercontent.com/luongnv89/pi-extensions/main/README.md
- 按用途分四类：模型接入（claude-code-pi、grok-pi、opencode-pi、agy-pi、cursor-pi、9router-pi）、状态栏/UI（statusline-pi、timestamp-pi、subagents-pi）、工具自动化（advisor-pi、cache-warm、model-debugger）、技能和主题。来源同上。
- 挑 5 个对编程工作流最有用的：
  - statusline-pi：底部状态栏显示 git 分支、PR、上下文占用、tok/s、花费、CPU/内存。
  - claude-code-pi：把本地 `claude -p` 接入 Pi 作为可选模型（sonnet/opus）。
  - advisor-pi：新增 advisor 工具，向更强模型请求策略建议。
  - model-debugger：记录所有模型请求/响应，方便调试 provider 问题。
  - opencode-pi：免费接入 OpenCode CLI 模型，无需登录。
  - 来源同上。
- 安装方式：单个扩展 `pi install npm:<name>`；也提供一键脚本 `curl -fsSL https://raw.githubusercontent.com/luongnv89/pi-extensions/main/install.sh | bash -s -- --auto` 装全部扩展+主题+技能。来源同上。

### narumiruna/pi-extensions（npm 作用域 @narumitw）

- 仓库地址 https://github.com/narumiruna/pi-extensions
- 维护者 narumiruna（npm 用户名 narumitw），Star 556，最近 push 2026-09-13。来源 https://api.github.com/repos/narumiruna/pi-extensions
- 组织方式：monorepo，README 明确写"独立可安装的扩展和可复用扩展库"。按我实际数出来的条目，至少有 27 个独立扩展，分布在编码与委派、浏览器与调研、任务与工作流、本地协作、账号与数据、状态与可观测性六大类，另外有 1 个供二次开发用的组件库 pi-tui-kit；因为 README 很长，这个数字不保证是全部，只是我看到部分的统计。来源 https://raw.githubusercontent.com/narumiruna/pi-extensions/main/README.md
- 挑 5 个对编程工作流最有用的：
  - pi-lsp：跨 JavaScript/TypeScript/Python/Rust/Go 等多语言的 LSP 诊断和代码修复建议。
  - pi-plan-mode：仿 Codex 的只读 `/plan` 协作模式，动手改代码前先规划。
  - pi-file-context：浏览项目文件、预览文本或 git diff 片段，精确摘取后附加到下一条 prompt。
  - pi-worktree：交互式创建/切换/删除 git worktree，并把 Pi 会话带到新的工作区。
  - pi-statusline：状态栏显示模型、工具、git 状态、上下文用量、token、花费和时间。
  - 来源同上。
- 安装方式：单个扩展 `pi install npm:@narumitw/<name>`；也可以 `pi install git:github.com/narumiruna/pi-extensions` 装整个仓库（仓库根目录的 manifest 列出了所有扩展）。来源同上。

### HerbertGao/pi-extensions（npm 作用域 @herbertgao）

- 仓库地址 https://github.com/HerbertGao/pi-extensions，默认分支是 master。来源 https://raw.githubusercontent.com/HerbertGao/pi-extensions/master/README.md
- 维护者 HerbertGao，Star 数 0（gh api 查询，仓库创建于 2026-08-05，比较新），最近 push 2026-09-12。来源 https://api.github.com/repos/HerbertGao/pi-extensions
- 组织方式：一个"聚合安装包"，自己维护 5 个包（pi-bark、pi-cc-extensions 转发包、sol-pi 转发包、resume-from 转发包、pi-subagents 转发包），再 pin 住 18 个上游第三方包版本一起打进一个安装单元。值得注意的是，它把本报告第一部分的 minuque/pi-cc-extensions 重新打包成了 `@herbertgao/pi-cc-extensions`，说明 pi-cc-extensions 已经被至少一个社区目录收录转发。来源同上。
- 安装方式：`pi install npm:@herbertgao/pi-extensions` 一次装完整个聚合包。来源同上。

### BubblePtr/awesome-pi（Awesome 列表，非代码仓库）

- 仓库地址 https://github.com/BubblePtr/awesome-pi，配套网站 https://piindex.dev
- 维护者 BubblePtr，Star 120，最近 push 时间是 2026-09-14（调研当天），是我查到的几个 awesome 列表里更新最勤的一个。来源 https://api.github.com/repos/BubblePtr/awesome-pi
- 组织方式：不是扩展代码仓库，是分类索引，按 Web 访问与搜索、MCP 适配、子代理、UI 增强、安全与权限、开发工具与代码智能、持久记忆、上下文管理、循环工程、代码审查、任务管理、Plan 模式、后台任务、浏览器自动化、Web UI 等类别收录第三方包，条目前的 🔥 表示作者推荐/常用，不代表 Pi 官方认证。来源 https://raw.githubusercontent.com/BubblePtr/awesome-pi/main/README.md
- README 里徽章写"Packages 5500+"，指向整个 pi.dev/packages 生态规模，不是这份列表自己收录的条目数，具体 5500+ 这个数字我没有逐一核实，标记未验证。来源同上。
- 挑 5 个对编程工作流最有用的（跨类别）：
  - pi-lsp：实时代码反馈，LSP、linter、formatter、类型检查、结构分析。
  - @narumitw/pi-plan-mode：Codex 风格只读 `/plan`，先探索澄清再改代码。
  - pi-mcp-adapter（作者 nicobailon）：把上百个 MCP 工具定义压缩成约 200 token 的代理工具，按需发现。
  - pi-web-access（作者 nicobailon）：网页搜索、URL 抓取、GitHub 克隆、PDF 提取、YouTube 视频理解，零配置带智能降级链。
  - @tintinweb/pi-subagents：Claude Code 风格子代理，支持并行后台代理、实时 widget、git worktree 隔离。
  - 来源同上。
- 安装方式：每条目各自给出 `pi install npm:<name>` 或 `pi install git:<repo>` 命令，这份列表本身没有一键批量安装脚本。来源同上。

### 关于"nicobailon 的收藏"

- 核实下来 nicobailon 本人并没有维护一个叫"pi-extensions"之类的目录仓库，而是分别独立维护三个很受欢迎的单体扩展：pi-web-access（网页访问）、pi-mcp-adapter（MCP 适配）、pi-subagents（异步子代理委派），各自单独开仓库发布。来源 https://github.com/nicobailon/pi-mcp-adapter 、 https://github.com/nicobailon/pi-subagents
- 这三个包被 BubblePtr/awesome-pi 等多个目录反复引用，属于生态里公认好用的组件，但它们本身不构成"目录/收藏"这个类别，任务里提到的"nicobailon's collection"更准确的说法是"nicobailon 维护的几个高知名度独立扩展"。

### 官方包目录 pi.dev/packages

- 官方文档提到有一个"package gallery"，网址 https://pi.dev/packages，收录所有在 npm 上打了 `pi-package` 关键字标签的包，属于自助登记，不代表经过 Pi 官方审核或背书。来源 https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/packages.md
- `pi install` 支持三种来源：npm（`pi install npm:@scope/name@version`）、git（`pi install git:github.com/user/repo@ref`）、本地路径（`pi install /path/to/pkg`）。来源同上。

### 已过期/价值有限的目录（供排除参考）

- qualisero/awesome-pi-agent：Star 1097 看起来很显眼，但仓库 README 原文直接写"现在已经过时，被更专门的项目取代，是时候退休了"（大意），最近一次 push 是 2026-06-03，属于停止维护状态，不建议再参考。来源 https://raw.githubusercontent.com/qualisero/awesome-pi-agent/main/README.md
- Traveler0014/awesome-pi-agent：Star 只有 1，描述简单地写"a way to use pi coding agent"，内容单薄，判断为个人练习性质的仓库，未详细统计条目，标记未验证。来源 https://api.github.com/repos/Traveler0014/awesome-pi-agent

