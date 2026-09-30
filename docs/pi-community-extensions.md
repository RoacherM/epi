# Pi 社区扩展调研：MCP、子代理、联网搜索、pi-cc-extensions

日期：2026-09-14。方法：四个并行调研，只读一手来源（GitHub 仓库与 README、npm registry、pi.dev 官方目录、Pi 源码），星标与提交时间用 GitHub API 当天查询。
没读到原文的点一律标注"未验证"。
详细逐条记录保留在四份原始笔记里，本文是合并后的结论。

## 0. 先说几个名词

Pi：终端编程代理，仓库原名 badlogic/pi-mono，现为 earendil-works/pi，104,771 星，2026-09-13 仍在推送。来源 https://api.github.com/repos/earendil-works/pi
Pi package：Pi 的扩展分发单位，通过 `pi install npm:<包>`、`git:<仓库>` 或本地路径安装。来源 https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
pi.dev/packages：官方包目录，收录所有在 npm 上打了 `pi-package` 标签的包，自助登记，无审核。来源同上。
MCP：Model Context Protocol，让代理连接外部工具服务器的协议。
Monorepo：一个仓库放多个可独立安装的包。

## 1. MCP

Pi 内核不带 MCP。作者 badlogic 在 2026-01-08 的 issue 里给过一份扩展草案（读 `~/.pi/agent/mcp.json` 与 `.pi/mcp.json`，工具名 `mcp_<server>_<tool>`），随后关闭。来源 https://github.com/badlogic/pi-mono/issues/563

### pi-mcp-adapter（nicobailon）：事实标准

**已过期（2026-09-30，Pi 0.99 升级）**：MMP 当时（本文调研时）以库的方式内嵌它（package.json 里 `pi-mcp-adapter` 2.17.0，`mmp:mcp` 调 `createMcpAdapter`）；升级到 Pi 0.99 后已经整个去掉，改用 Pi 自己的原生 MCP 支持，见 [mcp-design.md](mcp-design.md)。下面这段仍是当时对 pi-mcp-adapter 本身的调研，作为第三方包的背景保留，不再代表 MMP 现在的接法。
仓库 https://github.com/nicobailon/pi-mcp-adapter ，约 1,460 星，MIT，最后提交 2026-09-13。
npm 最新 2.33.0（2026-09-10）。MMP 用的 2.17.0 落后 16 个小版本。来源 https://registry.npmjs.org/pi-mcp-adapter
官方 Discussions 里有用户说它是"我唯一持续在用的外部扩展"。来源 https://github.com/earendil-works/pi/discussions/3373

设计要点（全部来自 README https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md ）：
只注册一个约 200 token 的代理工具 `mcp`，模型用 `mcp({search})` 找工具、`mcp({tool, args})` 调用，几百个工具定义不进上下文。
服务器生命周期四种：lazy（默认，首次调用才连，空闲 10 分钟断开）、eager、keep-alive、lazy-keep-alive。工具元数据缓存到磁盘，断线也能 search。
少量常用服务器可设 `directTools: true` 直接注册。
传输：stdio、HTTP（StreamableHTTP，自动降级 SSE）、socket（配合 rmcp-mux 让多个会话共享一个服务器进程）。
鉴权：bearer 与 oauth，OAuth 支持 authorization_code 与 client_credentials，令牌进系统凭据库，无凭据库时直接失败而不是明文落盘。
输出防护：单次结果超 50 KB 或 2,000 行截断并存临时文件。
`approveTools` 用 glob 要求高风险工具人工确认。
配置查找六层，从 `~/.config/mcp/mcp.json` 到 `.pi/mcp.json`，后者覆盖前者；能导入 Claude Code 与 Agent Plugins 的 MCP 配置，但默认不自动扫描。

### 替代品（都弱于上面）

pi-mcp-extension（irahardianto）：约 7 星，最后提交 2026-05-03，stdio 与 http 与 sse，无懒加载与 OAuth（README 未提，未验证）。来源 https://github.com/irahardianto/pi-mcp-extension
doompi-mcp、@spences10/pi-mcp、@xynogen/pix-mcp：都是"Pi 发行版"里的 MCP 子模块，绑定各自发行版。配置细节未验证。来源 https://pi.dev/packages?name=mcp
context-mode（mksglu）：约 22,677 星，但方向相反，它是一个压缩其他工具输出的 MCP 服务器，可与 pi-mcp-adapter 搭配。协议 ELv2，非完全开源。来源 https://github.com/mksglu/context-mode

## 2. 子代理

