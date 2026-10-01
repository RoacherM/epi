# Pi 编程智能体的 Web Search / Web Fetch 社区扩展调研

调研时间：2026-09-14。方法：GitHub API（gh）、npm registry、pi.dev 官方站点、GitHub README 原文。未看博客二手总结。

## 背景概念

- "Pi" 是一个终端编程智能体（coding agent），代码仓库原名 pi-mono，作者 badlogic，现归属组织 earendil-works。仓库地址 https://github.com/earendil-works/pi
- npm 主包是 `@earendil-works/pi-coding-agent`，包详情页 https://www.npmjs.com/package/@earendil-works/pi-coding-agent
- Pi 官方文档站是 pi.dev，其中 https://pi.dev/packages 是官方的第三方包（扩展）目录，可按名称搜索，例如加 `?name=web+search` 参数筛选。
- "扩展"（extension）在 Pi 里也叫 "Pi package"，通过 npm 或 git 分发，用命令 `pi install npm:<包名>` 安装。
- 扩展通过调用 `pi.registerTool()` API 给模型注册新工具（名字、参数 schema、`execute()` 执行函数），这是 Pi 唯一的加工具方式。来源：https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- Pi 官方安全提示：Pi package 拥有完整系统权限，扩展可以执行任意代码，安装第三方包前应先看源码。来源：https://www.npmjs.com/package/@earendil-works/pi-coding-agent

## Pi 是否自带 web search / web fetch

- 不自带。根据 extensions.md 原文，Pi 核心内置工具只有 `read`、`write`、`edit`、`bash`（Windows 下是 `powershell`）、`grep`、`find`、`ls`，全部是本地文件/命令类工具，没有联网能力。来源：https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- 该文档里唯一出现"联网"字样的例子，只是演示如何在工具回调里用 `fetch()` 发起一次可被 Esc 取消的 HTTP 请求，不是一个完整的搜索工具，只是写代码模式的示范。来源同上。
- 结论：web search / web fetch 完全依赖社区第三方扩展，官方不提供开箱即用的搜索工具。

## 聚合列表（第三方，非官方，但是一手资料）

- pi.dev 官方包目录，可以搜"web search"关键词看到社区提交的所有相关包：https://pi.dev/packages?name=web+search
- awesome-pi（作者 BubblePtr）：GitHub 星标 120，最近一次推送 2026-09-14，是一个人工维护的分类清单。地址 https://github.com/BubblePtr/awesome-pi
- awesome-pi-agent（作者 qualisero）：GitHub 星标 1097，最近推送 2026-06-03。地址 https://github.com/qualisero/awesome-pi-agent
- awesome-pi.site 的 extensions 页面单独有一个 web 搜索/抓取分类，列出了十几个扩展。地址 https://awesome-pi.site/extensions/
- narumiruna/pi-extensions 是一个 monorepo（一个仓库放多个包），星标 556，最近推送 2026-09-13。地址 https://github.com/narumiruna/pi-extensions
- HerbertGao/pi-extensions 是另一个人维护的扩展合集仓库，会把上游包（包括 pi-web-access）打包到一起分发，星标 0，最近推送 2026-09-12。地址 https://github.com/HerbertGao/pi-extensions

## 逐个扩展的记录

### pi-web-access（作者 nicobailon，npm 发布账号 nicopreme）— 目前最主流的一个

