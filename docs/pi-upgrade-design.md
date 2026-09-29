# Pi 内核升级设计（草案）

日期：2026-09-29。状态：草案，待你拍板，还没写代码。

一句话目标：Pi 发新版后，MMP 自动完成升级和验证，人只在验证不通过、模型看到的内容变了、要对外发布这三种情况下介入；同时每个 MMP 发布版锁定的 Pi 版本仍然固定，安装结果可复现。

背景：这次从 0.83 升到 0.87（第 0 阶段）全是手工做的，包括改 3 个包的版本号、换掉不兼容的 MCP adapter、手工修改 8 个文件里的版本号、逐项核对资源隔离。Pi 的发布很频繁：0.84.0（8 月 6 日）到 0.87.1（9 月 22 日），7 周里发了 11 个版本，其中 4 个 minor 版本。

## 1. 三种做法

| 做法 | 说明 | 结论 |
|---|---|---|
| A. 放宽版本范围 | `package.json` 写 `^0.87` 之类，用户安装时拿到当时最新的 Pi | 不采用。用户从 tarball 安装时才解析版本，两个人会装到两个不同的 Pi。Pi 还在 0.x 阶段，minor 版本就会有破坏性变更：这次 0.84 起 pi-ai 删掉了 `complete`，MCP adapter 2.17.0 就加载不了了 |
| B. 版本仍然锁死，升级过程自动化 | 定时任务发现新版本后，自动把全部 Pi 包一起升级，跑一遍兼容性门禁，通过就开 PR，不通过就开 issue | **推荐** |
| C. 运行时用本机装的 Pi | MMP 不带 Pi，运行时去找已安装的版本 | 不采用。可复现性问题和 A 一样；而且 pi-coding-agent 自带 shrinkwrap，无论如何都会带上自己的 pi-tui（见 tui-design 3.2 节） |

B 的直接后果：用户只能通过 MMP 的新发布拿到新 Pi，所以 MMP 的发布频率会跟着上升，**发布自动化也是这个需求的一部分**（第 5 节）。

## 2. 流程

```
每天定时（GitHub Actions cron）
  │
  ├─ 检查 npm：pi-coding-agent 有没有新版本？没有就结束
  │
  ├─ 升级脚本（代码决定）
  │     新分支 → pi-coding-agent / pi-tui / pi-ai 升到同一个新版本
  │           → pi-mcp-adapter 的 peer 范围不包含新版本时，升到声明兼容的最新版
  │           → npm install
  │
  ├─ 兼容性门禁（代码决定，第 3 节）
  │     全部离线，不调用真实模型，不需要任何 API key
  │
  ├─ 通过 ──▶ 开 PR，附上门禁报告和"模型可见变更"摘要
  │           ├─ 模型可见内容没变 ──▶ 可以直接合并（是否自动合并由你定，U2）
  │           └─ 变了 ──▶ 标记"需要重跑 benchmark 基线"，等你决定（会花钱）
  │
  └─ 不通过 ──▶ 开 issue，列出失败的检查和对应的 Pi 变更

合并后 ──▶ 发布脚本（第 5 节）──▶ 新的 MMP 发布版
```

需要人介入的只有三处：门禁不通过；模型可见内容变了，要决定是否重跑基线；对外发布。以后可以再加一步，让 AI agent 在门禁不通过时先尝试修复，这里不展开设计。

## 3. 兼容性门禁

每一项都写明它能发现什么问题，以及这次 0.87 升级里的实际情况。

