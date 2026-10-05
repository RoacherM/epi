# MMP 关键决策记录

按时间顺序记录已经拍板的决策，以及还在等待决定的问题。每条写明：决定了什么、为什么、否掉了什么、依据在哪。

状态：**已定** = 你明确同意过；**按推荐推进** = 你说"可以开发了"，我理解为同意当时的推荐，如果理解错了请指出；**待定** = 还在等你。

## 已定 / 按推荐推进

| 日期 | 编号 | 决策 | 理由 | 否掉的做法 | 状态 | 依据 |
|---|---|---|---|---|---|---|
| 2026-09-29 | T0 | 交互界面改为 MMP 自己写第 4 层，界面和交互按 grok-build 设计；Pi 的第 1–3 层（模型调用、agent 循环、会话与扩展运行时）保留 | 扩展皮肤方案改不了消息区、固定顶栏、单块折叠这些 grok 的核心交互 | 扩展皮肤（v1，约 600 行，只用扩展接口） | 已定 | [tui-design.md](tui-design.md) 第 0、14 节 |
| 2026-09-29 | T1 | 先设计、后写代码 | 你的要求 | — | 已定 | — |
| 2026-09-29 | D1 | 新界面在同一进程里调用 Pi SDK，用 pi-tui 渲染 | 扩展的 `custom()` 必须返回 pi-tui 组件；MMP 内置的 MCP adapter 调用了 3 次 `custom()` | RPC 子进程；换 Ink / ratatui | 按推荐推进 | tui-design 第 1 节 |
| 2026-09-29 | D2 | v1 只做全屏模式 | 固定顶栏和单块折叠要求历史记录由程序自己管理 | inline 模式 | 按推荐推进 | tui-design 第 1 节 |
| 2026-09-29 | D3 | 只有交互模式走 MMP 自己的启动流程，print / json / rpc / 子命令仍走 `piMain` | 非交互模式和 benchmark 保持不变 | 全部模式都由 MMP 分发 | 按推荐推进。**重新评估的触发条件**：非交互模式在启动阶段仍会读项目 `.pi/settings.json`（tui-design 3.3 节），只有非交互模式也改走 SDK 才能消除。2026-10-01：`--help` 和 `--list-models` 也改由 MMP 自己实现（dogfood D48：Pi 的路径吞掉扩展诊断、打印 Pi 文案），其余非交互模式仍走 `piMain`。2026-10-04：被 N1 取代，print / json / rpc 也改走 SDK，只剩 `--export` 走 `piMain` | tui-design 第 1 节 |
| 2026-09-29 | D4 | 扩展界面接口的 28 个方法全部实现 | 只做一部分的话，无法预测哪个扩展会坏 | 只实现子集 | 按推荐推进 | tui-design 第 1、6 节 |
| 2026-09-29 | C1 | **MMP 和 Pi 的配置不共享**：Pi 的全局状态只放在 `~/.mmp/pi`，不读不写 `~/.pi/agent`；项目里的 `.pi/` 不读 | 你的硬性要求；MMP 的承诺是"显式、确定的 Harness" | — | 已定 | tui-design 3.3 节 |
| 2026-09-29 | P0 | Pi 从 0.83 升到 0.87.1，作为单独的第 0 阶段 | 全屏渲染器、布局组件等新界面需要的能力都是 0.84 起才有 | 停在 0.83 | 已定（已完成） | tui-design 第 9 节 |
| 2026-09-29 | P0a | pi-mcp-adapter 从 2.17.0 换成 2.38.0 | 2.17.0 在 Pi 0.87 下加载不了（pi-ai 删掉了 `complete`）；2.38.0 是 2.x 最后一版，改动最小 | 直接上 3.x | 已定（已完成） | docs/development.md 第 13 节 |
| 2026-09-29 | P0b | 给 Pi 固定传 `--system-prompt ""` 和 `--append-system-prompt ""` | 五个 `--no-*` 参数都挡不住 `SYSTEM.md` / `APPEND_SYSTEM.md` 的自动发现，违反 C1 和"只认 Manifest"的承诺；传空值后 system prompt 逐字不变 | — | 已定（已完成） | docs/development.md 第 2 节 |
| 2026-09-29 | U4 | MMP 自己消费 `--approve` / `--no-approve`，不再转给 Pi；固定给 Pi 传 `--no-approve`。长期信任项目用 `/trust` | 以前 `mmp --approve` 会让项目 `.pi/settings.json` 在运行阶段生效（实测），违反 C1 | 保持转发（沿用 Pi 的语义） | 已定（已完成） | docs/development.md 8.2 节 |
| 2026-09-29 | U5 | 支持 `mmp update`，交互模式下在底栏提示 `Update available! Run: mmp update`；启动时关掉 Pi 自带的更新提示 | 你的要求（参照 Claude Code）；Pi 自带的提示会让用户去跑 `pi update`，升的不是 MMP 锁定的那份 | 只在提示里给 curl 命令 | 已定（已完成） | [pi-upgrade-design.md](pi-upgrade-design.md) 5.1 节；`src/update.ts` |
| 2026-09-29 | U6 | 不做后台自动安装 | 你的决定 | 像 Claude Code 那样后台自动更新 | 已定 | pi-upgrade-design 5.1 节 |
| 2026-09-29 | M3 | 内置命令按 P0 → P1 → P2 做（tui-design 4.6）：P0 是补全、`/compact`、`/resume`、`/thinking`、`/copy`、`/reload`、`!` 命令和常用键位。不做 `/share`、`/bug`、`/changelog` | 先做每天用、只需薄包装 SDK 的 | 按 Pi 列表顺序全做 | 已定 | tui-design 4.6 节 |
| 2026-09-29 | K1 | `Ctrl+P` 给命令面板（grok 的入口），切模型用 `Ctrl+L` 或 `/model`；运行中 `Enter` 排队、`Alt+Enter` 插入当前这轮 | 你同意了推荐 | 保留 Pi 的 `Ctrl+P` 轮换模型 | 按推荐推进 | tui-design 4.7 节 |
| 2026-09-29 | K2 | 键位用 Pi 自己的键位表（从 Pi 包内文件加载），读 `~/.mmp/pi/keybindings.json` | 默认键位随 Pi 升级自动同步；测试在文件位置变化时报错 | 复制 Pi 的键位定义（约 114 行） | 我定的做法，你可以改 | `src/tui/keybindings.ts` |
| 2026-09-29 | M2 | 新界面开始开发：M1 的探针并进 M2 一起做；新界面放在 `MMP_TUI=v2` 开关后面，经典界面保持默认，直到 `/login` 等命令做完 | 你问为什么还没开始写；先交出能试用的东西。开关期间经典界面是唯一能登录的入口 | 先单独跑完所有探针；直接替换经典界面 | **已被 M5 取代**（2026-09-29） | tui-design 第 15 节 |
| 2026-09-29 | T2 | 交互模式下首次进入带 `.mmp/mmp.json` 的项目时询问是否信任并记住（选项同 Pi）；非交互模式不问 | 用户决定 | 只靠 `--approve` | 已定 | docs/development.md 8.2 节 |
| 2026-09-29 | M5 | 去掉 MMP_TUI=v2：交互模式只走 MMP 自己的界面，不再启动 Pi 的经典交互界面；非交互模式仍走 piMain | 用户决定：只保留 mmp 一个入口 | 保留环境变量开关 | 已定 | tui-design 第 15 节 |
| 2026-09-29 | M6 | MMP 定位为改名叫 mmp 的定制版 Pi：功能优先对齐官方 Pi，界面换成 grok 风格；对外只暴露 mmp 自己的参数、子命令和帮助；install/remove/list/config 读写 Manifest，/bug 改为给 MMP 仓库开 issue | 用户决定 | 只保留 MMP 独有功能；透传 Pi 的 CLI | 已定 | [cli-design.md](cli-design.md) |
| 2026-09-30 | U1 | Pi 内核升级用做法 B：版本仍然锁死，升级过程自动化（定时任务发现新版本后自动升级三个 Pi 包和 adapter、跑离线兼容性门禁） | 用户同意推荐方案；做法 A（放宽版本范围）在 Pi 还是 0.x 阶段风险太高，做法 C（运行时用本机装的 Pi）有同样的可复现性问题 | A. 放宽版本范围；C. 运行时用本机装的 Pi | 已定 | pi-upgrade-design 第 1 节 |
| 2026-09-30 | U2 | 门禁通过、模型可见内容也没变时，先开 PR 由你合并，合并后发布脚本自动跑；稳定一段时间后再考虑全自动 | 用户同意推荐方案 | 门禁通过即自动合并并发布 | 已定 | pi-upgrade-design 第 7 节 |
| 2026-09-30 | U3 | 新建 GitHub Actions（每日定时任务 + PR 检查），门禁全部离线，不需要 secrets | 用户同意推荐方案 | 不建 CI，继续手工升级 | 已定 | pi-upgrade-design 第 7 节 |
| 2026-09-30 | P1 | Pi 内核升级到 0.99（本地试跑是从 0.87.1 升到 0.99.1）；门禁失败的地方全部修好再合并 | 用户决定：0.99 内置 MCP 是优势 | 停在 0.87 | 已定（已实现，ac9b407） | pi-upgrade-design 第 9 节 |
| 2026-09-30 | MCP1 | 改用 Pi 0.99 的原生 MCP，去掉 pi-mcp-adapter；配置仍是 `~/.mmp/mcp.json` 和被信任项目的 `.mmp/mcp.json`，由 MMP 用 `pi.registerMcpServer()` 交给 Pi，不读 Pi 自己的 `mcp.json`；管理功能对齐 Pi：`mmp mcp …` 子命令和界面里的 `/mcp` | 用户同意推荐方案 | 继续用 pi-mcp-adapter；直接读 Pi 的 mcp.json | 已定（具体接法等调研结果再细化）（已实现，ac9b407） | — |
| 2026-09-30 | S1 | skills 自动发现只读两处：全局 `~/.agents/skills`，和 MMP 自己的 `~/.mmp/skills` 及被信任项目的 `.mmp/skills`；Pi 路径下的一律不读（`~/.pi/agent/skills`、项目 `.pi/skills`；`~/.mmp/pi` 只是 MMP 替 Pi 存运行状态的目录，不是 skills 位置，自动发现的目录也不许指进去）；Manifest 里显式声明的 skills 照旧加载。项目各级的 `.agents/skills` 暂不读 | 用户决定 | 只认 Manifest；照搬 Pi 的全部发现路径 | 已定 | — |
| 2026-09-30 | MCP2 | MCP 的具体接法（细化 MCP1）：用 `createMcpExtension` 的 `loadConfig` 选项交配置，不用 `registerMcpServer`（`/mcp` 里的启用/停用、曝光方式才能写回 MMP 的 `mcp.json`）；配置格式改成 Pi 的（不再支持 SSE、socket 和 pi-mcp-adapter 独有字段）；默认曝光沿用 Pi 的 `codemode`；仍由 Manifest 的 `mmp:mcp` 开关；`/mcp` 没有服务时的提示由 MMP 改写 | 用户确认（"mcp/skills 的改造你的意思是对的"） | `registerMcpServer` 交配置；保留 pi-mcp-adapter 的格式 | 已定（已实现，ac9b407） | [mcp-design.md](mcp-design.md) |
| 2026-09-30 | H1 | 长期方向：更接近 OMP（oh-my-pi）的设计。grok 风格的界面是第一步，之后按 OMP 的思路构建 MMP 自己的 harness | 用户决定 | — | 已定（方向；具体 harness 设计以后逐项确认） | docs/development.md 第 3.3、17 节以当前范围描述，不再把未来 Harness 能力列为永久禁止项 |
| 2026-10-02 | H2 | 定位初稿的对齐：继续基于官方 Pi 内核，不 fork（K1 选 A）；K2（重划内核/harness 边界）和 K5（harness 路线图）先不做——先把外围（界面、CLI、配置、已有扩展）做好，遇到瓶颈再考虑修改 Pi 的行为。K3、K4、K6 待定，K7（`MMP_*`）按 D63 执行 | 用户决定（"K2/K5 先不做 还是基于pi的内核修改 不fork 先把外围做好 遇到瓶颈后再考虑修改pi的行为"） | 像 OMP 那样 fork；现在就按 OMP 补 harness | 已定 | development.md §1、§3 |
| 2026-10-02 | H3 | 定位的其余关键点：K3 配置保持严格（不读别家工具配置，显式装配，项目要信任；以后可加显式的一次性导入命令）；K4 内置标准能力（`mmp:task`、`mmp:mcp`、`mmp:hooks`）默认开启、可在 Manifest 关闭；K6 和 Pi 一样默认不审批，审批分级先不做 | 用户决定（"K3/K4/K6 按你说的"） | K3 学 OMP 自动发现；K4 维持"声明才开"或用 profile；K6 默认 yolo 或写/执行要审批 | 已定（K4 已实现：Manifest 的 `disable` 字段） | development.md §1、§3.4、§17 |
| 2026-09-30 | T3 | 界面细节："选中即复制"保持开启（和 Pi 一致）；用户消息块不显示 Pi 追加的图片缩放/格式转换说明（模型照常收到，"Image omitted" 这类失败说明照常显示） | 用户决定 | 关闭选中即复制；原样显示说明 | 已定（D9 随任务 D11 实现中） | [dogfood-issues.md](dogfood-issues.md) D9 |
| 2026-09-30 | T4 | 图片标签 `[Image #N]` 留在发给模型的文字里；整个会话统一编号，下一张 = 会话里出现过的最大编号 + 1；没有编号的图片显示 `[Image]`；没有图片数据的标签显示成暗色删除线，发送时提示 | 用户确认（"我觉得没啥问题"）；做法参照 Claude Code，用户可以直接说"第 2 张图" | 按计数推算、按图片内容匹配预留（D11 前两轮，过于复杂且仍会错位） | 已定（D11 实现中） | [dogfood-issues.md](dogfood-issues.md) D11 |
| 2026-10-03 | MG1 | MMP 内置 `magpie` provider（不进 Manifest，不是 `disable` 的第四项）；唯一配置是 API key，放在 `/login` 的 API key 登录项（存 `pi/auth.json`），没有 `magpie.json`，地址固定 `127.0.0.1:3425`；只有选中 Magpie 或 `--list-models` 时启动才等待目录（这一条 2026-10-04 被 MG2 改掉：每次启动都刷新所有扩展 provider） | 用户决定（"magpie的配置只需要填入api-key即可（放在api那一项配置中"）；启动策略是主控按审查结果定的：用其他 provider 时不为 Magpie 多等 | `magpie.json` 配置地址、超时、逐模型协议和开关；每次启动都查询目录 | 已定 | [magpie-design.md](magpie-design.md) |
| 2026-10-04 | N1 | 非交互模式（`-p`、json、rpc）和 task 子进程改走 SDK，和交互界面用同一个启动函数；`piMain` 只剩 `--export` 还用。取代 D3 里"print / json / rpc 仍走 `piMain`"的部分 | `piMain` 是黑盒：D80（选模型和 Pi 不等待的刷新竞争）和 D62（读项目 `.pi/settings.json`）都发生在它内部，MMP 修不了。不给 Pi 上游报 issue（用户定） | 只给 Magpie 打补丁；给上游报 issue 等修复 | 已定（已实现） | [noninteractive-sdk-design.md](noninteractive-sdk-design.md) |
| 2026-10-04 | MG2 | Magpie 作为普通 provider 扩展处理，不加 fallback 或专门规则：所有模式在选模型前等一次 Pi 自己的刷新，范围是所有由扩展注册的 provider；删掉 MMP 自己的启动查询、自己写 `models-store.json` 和 `selectsMagpie` 这类判断。改掉 MG1 的"只有选中 Magpie 时启动才等待目录" | 用户决定（"用统一的方式处理这个provider"、"当然是A"）；原型实测 40/40（设计文档 5.2 节） | 只刷新这次选中的 provider（要照 Pi 的规则重写一份"选了谁"的判断） | 已定（已实现） | noninteractive-sdk-design.md 第 5 节 |
| 2026-10-04 | H4 | 后续重心：围绕 Pi 做好交互界面（TUI）和内置扩展；coding agent 的内核先不动。新能力先做成界面功能或内置扩展，做不成时才单独评估改 Pi 的行为 | 用户决定（"后续就是围绕Pi做好TUI和做好内置的extensions。先不动codingagent的内核"）。和 H2 一致，把"外围"明确成两块 | 改 Agent 循环、压缩、会话格式；fork Pi | 已定 | development.md §1、§2.5 |
| 2026-10-04 | H5 | 定位：**本地的主力 TUI 工具**。多模态素材的生产和创作是要提前准备的方向，不是现在的定位：做功能时为它留余地，时机成熟再改造相关部分。内核仍是 Pi，不 fork（H2、H4 不变） | 用户决定。当天先说"后续肯定是要支持多模态工作台""Agent OS 的 TUI 版本"，主控据此记成"定位扩展为多模态工作台"；用户随后修订："还是本地的主力TUI工具的定位合适，但是很多功能需要为多模态素材的生产和创作做准备，如果时机成熟我们将改造这些内容" | 现在就把定位改成多模态工作台 / Agent OS；完全不考虑多模态 | 已定。"留余地"具体指什么还没逐项定，主控的理解见 notes/multimodal-surface.md 第 7.3 节（工作面不直接依赖 pi-tui 的面板接口），用到时再确认 | [notes/multimodal-surface.md](notes/multimodal-surface.md) |
| 2026-10-04 | H6 | 界面的分工："TUI 负责高频指挥、状态观察和快速审查；需要高视觉带宽时，打开与当前任务绑定的专用视图。"开发后不该飞到编辑器里去看结果，所以内置一个能审查的专用视图；浏览器、电脑操作是给 agent 操作和拿反馈的工具，不是给人在终端里看的画面 | 用户决定（原话）。第一个专用视图是 `/preview`，由用户本机的 yazi 扩展改名收进仓库 | 在终端里重做编辑器、追 VS Code 的功能对等 | 已定。`/preview` 0.1.0 还是文件浏览器，"与当前任务绑定"的一半（本次改动的文件列表、diff、批注回给 agent）还没做 | [architecture.md](architecture.md) §3.3、§3.4 |
| 2026-10-04 | EXT1 | 内置扩展各自做版本管理，不和 MMP 主线的版本混在一起：每个扩展有自己的版本号（代码里的常量）、更新记录（它自己的使用文档里）、tag 前缀（如 `preview-v0.1.0`）、开发分支前缀 `ext/<名字>/`；MMP 仍用 `package.json` 的版本和 `v*` tag，发版说明写明带了哪些扩展版本 | 用户提出（"开发拓展的时候是不是也得进行版本管理…不要和主分支的版本管理混在一起"）；具体做法是主控定的 | 扩展没有版本，只跟 MMP 的版本走；现在就拆成独立仓库或 npm 包 | 已定（做法可改） | [architecture.md](architecture.md) §3.6 |
| 2026-10-04 | A1 | 架构设计文档保持精简，只写原则，不写具体实践：新增 `docs/architecture.md`；实现细节和契约留在 `development.md` | 用户决定 | 把原则和实现写在同一份文档里 | 已定 | [architecture.md](architecture.md) |
| 2026-10-05 | NM1 | 改名：产品名 **Epi**，命令 `epi`，配置目录 `~/.epi`。README 开头一句解释名字：epi- 是希腊语前缀"在……之上"，Epi 是建在 Pi 之上的那一层。口号 "Compose Pi your way" 保留。仓库简介从 "Better TUI For Pi" 改成类似 "Epi — your own layer on Pi"。对外提到时写 "Epi (on Pi)" 或带仓库地址（搜 "epi" 会先出 EpiPen、流行病学） | 用户决定。查重名（用户查的）：没有叫 `epi` 的主流终端工具或编程助手；唯一撞名是 Kudaes/EPI（Windows 进程注入的安全研究工具，产物 epi.exe），领域不重叠。npm 上的 `epi` 包没查到，用 install.sh 分发不受影响，要发 npm 时再看 | 继续叫 MMP（Make My Pi） | 已定 | 取代 M6 里的"改名叫 mmp"；迁移方式见 NM2 |
| 2026-10-05 | NM2 | 改名 Epi 的迁移：① 旧的 `~/.mmp` 由安装脚本搬：install.sh 装 epi 时，`~/.epi` 不存在而 `~/.mmp` 存在，就把它改名为 `~/.epi` 并打印一行；epi 自己不管旧目录。② 环境变量改名为 `EPI_*`，只认新名；启动时发现还设着 `MMP_*`，打印一行写明对应的新名字，下个版本删掉这个提示。③ 改名后的第一个版本是 0.1.13。④ GitHub 仓库 `RoacherM/mmp` 改名为 `RoacherM/epi` 并改简介：改名代码合并后、发版前由主控用 `gh` 做，做之前再问一次用户（对外操作）。主控按推荐推进、用户没反对的部分：内部名字一起改（`epi:preview` 这类扩展名、`epi/...` 总线频道、项目的 `.epi/`）；preview 0.3.0 的频道直接叫 `epi/preview/player/v1`，和改名一起发布，`mmp/` 频道不发布；旧版 `mmp update` 拿到新 release 的 install.sh，装上 `epi` 后卸载旧的 `mmp` 包并说明，不保留 `mmp` 命令；带日期的历史记录（决策表、dogfood、notes）不改。主控另外定的（没有单独问用户）：Manifest 文件跟着改名为 `epi.json`（用户的 `~/.epi/epi.json`、项目的 `.epi/epi.json`），install.sh 搬目录时把里面的 `mmp.json` 一起改名；项目里还只有 `.mmp/` 时，启动打印一行改名提示，下个版本删掉；代码里含 mmp 的标识符也改名；加一个测试，禁止仓库里在允许的历史记录以外出现 mmp。分两个任务做：A 机械改名，B 迁移（install.sh、提示） | 用户在四个选项里选的（①③与主控推荐不同：主控推荐 epi 启动时报错给命令、版本 0.2.0） | ① epi 启动时报错给出 `mv` 命令；epi 启动时自动搬。② 不提示；两个名字都认。③ 0.2.0；从 0.1.0 重来（`update` 按版本比较新旧，会认为不是更新） | 已定 | NM1 |
| 2026-10-05 | NM3 | 改名 Epi 不做迁移流程：取消 NM2 的 ①（install.sh 搬 `~/.mmp`）、②（`MMP_*` 提示）、旧版 `mmp update` 自动换成 `epi`、项目 `.mmp/` 提示，以及原定的任务 B。代码里不留任何旧名的兼容或提示。用户本机由主控手动迁移一次（`~/.mmp` → `~/.epi`、`mmp.json` → `epi.json`、卸载 `mmp`、装 `epi`）。NM2 的 ③（0.1.13）、④（发版前改仓库名，先问用户）和改名范围不变 | 用户决定（"目前没有大规模推广 可以不考虑复杂的迁移流程"） | NM2 的自动迁移 | 已定 | 取代 NM2 ①② 和迁移部分 |
| 2026-10-04 | EXT2 | 两个扩展（内置或第三方）不能注册同名命令：所有扩展加载完、建会话之前检查，重名就作为启动错误，列出冲突的扩展；牵涉可以关掉的内置能力时附上怎么关。取代 `mmp:mcp` 原来"会话开始时显示一条错误、照常运行"的做法 | 用户决定（"重复注册的问题，最好抛出来吧；不要让他能重复，提前提示"）。Pi 自己的处理是把两边都改名成 `name:1`/`name:2`，用户输入的名字就不再指向他以为的那个 | 让用户扩展覆盖内置的、只显示提示；只对 `/preview` 检查 | 已定 | [architecture.md](architecture.md) §3.5 |