- 仓库：https://github.com/nicobailon/pi-web-access ，星标 1433，最近推送 2026-09-10，MIT 协议。
- npm 包名就是 `pi-web-access`，最新版本 0.29.0，发布于 2026-09-10。地址 https://www.npmjs.com/package/pi-web-access
- 安装方式：`pi install npm:pi-web-access`。零配置也能用（默认走 Exa 的 MCP 免费搜索）。来源：README https://raw.githubusercontent.com/nicobailon/pi-web-access/main/README.md
- 支持的搜索后端很多，超过 30 个，包括 OpenAI、Brave、Exa、Tavily、Firecrawl、Jina、Kagi、Perplexity、Gemini、Mistral、xAI/Grok、DuckDuckGo、SearXNG，还支持自建（self-hosted）搜索端点。来源同上 README。
- API key 需求：默认用的 Exa MCP 不需要 key；如果登录了 Pi 自带的 Codex 账号，OpenAI 搜索可以复用那个登录态不用单独 key；其余大部分供应商（OpenAI 直连、Brave、Kagi、Gemini 等）要自己配 key，写在 `~/.pi/agent/web-search.json` 里；xAI、Mistral、SerpApi 这几个必须手动选中才会启用，不会被自动挑选。
- 会做"抓取 + 可读性提取"（fetch + readability）：提取链路是 Readability 优先 → 失败转 PDF 转换 → 再失败转 Firecrawl → 再失败转 Crawl4AI → 最后兜底走第三方托管服务。"Readability"是 Mozilla 开源的正文提取算法，Firecrawl 和 Crawl4AI 都是把网页抓取转成干净 Markdown 的第三方服务/工具。
- 输出长度限制：单页内联文本默认最多 30000 字符，可调但上限 200000 字符；PDF 默认限 20MB，最大放宽到 50MB；一次搜索最多返回 20 条来源；一次抓取最多处理 5 个页面。
- 已知限制：无头浏览器（headless browser）在 Docker 等无图形环境里可能失败，会退化成只打印链接；YouTube 年龄限制视频可能提取不到内容；用 Gemini 分析视频最长约 1 小时，超出会被截断；PDF 只提取文字，不做 OCR，扫描件读不出来；GitHub 分支名里带斜杠时路径可能解析错。
- ivanreeve/pi-web-access 是另一个同名同描述的仓库，星标 0，很可能是 fork 或复制品，两者关系未验证。地址 https://github.com/ivanreeve/pi-web-access

### @tavily/pi-extension — Tavily 官方扩展

- Tavily 是一家专做"给 AI 用的搜索 API"的公司。这是它官方发布的 Pi 扩展。npm 页面 https://www.npmjs.com/package/@tavily/pi-extension
- 最新版本 0.1.2，发布于 2026-05-19。维护者账号（如 konstantintzt、guyhartstein 等）看起来都是 Tavily 内部团队成员。
- Tavily 官方文档也单独写了 Pi 集成页面：https://docs.tavily.com/documentation/integrations/pi
- 因为是官方厂商扩展，大概率必须配置 Tavily 自己的 API key 才能用；具体是否有免费额度、是否支持 fetch 提取正文、有无输出长度限制，README 页面抓取被 403 拦截，没能看到原文，标记为未验证。

### @ollama/pi-web-search — Ollama 官方扩展

- Ollama 是一个本地运行大模型的工具/公司。npm 页面 https://www.npmjs.com/package/@ollama/pi-web-search
- 最新版本 0.0.5，发布于 2026-03-28。维护者包含 jmorgan、mchiang0610，这两个账号是 Ollama 的联合创始人，说明这是官方包。
- 描述写明：用的是"Ollama 自己的 web search 和 web fetch API"，也就是 Ollama 云端提供的搜索服务，不是 Brave/Tavily 这类第三方。
- 是否需要单独申请 key、有没有输出限制，未能拿到 README 原文，标记为未验证。

### pi-web-search（作者 ttttmr）— 走"厂商自带的服务端搜索"路线

- npm 包 https://www.npmjs.com/package/pi-web-search ，最新版本 1.5.0，发布于 2026-09-08，非常新。
- 描述是"provider-native web search"，意思是不接 Brave/Tavily 这类独立搜索 API，而是直接用大模型厂商自己内置的联网搜索能力：Gemini 的 URL Context 功能、xAI 的 Grok、OpenAI Responses 接口（含 Azure/Codex/Copilot 几种接入方式）、以及 Anthropic。
- 这是目前发现的唯一一个明确说"用 Anthropic 官方服务端 web search"的 Pi 扩展。是否需要各家自己的 API key，未细看，标记未验证。
- 按 pi.dev 包目录页面显示的月下载量约 1.72 万/月，此数字来自网页渲染快照，未做二次核实，标记未验证。来源 https://pi.dev/packages?name=web+search

### @juicesharp/rpiv-web-tools（作者 juicesharp）