| 检查 | 能发现什么 | 这次升级的实际情况 | 现状 |
|---|---|---|---|
| 编译 + 类型检查 | Pi 导出接口的类型变了 | 通过 | 已有 |
| 全部测试（`npm test`） | 行为回归 | 发现 MCP adapter 加载失败、8 个文件的版本号写死 | 已有 |
| ambient 资源隔离 | Pi 新增的自动发现来源 | 手工从 CHANGELOG 找到 `AGENTS.override.md` 补进测试；`SYSTEM.md` / `APPEND_SYSTEM.md` 一直没被覆盖，今天才发现并修好 | 今天新增（`test/ambient-isolation.test.mjs`）。**要改进**：需要埋设的路径清单，在测试里直接从安装好的 Pi 读取（`trust-manager.js` 里的 `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`，以及资源加载代码里发现的文件名），不再手写。Pi 新增一种来源，测试就会自动覆盖 |
| 配置隔离 | 项目 `.pi/settings.json`、`~/.pi/agent` 被读取 | 实测：启动阶段总会读项目设置；`--approve` 时运行阶段也生效（已修复） | 运行阶段已是正式测试（`test/ambient-isolation.test.mjs`）。启动阶段的读取还挡不住，只能在报告里记录 |
| MCP 离线验收 | adapter 和新 Pi 不兼容 | 正好能发现 `complete` 被删掉 | 今天新增（`test/mcp.test.mjs`，用 faux provider 按剧本调用） |
| 模型可见内容快照 | system prompt 和工具 schema 的变化 | 0.87 把 system prompt 改成了 `<tools>`、`<rules>` 这样的分段格式，没有任何测试发现 | 新增。只报告、不判失败：一旦有变化，就提示需要重跑 benchmark 基线 |
| 启动契约 | `piMain` 路径和 SDK 路径给模型的内容不一致（新 TUI 之后才有两条路径） | — | 新增，随新 TUI 一起做（tui-design 3.1 节） |
| Pi 接口清单 | MMP 用到的 Pi 符号被删掉或改名 | — | 新增。自动收集 `src/` 里所有从 Pi 包 import 的名字，逐个断言存在、类型对得上。门禁不通过时，能直接指出是哪个符号出了问题 |
| 复制代码的漂移 | 从 Pi 复制过来的代码，上游改了 | — | 新增。`vendor.json` 记录每个复制文件对应的上游路径、版本和哈希。升级脚本比较新旧两个版本的上游文件，一有变化就判失败，交给人看 |
| pi-tui 实例检查 | 顶层 pi-tui 和 Pi 自带的 pi-tui 版本不一致 | — | 新增。启动时也检查，不一致就直接报错 |
| 交互冒烟 | 交互界面起不来或崩溃 | 0.87 启动页正常；退出流程没能测到 | 已有脚本（`pty-smoke.py`），要修好退出步骤，再改写成正式测试 |

整套门禁都是离线的，因为 faux provider 可以代替真实模型。所以 CI 里不需要 API key，每次跑也不花钱。

## 4. 先消灭这次的手工步骤

这些是实现 B 之前就该做的，否则自动升级第一步就会卡住：

1. **版本号只保留一个来源。** 测试和夹具里写死的 `0.87.1` 全部改为读取已安装 Pi 的 `VERSION`。这次改了 8 个文件，以后不用再改。
2. **benchmark 变体名去掉版本号**：`pi-0.87-baseline` 改成 `pi-baseline`，版本记录在 metadata 里。
3. **文档里不写具体版本号**，统一写"见 `package.json`"，或者由发布脚本生成。
4. **MCP adapter 跟着升级**：升级脚本检查 adapter 的 peer 依赖范围，不包含新 Pi 时，自动换成声明兼容的最新版。

## 5. 发布自动化

合并升级 PR 后，发布脚本 `scripts/release.mjs` 按这个顺序执行：

1. MMP 版本号加一个 patch 版本；
2. `npm pack`；
3. 计算 SHA-256；
4. 更新 `install.sh` 和 README 里的下载地址和校验值；
5. 打 tag；
6. `gh release create`。

对外发布是否需要你每次点一下，由你定（U2）。

## 5.1 用户侧：更新提示（参照 Claude Code）

> 2026-09-29 已实现（U5），实现和下面的设计有两处出入：
> - 现在只在底栏显示（`setStatus`），启动页不加这一行。一种机制就够了，底栏的位置也和 Claude Code 一致。
> - 检查失败的原因只记在 `~/.mmp/update-check.json`，还没接到 `/mmp` 的输出里。
>
> 代码在 `src/update.ts` 和 `src/extensions/runtime.ts`，测试在 `test/update.test.mjs`。

自动升级只解决了"MMP 发新版"。用户要知道有新版、知道怎么升，所以需要一个类似 Claude Code 右下角 `Update available! Run: brew upgrade claude-code@latest` 的提示。

**显示在哪里**

| 阶段 | 位置 | 样式 |
|---|---|---|
| 现在（交互界面还是 Pi 的） | 启动页底部一行；会话中途才拿到检查结果的，用 `ctx.ui.setStatus("mmp-update", …)` 显示在底栏 | `warning` 色：`Update available! mmp 0.1.4 → 0.1.5 · Run: <升级命令>` |
| 新 TUI | 快捷键栏右侧，右对齐，和 Claude Code 的位置一致；窄屏时先丢掉这一段（tui-design 4.5 节） | 同上 |

**怎么检查**

```
交互模式启动 ──▶ 读 ~/.mmp/update-check.json（上次的结果）──▶ 有更新就立刻显示
             └─▶ 距上次检查超过 24 小时？──▶ 后台请求 GitHub Releases API（latest），超时 3 秒
                                            ──▶ 写回缓存；比当前版本新，就更新提示
```