## 待定

| 编号 | 问题 | 我的推荐 | 依据 |
|---|---|---|---|
| — | 配色里标"我定"的几个颜色 | 看截图时确认 | [tui-theme.md](tui-theme.md) |
| — | 重跑 benchmark 基线和真实模型冒烟（会花钱） | Pi 0.87 改了 system prompt 格式，旧基线不能直接比，建议重跑 | docs/development.md 第 20 节 |
| — | 多模态方向什么时候算"时机成熟"、开始改造；到时第一个工作面选剪辑还是浏览器 | 现在不启动（H5）。启动时先做剪辑，再做浏览器，两个跑通后再抽框架 | [notes/multimodal-surface.md](notes/multimodal-surface.md) 第 5.4、6 节 |
| — | 界面底座：继续用 pi-tui，还是换渲染库或把前端拆成独立进程 | 先定两个接口（工作面协议、面板接口），让工作面不直接依赖 pi-tui；换不换等有实测数据再定。验证原型用户决定现在不做 | [notes/multimodal-surface.md](notes/multimodal-surface.md) 第 7 节 |

## 已知遗留问题

- ~~Pi 启动查找会话时总会读一次项目的 `.pi/settings.json`（发生在 `piMain` 内部）。~~ 2026-10-04 已解决：非交互模式不再走 `piMain`（决策 N1）。
