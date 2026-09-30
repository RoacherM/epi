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
| 2026-09-29 | D3 | 只有交互模式走 MMP 自己的启动流程，print / json / rpc / 子命令仍走 `piMain` | 非交互模式和 benchmark 保持不变 | 全部模式都由 MMP 分发 | 按推荐推进。**重新评估的触发条件**：非交互模式在启动阶段仍会读项目 `.pi/settings.json`（tui-design 3.3 节），只有非交互模式也改走 SDK 才能消除 | tui-design 第 1 节 |
| 2026-09-29 | D4 | 扩展界面接口的 28 个方法全部实现 | 只做一部分的话，无法预测哪个扩展会坏 | 只实现子集 | 按推荐推进 | tui-design 第 1、6 节 |
| 2026-09-29 | C1 | **MMP 和 Pi 的配置不共享**：Pi 的全局状态只放在 `~/.mmp/pi`，不读不写 `~/.pi/agent`；项目里的 `.pi/` 不读 | 你的硬性要求；MMP 的承诺是"显式、确定的 Harness" | — | 已定 | tui-design 3.3 节 |
| 2026-09-29 | P0 | Pi 从 0.83 升到 0.87.1，作为单独的第 0 阶段 | 全屏渲染器、布局组件等新界面需要的能力都是 0.84 起才有 | 停在 0.83 | 已定（已完成） | tui-design 第 9 节 |
| 2026-09-29 | P0a | pi-mcp-adapter 从 2.17.0 换成 2.38.0 | 2.17.0 在 Pi 0.87 下加载不了（pi-ai 删掉了 `complete`）；2.38.0 是 2.x 最后一版，改动最小 | 直接上 3.x | 已定（已完成） | DEVELOPMENT.md 第 13 节 |
| 2026-09-29 | P0b | 给 Pi 固定传 `--system-prompt ""` 和 `--append-system-prompt ""` | 五个 `--no-*` 参数都挡不住 `SYSTEM.md` / `APPEND_SYSTEM.md` 的自动发现，违反 C1 和"只认 Manifest"的承诺；传空值后 system prompt 逐字不变 | — | 已定（已完成） | DEVELOPMENT.md 第 2 节 |
| 2026-09-29 | U4 | MMP 自己消费 `--approve` / `--no-approve`，不再转给 Pi；固定给 Pi 传 `--no-approve`。长期信任项目用 `/trust` | 以前 `mmp --approve` 会让项目 `.pi/settings.json` 在运行阶段生效（实测），违反 C1 | 保持转发（沿用 Pi 的语义） | 已定（已完成） | DEVELOPMENT.md 8.2 节 |
| 2026-09-29 | U5 | 支持 `mmp update`，交互模式下在底栏提示 `Update available! Run: mmp update`；启动时关掉 Pi 自带的更新提示 | 你的要求（参照 Claude Code）；Pi 自带的提示会让用户去跑 `pi update`，升的不是 MMP 锁定的那份 | 只在提示里给 curl 命令 | 已定（已完成） | [pi-upgrade-design.md](pi-upgrade-design.md) 5.1 节；`src/update.ts` |
| 2026-09-29 | U6 | 不做后台自动安装 | 你的决定 | 像 Claude Code 那样后台自动更新 | 已定 | pi-upgrade-design 5.1 节 |
| 2026-09-29 | M3 | 内置命令按 P0 → P1 → P2 做（tui-design 4.6）：P0 是补全、`/compact`、`/resume`、`/thinking`、`/copy`、`/reload`、`!` 命令和常用键位。不做 `/share`、`/bug`、`/changelog` | 先做每天用、只需薄包装 SDK 的 | 按 Pi 列表顺序全做 | 已定 | tui-design 4.6 节 |
| 2026-09-29 | K1 | `Ctrl+P` 给命令面板（grok 的入口），切模型用 `Ctrl+L` 或 `/model`；运行中 `Enter` 排队、`Alt+Enter` 插入当前这轮 | 你同意了推荐 | 保留 Pi 的 `Ctrl+P` 轮换模型 | 按推荐推进 | tui-design 4.7 节 |
| 2026-09-29 | K2 | 键位用 Pi 自己的键位表（从 Pi 包内文件加载），读 `~/.mmp/pi/keybindings.json` | 默认键位随 Pi 升级自动同步；测试在文件位置变化时报错 | 复制 Pi 的键位定义（约 114 行） | 我定的做法，你可以改 | `src/tui/keybindings.ts` |
| 2026-09-29 | M2 | 新界面开始开发：M1 的探针并进 M2 一起做；新界面放在 `MMP_TUI=v2` 开关后面，经典界面保持默认，直到 `/login` 等命令做完 | 你问为什么还没开始写；先交出能试用的东西。开关期间经典界面是唯一能登录的入口 | 先单独跑完所有探针；直接替换经典界面 | **已被 M5 取代**（2026-09-29） | tui-design 第 15 节 |
| 2026-09-29 | T2 | 交互模式下首次进入带 `.mmp/mmp.json` 的项目时询问是否信任并记住（选项同 Pi）；非交互模式不问 | 用户决定 | 只靠 `--approve` | 已定 | DEVELOPMENT.md 8.2 节 |
| 2026-09-29 | M5 | 去掉 MMP_TUI=v2：交互模式只走 MMP 自己的界面，不再启动 Pi 的经典交互界面；非交互模式仍走 piMain | 用户决定：只保留 mmp 一个入口 | 保留环境变量开关 | 已定 | tui-design 第 15 节 |
| 2026-09-29 | M6 | MMP 定位为改名叫 mmp 的定制版 Pi：功能优先对齐官方 Pi，界面换成 grok 风格；对外只暴露 mmp 自己的参数、子命令和帮助；install/remove/list/config 读写 Manifest，/bug 改为给 MMP 仓库开 issue | 用户决定 | 只保留 MMP 独有功能；透传 Pi 的 CLI | 已定 | [cli-design.md](cli-design.md) |
| 2026-09-30 | U1 | Pi 内核升级用做法 B：版本仍然锁死，升级过程自动化（定时任务发现新版本后自动升级三个 Pi 包和 adapter、跑离线兼容性门禁） | 用户同意推荐方案；做法 A（放宽版本范围）在 Pi 还是 0.x 阶段风险太高，做法 C（运行时用本机装的 Pi）有同样的可复现性问题 | A. 放宽版本范围；C. 运行时用本机装的 Pi | 已定 | pi-upgrade-design 第 1 节 |
| 2026-09-30 | U2 | 门禁通过、模型可见内容也没变时，先开 PR 由你合并，合并后发布脚本自动跑；稳定一段时间后再考虑全自动 | 用户同意推荐方案 | 门禁通过即自动合并并发布 | 已定 | pi-upgrade-design 第 7 节 |
| 2026-09-30 | U3 | 新建 GitHub Actions（每日定时任务 + PR 检查），门禁全部离线，不需要 secrets | 用户同意推荐方案 | 不建 CI，继续手工升级 | 已定 | pi-upgrade-design 第 7 节 |
| 2026-09-30 | P1 | Pi 内核升级到 0.99（本地试跑是从 0.87.1 升到 0.99.1）；门禁失败的地方全部修好再合并 | 用户决定：0.99 内置 MCP 是优势 | 停在 0.87 | 已定 | pi-upgrade-design 第 9 节 |
| 2026-09-30 | MCP1 | 改用 Pi 0.99 的原生 MCP，去掉 pi-mcp-adapter；配置仍是 `~/.mmp/mcp.json` 和被信任项目的 `.mmp/mcp.json`，由 MMP 用 `pi.registerMcpServer()` 交给 Pi，不读 Pi 自己的 `mcp.json`；管理功能对齐 Pi：`mmp mcp …` 子命令和界面里的 `/mcp` | 用户同意推荐方案 | 继续用 pi-mcp-adapter；直接读 Pi 的 mcp.json | 已定（具体接法等调研结果再细化） | — |
| 2026-09-30 | S1 | skills 自动发现只读两处：全局 `~/.agents/skills`，和 MMP 自己的 `~/.mmp/skills` 及被信任项目的 `.mmp/skills`；Pi 路径下的一律不读（`~/.pi/agent/skills`、`~/.mmp/pi/skills`、项目 `.pi/skills`）；Manifest 里显式声明的 skills 照旧加载。项目各级的 `.agents/skills` 暂不读 | 用户决定 | 只认 Manifest；照搬 Pi 的全部发现路径 | 已定 | — |
| 2026-09-30 | MCP2 | MCP 的具体接法（细化 MCP1）：用 `createMcpExtension` 的 `loadConfig` 选项交配置，不用 `registerMcpServer`（`/mcp` 里的启用/停用、曝光方式才能写回 MMP 的 `mcp.json`）；配置格式改成 Pi 的（不再支持 SSE、socket 和 pi-mcp-adapter 独有字段）；默认曝光沿用 Pi 的 `codemode`；仍由 Manifest 的 `mmp:mcp` 开关；`/mcp` 没有服务时的提示由 MMP 改写 | 用户确认（"mcp/skills 的改造你的意思是对的"） | `registerMcpServer` 交配置；保留 pi-mcp-adapter 的格式 | 已定 | [mcp-design.md](mcp-design.md) |

## 待定

| 编号 | 问题 | 我的推荐 | 依据 |
|---|---|---|---|
| — | 配色里标"我定"的几个颜色 | 看截图时确认 | [tui-theme.md](tui-theme.md) |
| — | 重跑 benchmark 基线和真实模型冒烟（会花钱） | Pi 0.87 改了 system prompt 格式，旧基线不能直接比，建议重跑 | DEVELOPMENT.md 第 20 节 |

## 已知遗留问题

- Pi 启动查找会话时总会读一次项目的 `.pi/settings.json`（影响会话目录等），发生在 `piMain` 内部，MMP 挡不住。交互模式（现在只走 MMP 自己的界面，见 M5）已经没有这个问题；非交互模式要等 D3 改成全部走 SDK，或者上游修复。