- 数据源：`https://api.github.com/repos/RoacherM/mmp/releases/latest` 的 tag，和 `MMP_VERSION` 做 semver 比较。不需要登录，未登录限额是每小时 60 次，一天查一次足够。
- 缓存放在 `~/.mmp/update-check.json`，是 MMP 自己的目录，不放进 `~/.mmp/pi`。
- 完全在后台进行，不阻塞启动，也不影响正在进行的对话。
- 检查失败不打扰用户：错误记进缓存文件，`/mmp` 里能看到"上次检查失败：原因"。这样失败不是悄悄吞掉的，只是不在主界面弹出来。
- 24 小时、3 秒这两个数字是我定的。

**什么时候不检查**

- 非交互模式（print、json、rpc）和 benchmark 一律不检查，保证运行结果可复现，也不产生网络请求；
- 设置了 `--offline` 或 `PI_OFFLINE`；
- 设置了 `MMP_DISABLE_UPDATE_CHECK=1`；
- 设置了 `CI` 环境变量。

**关掉 Pi 自己的更新提示。** Pi 的交互界面会自己去查 Pi 的新版本，提示 `New version 0.87.1 is available. Run pi update`（0.83 冒烟时实际看到过）。在 MMP 里这是误导：`pi update` 升的是全局的 Pi，不是 MMP 锁定的那份。MMP 启动 Pi 前设置 `PI_SKIP_VERSION_CHECK=1`（Pi 的 `version-check.js` 认这个变量），只保留 MMP 自己的提示。

**提示里给什么命令**

- v1：重新运行安装器，也就是 `curl -fsSL https://github.com/RoacherM/mmp/releases/latest/download/install.sh | sh`。前提是发布脚本把 `install.sh` 作为 release 附件上传，GitHub 的 `releases/latest/download/<文件名>` 会自动指向最新一版。
- 更顺手的写法是加一个 `mmp update` 子命令，和 `claude update` 一样，内部就是跑上面那个安装器。提示就可以写成 `Run: mmp update`（U5）。

**后台自动安装**（Claude Code 默认会这么做）：v1 不做。安装器执行的是 `npm install --global`，在对话进行中替换正在运行的程序有风险，还可能遇到权限问题。先只做提示，等用户反馈再决定（U6）。

## 6. 对新 TUI 设计的约束

自建第 4 层后，MMP 和 Pi 耦合得更深，每一处耦合都会变成每次升级的成本。所以给 [tui-design.md](tui-design.md) 定三条规则：

| 耦合方式 | 规则 |
|---|---|
| Pi 包入口导出的接口 | 当作契约来用，由"Pi 接口清单"检查兜底 |
| 从 Pi 复制过来的代码 | 只允许小段，并且必须登记在 `vendor.json` 里接受漂移检查。目前计划复制的有：`app.*` 键位定义（约 114 行）、`resolveAppMode`（13 行）、项目信任流程 |
| 按文件路径直接 import Pi 没导出的模块，或读取 `globalThis` 上的私有 symbol | 禁止 |

## 7. 待你拍板

| # | 问题 | 我的推荐 |
|---|---|---|
| U1 | 用哪种做法 | B：版本锁死，升级自动化 |
| U2 | 门禁通过、模型可见内容也没变时，是自动合并并发布，还是每次你点一下 | 先做"开 PR，你点合并"，发布脚本在合并后自动跑。稳定一段时间后再考虑全自动 |
| U3 | 仓库目前没有任何 CI，要不要加 GitHub Actions（每日定时任务 + PR 检查） | 要。门禁全部离线，不需要 secrets |
| U5 | ~~更新提示里给的命令~~ | 已定并已完成：`mmp update` |
| U6 | ~~要不要后台自动安装新版~~ | 已定：不做 |
| U4 | ~~第 0 阶段发现 `mmp --approve` 会让 Pi 信任项目 `.pi/settings.json`~~ | 已按推荐修法完成（2026-09-29）：不再转发 `--approve`，固定给 Pi 传 `--no-approve` |

## 8. 实施顺序

| 步 | 内容 |
|---|---|
| 1 | 第 4 节：版本号单一来源、变体改名、文档去版本号 |
| 2 | 补齐门禁：配置隔离改成正式测试、ambient 清单从 Pi 读取、模型可见内容快照、Pi 接口清单、交互冒烟 |
| 3 | 升级脚本（本地可跑：`npm run pi:upgrade`） |
| 4 | GitHub Actions：每日检查 + PR 检查 |
| 5 | 发布脚本（把 `install.sh` 作为 release 附件上传） |
| 6 | 更新提示：关掉 Pi 自带的提示、后台检查与缓存、启动页和底栏显示、`mmp update`（新 TUI 里改为显示在快捷键栏右侧） |

新 TUI 开发期间同样执行第 6 节的规则，漂移检查和启动契约随 TUI 代码一起加。