所有找到的实现都是"父进程另起一个 `pi` 子进程"，没有同进程复用 AgentSession 的方案。

### 官方示例 examples/extensions/subagent

Pi 0.83.0 的 npm 包里就带着（本机解包核对）。代理是 `~/.pi/agent/agents/*.md`，可选 model 与 tools，默认只读用户级代理。
三种模式：单个、并行（最多 8 个任务，并发 4）、链式（`{previous}` 占位符）。子进程 `pi --mode json` 按行输出事件。并行时单任务输出截断到约 50 KB。
来源 https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/README.md

### tintinweb/pi-subagents：最接近 Claude Code Agent 工具

https://github.com/tintinweb/pi-subagents ，1,146 星，最后推送 2026-09-03，安装 `pi install npm:@tintinweb/pi-subagents`，要求 Pi 0.84.0 以上。
代理是 Markdown 加 YAML frontmatter，内置 general-purpose、Explore、Plan 三类。位置 `.pi/agents/`、`.agents/agents/`、`~/.pi/agent/agents/`。
后台执行是默认（并发上限 10），有 `steer_subagent` 中途插话，`get_subagent_result` 取结果，结果 JSONL 落盘（0700）。
`SubagentWorkflow` 工具允许写一段 JavaScript 用 `agent()`、`parallel()`、`pipeline()`、`phase()` 编排，跑在 `node:vm` 沙箱里。
FleetView 界面、`isolation: "worktree"`、嵌套深度上限 2。这些名字与 Claude Code 完全一致。

### 其他

mjakl/pi-subagent：77 星，要求 Pi 0.80.5 以上，也是 Markdown 加 frontmatter，子进程走 RPC 模式，1 到 8 个并发，递归深度 3，返回给模型的文本上限 50 KB 或 2,000 行。来源 https://github.com/mjakl/pi-subagent
KristjanPikhof/Pi-Agents-Team：15 星，JSON 配置七种角色，`pi --mode rpc --no-session` 工作进程，结果包在 `<final_answer>` 标签里。来源 https://github.com/KristjanPikhof/Pi-Agents-Team
harms-haus/pi-subagents：0 星，`delegate_to_subagents` 工具，并发 4。来源 https://github.com/harms-haus/pi-subagents
nicobailon/pi-messenger：708 星，不是层级委派，而是多个独立终端会话通过共享文件夹协作，有文件预定、任务依赖图（Crew），并发上限 10。来源 https://github.com/nicobailon/pi-messenger
nicobailon/pi-intercom（511 星）与 nicobailon/pi-subagents：仅见目录页引用，本次未读 README，未验证。

## 3. 联网搜索与抓取

Pi 内置工具只有 read、write、edit、bash、grep、find、ls，没有联网工具。来源 https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
这一类扩展最碎片化，同类几十个，星标从 0 到 1,400 以上。

### pi-web-access（nicobailon）：主流选择

https://github.com/nicobailon/pi-web-access ，1,433 星，MIT，最后推送 2026-09-10，npm 0.29.0。安装 `pi install npm:pi-web-access`。
零配置可用（默认走 Exa 的免费 MCP 搜索）。后端超过 30 个：OpenAI、Brave、Exa、Tavily、Firecrawl、Jina、Kagi、Perplexity、Gemini、DuckDuckGo、SearXNG 等，key 写在 `~/.pi/agent/web-search.json`。
抓取链路：Readability，失败转 PDF 转换，再转 Firecrawl，再转 Crawl4AI。
限制：单页默认 30,000 字符（上限 200,000），一次搜索最多 20 条，一次抓取最多 5 页，PDF 不做 OCR。
来源 https://raw.githubusercontent.com/nicobailon/pi-web-access/main/README.md

### 值得知道的其他路线

pi-web-search（ttttmr）：npm 1.5.0（2026-09-08），只接大模型厂商自带的服务端搜索，含 Anthropic、OpenAI Responses、Gemini URL Context、xAI，不接独立搜索商。来源 https://www.npmjs.com/package/pi-web-search
@tavily/pi-extension：Tavily 官方，0.1.2（2026-05-19），README 抓取被拦，细节未验证。来源 https://www.npmjs.com/package/@tavily/pi-extension
@ollama/pi-web-search：Ollama 官方，0.0.5（2026-03-28），走 Ollama 云搜索。来源 https://www.npmjs.com/package/@ollama/pi-web-search
@bytetrue/pi-web-search：主打零配置，Exa 免费搜索加免 key Bing 加自建 SearXNG，也接 Bocha 等国内后端。来源 https://www.npmjs.com/package/@bytetrue/pi-web-search
pi-search-hub（ronnieops）：47 星，19 个后端，RRF 排名融合，无开源协议。来源 https://github.com/ronnieops/pi-search-hub

