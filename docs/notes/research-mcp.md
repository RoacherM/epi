# Pi 编程 Agent 的 MCP 扩展调研

调研时间：2026-09-14。只读取一手来源：GitHub 仓库、npm registry、GitHub Discussions/Issue 原文。

## 名词解释

- Pi：一个开源的编程 Agent（coding agent），仓库最早叫 `badlogic/pi-mono`，现已改名为 `earendil-works/pi`。参见 https://github.com/earendil-works/pi
- MCP（Model Context Protocol）：一种让 AI Agent 连接外部工具服务器（数据库、浏览器、API 等）的协议标准。参见 https://modelcontextprotocol.io/
- npm 包 `@earendil-works/pi-coding-agent`：Pi 的官方 CLI 发行包。参见 https://www.npmjs.com/package/@earendil-works/pi-coding-agent
- pi-mcp-adapter：一个第三方 npm 包，给 Pi 加上 MCP 客户端能力，用户项目中用的就是这个包的 2.17.0 版本。
- stdio 传输：MCP 服务器作为本地子进程运行，通过标准输入输出通信。
- HTTP/streamable-http 传输：MCP 服务器是远程 HTTP 服务，Pi 通过网络请求调用。
- OAuth：一种授权协议，让 Pi 代表用户去访问需要登录的远程 MCP 服务器。
- 懒加载（lazy loading）/ tool search：不在启动时就把所有工具的说明塞进上下文，而是等真正要用某个工具时才加载它的定义，平时只留一个很小的"代理工具"占位。

## Pi 本身对 MCP 的态度

- Pi 核心不自带 MCP 支持，官方文档鼓励要么写简单的 CLI 工具（附带 README 让 Agent 按需读取），要么自己写一个扩展来加 MCP。参见 https://lucumr.pocoo.org/2026/1/31/pi/
- 2026 年 1 月 8 日，Pi 作者 badlogic 在 issue 中提出过一个"MCP 扩展示例"的设计草案：配置读取 `~/.pi/agent/mcp.json` 和 `<cwd>/.pi/mcp.json`，用 MCP TypeScript SDK 支持 stdio 和 SSE 两种传输，工具名按 `mcp_<server-name>_<toolname>` 命名，并提供 `/mcp` 命令查看和启停服务器。这个 issue 已关闭。参见 https://github.com/badlogic/pi-mono/issues/563
- 在 Pi 官方 Discussions 里，有用户被问到"你最常用的第三方扩展是什么"，回答是"我现在唯一持续在用的外部扩展就是 pi-mcp-adapter"。参见 https://github.com/earendil-works/pi/discussions/3373

## pi-mcp-adapter 详情

- 真正的源代码仓库是 https://github.com/nicobailon/pi-mcp-adapter ，不是 fork（用 `gh api` 核实过 `fork: false`）。
- 作者：Nico Bailon（npm 上的用户名是 nicopreme，邮箱 nico.bailon@gmail.com）。仓库许可证是 MIT。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/LICENSE
- GitHub star 数：约 1460（用 `gh api repos/nicobailon/pi-mcp-adapter` 查询所得，调研当天数字）。
- 最后一次提交：2026-09-13 20:04 UTC，是 PR #572，内容是修复 Agent Plugin 的边界问题，提交经过 GPG 签名验证。参见 https://github.com/nicobailon/pi-mcp-adapter/commit/23c28529083a369f704d036fb8231c590f41ea80
- npm registry 上最新版本是 2.33.0，发布于 2026-09-10。用户项目里用的 2.17.0 已经落后很多个小版本，说明这个包更新非常频繁。参见 https://registry.npmjs.org/pi-mcp-adapter
- npm 页面显示月下载量约 939.7K（由 pi.dev 的包页面聚合展示）。参见 https://pi.dev/packages?name=mcp
- 有第三方桥接项目 pi2dsh，声称可以让 pi-mcp-adapter 不改代码直接跑在"DeepSeek Harness"（DSH，另一个 agent 运行时）上。参见 https://github.com/weijiafu14/pi2dsh

### 安装方式

- `pi install npm:pi-mcp-adapter`，装完需要重启 Pi。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md

### 配置文件位置和优先级（后面的覆盖前面的）

- `~/.config/mcp/mcp.json`（用户级，跨工具通用的 MCP 标准位置）
- `~/.agents/mcp.json`
- `~/.agents/mcp/mcp.json`
- Pi 自己的全局覆盖文件，默认是 `~/.pi/agent/mcp.json`
- 项目级共享文件 `.mcp.json`
- 项目级 Pi 专属覆盖文件 `.pi/mcp.json`
- 以上均来自 README 原文。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- 配置文件格式沿用 MCP 生态里通用的 `mcpServers` 对象结构，和 Claude Code、Cursor 等工具的 `.mcp.json` 格式兼容；`/mcp setup` 命令可以把这些"host-specific"配置导入进来，但默认不会自动扫描它们（`hostConfigDiscovery` 默认是 `off`）。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md

### 传输方式