- npm 包 https://www.npmjs.com/package/@juicesharp/rpiv-web-tools ，最新版本 2.10.1，发布于 2026-09-13，更新非常活跃。
- 支持的后端有 Brave、Tavily、Serper、Exa、You.com、Jina、Firecrawl、Perplexity、SearXNG、Ollama，走"可插拔供应商"设计，即用户自己选一个配 key。
- 具体 key 要求、是否做正文提取、输出限制未细读，标记未验证。

### pi-webaio（作者 apmantza）

- npm 包 https://www.npmjs.com/package/pi-webaio ，最新版本 1.0.6，发布于 2026-09-07。
- 搜索支持 Google、Brave、DuckDuckGo、TinyFish、FireCrawl；抓取部分带无头浏览器 + AI 摘要功能，还有 TinyFish Fetch 和 FireCrawl 的免 key 抓取模式。
- 其余细节未验证。

### @bytetrue/pi-web-search（作者 bytetrue）

- npm 包 https://www.npmjs.com/package/@bytetrue/pi-web-search ，最新版本 0.4.0，发布于 2026-08-28。
- 卖点是"零配置"：默认走 Exa 的 MCP 免费搜索，加上不用 key 的 Bing 搜索、可自建的 SearXNG（一个开源的聚合搜索引擎，可以自己部署，不依赖任何商业 API）；也支持插拔式接入 Bocha（一个国内搜索 API）、Tavily、Exa、Brave、Jina、Firecrawl 这些需要 key 的后端。
- 细节未验证。

### @counterposition/pi-web-search（作者 harishkukreja）

- npm 包 https://www.npmjs.com/package/@counterposition/pi-web-search ，最新版本 0.5.3，发布于 2026-08-23。
- 设计是把 Brave、Tavily、Exa 三个后端统一到一个接口后面，按每次请求的能力自动挑一个可用的，失败了自动切换到下一个（fallback）。
- 细节未验证。

### pi-web-lite（作者 YoungJurry，npm 账号 youngjurry）

- 仓库 https://github.com/YoungJurry/pi-web-lite ，星标 1，最近推送 2026-08-26。
- npm 包 https://www.npmjs.com/package/pi-web-lite ，最新版本 0.1.6，发布于 2026-08-30。
- 支持 Exa、Tavily、Brave，还有 Doubao（字节跳动"豆包"的搜索能力），带路由选择和失败切换（failover），作者说带了测试用例。
- 属于小众/个人项目，星标很少，活跃度和可靠性未验证。

### pi-search-hub（作者 ronnieops）

- 仓库 https://github.com/ronnieops/pi-search-hub ，星标 47，最近推送 2026-07-24，没有开源协议声明（license 为空）。
- 描述里说支持多达 19 个后端，包括 DuckDuckGo、Jina、Tavily、Brave、Exa、Serper、Firecrawl、Marginalia（一个小众独立搜索引擎）、LangSearch、WebSearchAPI、Perplexity Sonar、SearXNG。
- 特点是有 RRF 合并模式（RRF 全称 Reciprocal Rank Fusion，一种把多个搜索引擎结果按排名加权合并去重的算法），以及一个独立的 web_read 抓取工具（可插拔 Jina/Sofya/Firecrawl/Exa 做正文提取）。
- 是否发布到 npm、如何安装，未在 npm registry 查到对应包，标记未验证。

### Michaelliv/pi-websearch（作者 Michaelliv）

- 仓库 https://github.com/Michaelliv/pi-websearch ，星标 48，最近推送 2026-06-10，没有开源协议声明。
- 支持 12 个供应商，用路由器按 Parallel、Brave、Exa、You.com、Tavily 等顺序检测谁配了 key 就用谁。
- 是否发布到 npm 未核实，标记未验证。

### awesome-pi.site 收录的其他 web 类扩展（未逐个深挖，仅记录描述）