## 4. pi-cc-extensions 与社区目录

### minuque/pi-cc-extensions

https://github.com/minuque/pi-cc-extensions ，90 星，最后推送 2026-09-13，MIT，单一 npm 包 `pi-cc-extensions`，要求 Node 22.19 以上、Pi ^0.84.0。
功能：`/ccstyle` Claude Code 风格工具卡与 rich diff（on、compact、off 三档）；Markdown 增强（Mermaid、callout、自动链接）；Fullscreen 模式；配置面板五个页签；`/context` 查看上下文占用与各部分预览；`@` 引用历史 Session 或 Subagent；CC Dark 与 CC Light 主题。
来源 https://raw.githubusercontent.com/minuque/pi-cc-extensions/main/README.md

容易混淆的项目：ilovepixelart/pi-code（21 星）直接读 `.claude` 目录的 rules、commands、skills、hooks、MCP、agents，范围比 pi-cc-extensions 广。luongnv89 的 claude-code-pi、rchern/pi-claude-cli 是把 `claude -p` 当模型后端的桥接，不是 UI 移植。

### 目录

BubblePtr/awesome-pi：120 星，2026-09-14 仍在更新，配套站 piindex.dev，按 Web 访问、MCP、子代理、UI、安全、LSP、记忆、上下文管理等分类，最勤的一份。来源 https://github.com/BubblePtr/awesome-pi
narumiruna/pi-extensions（npm @narumitw）：556 星，monorepo，至少 27 个扩展，突出的有 pi-lsp、pi-plan-mode、pi-worktree、pi-file-context、pi-statusline。来源 https://github.com/narumiruna/pi-extensions
luongnv89/pi-extensions：116 星，12 个扩展加 1 技能加 4 主题，偏模型接入与状态栏。来源 https://github.com/luongnv89/pi-extensions
HerbertGao/pi-extensions：0 星，2026-08 新建，聚合包，转发 pi-cc-extensions、sol-pi、tintinweb/pi-subagents 等并 pin 住 18 个上游版本，有每日上游监控。来源 https://github.com/HerbertGao/pi-extensions
qualisero/awesome-pi-agent：1,097 星但 README 自称已退休，2026-06 停更，不再参考。

## 5. 对 MMP 的含义

第一，0.84.0 成了新扩展的分水岭。tintinweb/pi-subagents 与 pi-cc-extensions 都要求 Pi ^0.84.0，SoL-Pi 固定 0.84.2。MMP 停在 0.83.0 会越来越装不上东西。这是升级 Pi 的第二个理由，第一个理由见 docs/sol-pi-research.md 里 OCC 的两个失败用例。

第二，MMP 的 `mmp:mcp` 已经站在正确的地基上，只是版本旧（**已过期，2026-09-30**：Pi 0.99 升级后 `mmp:mcp` 改用 Pi 原生 MCP，不再基于 pi-mcp-adapter，这一条不再适用，见 [mcp-design.md](mcp-design.md)）。pi-mcp-adapter 2.17.0 到 2.33.0 之间新增的 OAuth 凭据库、socket 传输、approveTools、Agent Plugins 导入，是否要暴露到 Manifest 需要另评估。

第三，子代理没有现成的"同进程"方案，社区一致用子进程。MMP 若要做 `mmp:agents`，可以沿用 Pi 官方示例的 `pi --mode json` 子进程模型，代理档案用 MMP 已有的 agents/*.md，这与 tintinweb 与 mjakl 的 Markdown 加 frontmatter 习惯一致。

第四，联网搜索直接用 pi-web-access，不值得自己写。它零配置能跑，后端最全，也最活跃。

第五，一个确定性问题。Pi 0.83 把 `--extension git:...` 装进 `<agentDir>/tmp/extensions/`，若 git 来源不带 `@ref`，每次启动都会 git pull 刷新，离线时跳过。MMP Manifest 声明 git 来源时应强制要求带 `@ref`，否则"未声明即不存在"的承诺在版本维度上是空的。
来源：pi-coding-agent 0.83.0 解包后 dist/core/package-manager.js 第 1019 到 1030 行、第 1566 到 1578 行，dist/utils/git.js 第 103 行（`pinned: Boolean(args.ref)`）。

## 6. 原始笔记

四份逐条笔记（含全部 URL）在 docs/notes/ 下：research-mcp.md、research-subagents.md、research-websearch.md、research-cc-catalogs.md。