- 支持 stdio（配置 `command` + `args`，本地子进程）。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- 支持 HTTP（配置 `url`，用 StreamableHTTP，失败时自动降级到旧版 SSE）。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- 还支持一种叫 `socket` 的方式，指向 `rmcp-mux` 建的 Unix domain socket，用来让多个 Pi 会话共享同一个 MCP 服务器进程。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md 和 https://github.com/VetCoders/rmcp-mux

### 懒加载 / tool search 设计

- 核心卖点是"省上下文"：不注册几百个工具定义，只注册一个约 200 token 的代理工具 `mcp`，Agent 通过 `mcp({ search: "关键词" })` 按需搜索、发现真正要用的工具，再用 `mcp({ tool: "工具名", args: {...} })` 调用。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- 服务器默认是"懒"的（`lifecycle: "lazy"`）：启动时不连接，第一次真正调用工具时才连接，空闲一段时间（默认 10 分钟，可配置）后自动断开；工具的元数据会缓存到磁盘，所以断线状态下 `search`/`list`/`describe` 依然能用。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- 除了 `lazy`，还有 `eager`（启动即连接，但不自动重连）、`keep-alive`（启动即连接并保持，定期刷新工具目录）、`lazy-keep-alive`（第一次用时才连，之后常驻）四种生命周期模式。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- 也可以把某个服务器的工具设成 `directTools: true`，跳过代理工具、直接把每个工具单独注册给 Pi（适合工具很少、常用的服务器）。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md

### OAuth 支持

- 支持 `"bearer"` 和 `"oauth"` 两种鉴权方式。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- OAuth 支持 `authorization_code`（默认，交互式浏览器授权）和 `client_credentials`（非交互式机器对机器授权）两种授权类型，支持预注册 client id，也支持在服务器允许时自动做 Dynamic Client Registration（动态客户端注册）。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- OAuth 令牌保存在操作系统的凭据存储里（比如 macOS 钥匙串），按服务器名 + URL 绑定，不是明文文件；如果本机没有可用的凭据存储，它会直接失败而不是退化成明文保存。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- 对于远程/无图形界面的 Pi（比如跑在服务器上），提供手动粘贴回调 URL 的授权流程作为兜底。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md

### 其他值得注意的设计

- 有"输出防护"（Output Guard）：单次工具调用返回的文本超过 50KB/2000 行会被截断并存成临时文件，图片类内容不受影响，避免一次调用打爆上下文或撑爆会话存档。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- 支持工具级别的"审批"（`approveTools`），可以用 glob 规则要求某些高风险工具（比如 `github_delete_*`）每次调用前都要人工确认。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- 支持从 Agent Plugins（一种跨工具的插件打包格式，https://agent-plugins.org/）和本地 Claude Code 插件目录里加载 MCP 服务器配置，方便复用别的生态里已经打好包的 MCP 服务器。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- 有 `createMcpAdapter` 这样一个 SDK 接口，让别的宿主程序可以把 pi-mcp-adapter 当库来内嵌用，而不只是作为 Pi 扩展跑。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md
- README 提到协议版本协商支持 legacy（默认，2025 版协议）和一个更新的 2026-07-28 版本，可以自动探测或手动锁定。参见 https://github.com/nicobailon/pi-mcp-adapter/blob/main/README.md

## 替代方案

- **pi-mcp-extension**（作者 irahardianto）
  - 仓库 https://github.com/irahardianto/pi-mcp-extension ，star 数约 7，fork 数约 10，最后提交 2026-05-03（相比 pi-mcp-adapter 明显更新更慢）。
  - 安装：`pi install npm:pi-mcp-extension`。参见 https://github.com/irahardianto/pi-mcp-extension/blob/main/README.md
  - 支持 stdio、streamable-http、以及旧版 sse 三种传输；工具列表发现走的是标准 MCP 分页 `tools/list`；断线重连是固定延迟重试（1 秒到 30 秒逐步拉长）。参见 https://github.com/irahardianto/pi-mcp-extension/blob/main/README.md
  - 配置文件位置是 `~/.pi/agent/mcp.json`（全局）和 `.pi/mcp.json`（项目级），项目覆盖全局，格式也是 `mcpServers` 对象。参见 https://github.com/irahardianto/pi-mcp-extension/blob/main/README.md
  - 没有在 README 中看到懒加载/tool search 这类省上下文设计，也没提到 OAuth 支持；这两点未在文档中出现，视为该项目未提供，标记为未验证（不排除后续版本补充）。
  - npm 月下载量约 11.5K。参见 https://pi.dev/packages?name=mcp

- **context-mode**（作者 mksglu）
  - 仓库 https://github.com/mksglu/context-mode ，star 数约 22677，fork 数约 1635，是这次调研里星标最多的相关项目，最后提交就在调研当天 2026-09-13。
  - 需要说明：这个项目和前面几个"给 Pi 加 MCP 客户端"的扩展方向相反——它本身是一个 MCP 服务器，目标是压缩别的工具调用往上下文里塞的数据量（README 举例：一次 Playwright 截图快照原本要 56KB，用它可以降到几 KB），同时支持 Claude Code、Pi 等 17 种客户端。参见 https://github.com/mksglu/context-mode/blob/main/README.md
  - 不是"替代 pi-mcp-adapter 连接 MCP 服务器"的方案，更像是搭配使用、专门治理上下文消耗的补充工具，两者可以同时用。
  - License 是 ELv2（Elastic License 2.0），不是完全开源许可证，这点在挑选时需要注意。参见 https://github.com/mksglu/context-mode/blob/main/README.md