- @narumitw/pi-firecrawl：只做 Firecrawl 的网页抓取/爬取功能，是 narumiruna/pi-extensions 这个 monorepo 里的一个子包。
- @danypops/pi-web-spider：号称支持 7 个搜索供应商——Brave、Brave 的 LLM Context 模式、Tavily、Exa、Serper、SerpApi、You.com。
- pi-anysearch-tools：描述是"主动式 AnySearch 网络访问"，具体机制未细看。
- pi-smart-fetch：卖点是"桌面浏览器 TLS 指纹伪装" + defuddle 提取。TLS 指纹伪装是指让请求看起来像真实 Chrome 浏览器发出的，用来绕过某些网站的反爬虫检测；defuddle 是另一个类似 Readability 的正文提取库。
- pi-unsloth-webtools：说是从 Unsloth（一个做模型微调工具的团队）那边"移植"过来的，用 DuckDuckGo 搜索，抓取时做了 SSRF 防护（防止服务器被诱导访问内网地址的安全措施），输出做 HTML 转 Markdown。
- pi-search-on-your-browser：不是调 API，而是操控一个用户真实可见的 Chrome 窗口去搜 Google，并且能读 X（原 Twitter）、Reddit、Amazon、Google Scholar 的页面内容。
- pi-deepseek-web-search 和 pi-deepseek-search：用 DeepSeek 大模型自带的服务端搜索能力，不接第三方搜索 API。
- 以上这些均只看到 awesome-pi.site 页面的一行描述，没有逐个进仓库核实 star 数、最后提交时间、安装方式，全部标记未验证。来源 https://awesome-pi.site/extensions/

### 其他相关仓库

- hyav/pi-search：描述是"LLM 路由的网页搜索和正文提取扩展"，即用大模型自己决定调哪个后端；号称内置 9 个供应商。地址 https://github.com/hyav/pi-search ，MIT 协议，最近推送 2026-09-05。星标未记录（搜索结果未给出），标记未验证。
- itc-steve/pi-web-complete：一个扩展里塞了三个工具——多后端 web_search、本地化的 web_read（按查询做相关片段排序摘录）、以及 web_cowork（可以理解成人和智能体共享同一个浏览器会话来协作操作网页）。地址 https://github.com/itc-steve/pi-web-complete ，MIT 协议，最近推送 2026-08-31。

## 10 行摘要

1. Pi（原 pi-mono，现 earendil-works/pi）核心只内置文件和命令行工具，官方原生不带任何联网搜索/抓取工具，这点在官方 extensions.md 文档里明确验证过。
2. 联网能力全部来自社区第三方"扩展"（Pi package），通过 `pi install npm:<包名>` 安装，扩展用 `pi.registerTool()` 给模型加工具。
3. 目前最主流的是 nicobailon/pi-web-access（GitHub 1433 星），支持 30 多个搜索后端，默认零配置用 Exa 免费搜索，还做 Readability/Firecrawl/Crawl4AI 多级正文提取。
4. 官方厂商也下场发过扩展：Tavily 出了 @tavily/pi-extension，Ollama 出了 @ollama/pi-web-search（用 Ollama 自己的云搜索 API）。
5. 有一支扩展（ttttmr 的 pi-web-search）专门只接大模型厂商自带的服务端搜索，包括 Anthropic 和 OpenAI，不接 Brave/Tavily 这类独立搜索商。
6. 常见的搜索后端选项覆盖 Brave、Tavily、Exa、Perplexity、DuckDuckGo、SearXNG（可自建）、Kagi、Jina、Firecrawl、Serper、You.com、SerpApi 等，绝大多数需要自己申请并配置 API key。
7. 少数扩展主打"零配置"或"免 key"，比如靠 Exa 的 MCP 免费搜索、免 key 的 Bing、或者可自建不花钱的 SearXNG。
8. 多数扩展会做"抓取网页 + 提取正文"，常用 Readability 或 defuddle 这类提取库，遇到失败再退化到 Firecrawl/Crawl4AI 等第三方抓取服务。
9. 输出体积普遍会做截断限制，以 pi-web-access 为例，单页默认 3 万字符、最高放宽到 20 万字符，一次搜索最多返回 20 条结果。
10. 生态非常碎片化，几十个同类扩展同时存在，质量差异很大，星标从 0 到 1400+ 都有，安装前务必按官方安全提示先读源码，因为扩展在 Pi 里拥有完整系统权限。