- **doompi / doompi-mcp**（作者所在组织 AgiFlow）
  - 仓库 https://github.com/AgiFlow/doompi ，star 数约 35，fork 数约 3，最后提交就在调研当天。
  - 定位是"Pi 发行版"（对 Pi 做二次封装的整套配置），而 `@agimon-ai/doompi-mcp` 是其中负责"按领域限定 MCP 服务器选择范围和访问边界"的子包，用来在多项目/多团队场景下控制哪些 MCP 服务器对哪个会话可见。参见 https://pi.dev/packages?name=mcp
  - 具体配置格式和是否支持 OAuth，没有在本次调研中读到 README 细节，标记为未验证。

- **pi-claude-marketplace**（作者 acolomba）
  - 仓库 https://github.com/acolomba/pi-claude-marketplace ，star 数约 23，fork 数约 13，最后提交就在调研当天。
  - 作用是让 Pi 能访问 Claude 插件市场（Claude plugin marketplace），间接可以装载市场里包含 MCP 服务器配置的插件包，但它本身不是一个 MCP 客户端实现，是一层市场桥接。这一定位来自包描述，具体机制未在本次调研中读取源码验证，标记为未验证。参见 https://pi.dev/packages?name=mcp

- **@pi-unipi/mcp**（作者 Neuron-Mr-White，仓库名 unipi）
  - 仓库 https://github.com/Neuron-Mr-White/unipi ，star 数约 66，fork 数约 15，最后提交 2026-09-11。
  - npm 版本号是 2.16.1，和 pi-mcp-adapter 的版本号体系很接近，不清楚是否是基于 pi-mcp-adapter 二次开发或独立实现，未在本次调研中读取源码确认，标记为未验证。参见 https://pi.dev/packages?name=mcp

- **@spences10/pi-mcp**（作者 spences10，仓库名 my-pi）
  - 仓库 https://github.com/spences10/my-pi ，star 数约 126，fork 数约 15，最后提交 2026-09-13。
  - 描述是"面向 Pi 的可组合发行版，含 MCP、LSP（代码语言服务器协议）、agent 链、提示词预设和本地评测遥测"，同样是一个整合型 Pi 发行版而不是单一的 MCP 客户端库。参见 https://pi.dev/packages?name=mcp

- **@xynogen/pix-mcp**（仓库 pix-mono，作者 xynogen）
  - 仓库 https://github.com/xynogen/pix-mono ，star 数约 69，fork 数约 14，最后提交 2026-09-13。
  - 描述是"面向 Pix（一个 Pi 发行版）的省 token MCP 网关"，设计目标和 pi-mcp-adapter 的"省上下文"思路类似，但绑定在 Pix 这个特定发行版里用。参见 https://pi.dev/packages?name=mcp

- **phi**（作者所在组织 pulseaiclub）
  - 在 Pi 官方 Discussion 里被提到，是一个用 Go 写的、独立的 agent 运行时（harness），不是 Pi 的扩展包，而是另一个类似 Pi 的项目。它标榜"MCP without context death"：工具的 schema 不会进模型的 prompt，Agent 只看到服务器名，通过 `mcp_list` / `mcp_inspect` / `mcp_call` 按需发现和调用。参见 https://github.com/earendil-works/pi/discussions/3373
  - 因为它不跑在 Pi 里，只是设计理念上和 pi-mcp-adapter 类似，这里作为参考收录，不算 Pi 生态内的替代品。仓库地址未在本次调研中直接核实，标记为未验证。

## 没能核实的点（未验证）

- pi-mcp-adapter 在 GitHub 上出现的一批同名 fork（diegopetrucci、fitchmultz、jordyvandomselaar、Cansiny0320、afx-team、vandeefeng、patlux 等账号下）具体是用来做什么的，是否有各自的功能差异，没有逐个打开确认，未验证。
- HerbertGao/pi-extensions 这个仓库确实存在（描述为"HerbertGao maintained extensions for the Pi coding agent"），但调研时 star/fork 数都是 0，且没能读取到其中是否包含 MCP 相关扩展的具体内容，标记为未验证。仓库地址 https://github.com/HerbertGao/pi-extensions
- doompi-mcp、pi-claude-marketplace、@pi-unipi/mcp 三个包的配置文件格式、传输方式支持范围、OAuth 支持情况，均未读取到其 README 原文，标记为未验证。
- "awesome-pi" 这个说法对应的实际站点是 https://awesome-pi.site/extensions/ ，本次调研当作一手来源直接读取，但该站点性质更像是一个自动生成的第三方目录页而非官方仓库，其数据（下载量等）未做二次交叉核实，标记为未验证。
