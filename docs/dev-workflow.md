# Epi 开发流程

2026-09-30 起执行；2026-10-01 起改由 epi 在 Herdr 里自己开发自己，流程见 [dev-workflow-herdr.md](dev-workflow-herdr.md)，代码规范、合并前检查和审查清单见 [code-quality.md](code-quality.md)。本文第 1–2 节是当前流程的摘要（完整版以 dev-workflow-herdr.md 第 1–3 节为准）；第 3 节是任务说明的写法，第 4 节是 Herdr 实测的操作，第 5–6 节是不可违反的约定和仓库文件约定。记录的是开发 Epi 时实际在用、并和用户确认过的做法。产品层面的约定见 [development.md](development.md)，关键决策见 [decisions.md](decisions.md)。

## 1. 角色分工

| 角色 | 谁 | 做什么 |
|---|---|---|
| 主控 | 主会话（Opus 5.5，high） | 和用户讨论需求、写设计文档、拆任务、审查和验证每个任务（2026-10-03 起不再有单独的初审）、合并、在 Herdr 里实测、向用户汇报 |
| 顾问 | Fable（主会话的 `advisor` 工具） | 定计划之前、同样的问题第二次出现、宣布完成或合并之前给意见，见 [dev-workflow-herdr.md](dev-workflow-herdr.md) 第 2 节 |
| 编码 | Herdr 里的 epi（magpie opus-5.5，high），见 [code-quality.md](code-quality.md) 第 1 节 | 在独立 git worktree 里实现一个边界清楚的任务，自带测试，提交后交回 |
| 终审 | Fable（`model: "fable"`，只读） | 大节点审查，主控打审查包 |
| 阅读 | Claude Code 的 Sonnet 子代理（`model: "sonnet"`，只读） | 读代码、查资料，结论带文件行号或来源链接；主控核对原文后再用。不再用 agy |

每次合并后，在 memory 的 `subagent-quality-log.md` 里记一行：任务、作者、合并前退回几轮、合并后查出的 bug（P1 行为错误或安全问题 / P2 / P3 测试或整洁）。汇报时附上当前统计。

## 2. 一个任务的流程

```
设计文档（docs/，先和用户确认）
  → 拆任务：每个任务改的文件尽量不重叠
  → subagent 在独立 worktree 实现（见第 3 节）
  → 主控审查和验证（code-quality.md 第 3、4 节）──不通过──▶ 退回原作者修改
  → 通过 → 问顾问 → 主控合并（--no-ff），跑完整测试
  → Herdr 实测：真实终端 + 真实模型（第 4 节）
  → 更新质量记录，向用户汇报：做了什么、怎么验证的、文件在哪、还没做什么
```

- 设计先行：用户要设计时只讨论设计，不写代码。规格写进 `docs/` 里对应的设计文档，每条注明来源（实测 grok、源码笔记、还是主控自己定的）。
- 合并前审查是强制的，不要等合并后再审。复杂的状态逻辑（编辑器坐标、队列、会话切换）尤其如此。
- 审查—修复循环（2026-09-30 起，skills/hooks 分支上实际这样做）：
  - Fable 每条发现都要复现：把复现脚本写进 scratchpad（`fable-review-N/`），标 CONFIRMED（跑出来了）或 PLAUSIBLE（推断），附文件行号和修法方向。
  - 退回时把 Fable 的发现原样转给作者，附复现脚本路径；作者修完必须重跑这些脚本，并证明新测试在修复前失败：在临时副本里跑（`git archive` 或 `cp` 到 `/tmp`，换回修复前的 `src/`/`dist/` 再跑）。不要用 `git stash`：所有 worktree 共用一个 stash 栈，并行任务会互相弹出对方的改动（2026-10-02 U5 × D63）。修复前的副本可能缺少测试依赖的离线开关，所以在系统层面禁止联网再跑：`sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))' node --test …`，测试需要本地服务时再加 `(allow network-outbound (remote ip "localhost:*"))`（D63 的修复前副本曾真的访问 npm registry）。
  - 每轮修复后都再审一次，只审新提交，但要重跑上一轮的全部复现脚本，并专门找绕过（大小写、软链接链、编码形式等）。
  - 审查里遇到"这个算不算问题"的策略问题，由主控拍板并写进下一轮的任务说明，不让 Fable 或作者自己定。
  - 安全和硬规则（配置隔离、密钥泄露）一律阻塞合并，哪怕改动很小；非阻塞的记下来，合并时一起处理或进待办。
- 合并提交写明作者和审查情况，例如 `Merge … (Opus, Fable-reviewed before merge)`。主控在合并时改的地方写进合并提交说明。
- 只提交到本地分支。推送、开 PR、发布都是对外操作，每次都要用户明确同意。

## 3. 给 subagent 的任务说明

每份任务说明都要包含：

1. **起点**：`git merge --ff-only origin/main`（写明必须包含的提交），`ln -s <主工作区>/node_modules node_modules`，不要 `npm install`（确实要加依赖时写明允许，并提醒 node_modules 是链接，只能加不能删）。
2. **规格来源**：设计文档的章节，和 Pi 的参考代码位置（`node_modules/@earendil-works/pi-coding-agent/dist/`）。功能对齐 Pi 时，要求在提交说明里写出对照了 Pi 的哪些函数。
3. **状态清单**：列出这次新增或改动的状态（队列、标志、坐标、缓存），逐条检查所有会重置它、读取它的路径（启动、切换会话、/new、/resume、/reload、中止、退出），并测试交叉场景。
4. **测试要求**：测试必须在修复前失败、修复后通过；覆盖边界（多行、非首行、多个实例、窄屏 40/80/120 列）；不许为了让测试通过而在测试里插入人为步骤（例如强制多渲染一次）。跑测试的节奏：修改过程中只跑相关的测试文件（`npm run build && node --test test/<相关>.test.mjs`），完整 `npm test`（约 3 分钟）只在交付前跑一遍；遇到偶发失败要查出原因并修掉，不要靠多跑几遍确认。
5. **测试卫生**：测试不能碰开发者的真实环境——用临时 `HOME`/`EPI_HOME`，不联网（需要时加一个小的测试替换点，例如 `EPI_TEST_CLIPBOARD_FILE`），不读写真实剪贴板，不读写 `~/.epi`。
6. **边界**：同时在跑的其他任务改哪些文件，本任务尽量不碰。
7. **交付**：在 worktree 里提交（附 `Co-Authored-By`），报告分支、提交、每项的原因和修法、测试数、没验证的地方。

## 4. 在 Herdr 里实测

自动测试之外，每批改动合并后都在 Herdr 的 pane 里用真实终端、真实模型走一遍。

- 先确认在 Herdr 里（`HERDR_ENV=1`），用 `herdr pane list --workspace "$HERDR_WORKSPACE_ID"` 找到给测试用的 pane（按 JSON 里的 `pane_id`，不按位置猜）；没有就 `herdr pane split --current --no-focus` 开一个。同一个 tab 里用户自己的会话不要碰。
- 启动：`herdr pane run <pane> "node dist/cli.js"`（先 `npm run build`），等 `herdr pane wait-output <pane> --match commands`。
- 操作：`herdr pane send-text` 输入文字、`herdr pane send-keys` 发按键（PageUp 这类没有名字的键，用 `send-text $'\e[5~'` 发原始序列）；看画面用 `herdr pane read <pane> --source visible`。
- 安全：发 Ctrl+D 之前先用 `herdr pane process-info --pane <pane>` 确认前台还是 `node`，否则会关掉 shell 连同 pane；启动前也要确认前台是 shell，不然命令会被当成消息发给模型。退出要等运行时清理完（可能超过 2 秒）。
- 剪贴板：测粘贴时 `pbpaste` 备份、`pbcopy` 测试、测完放回；图片等非文字内容备份不了，要先告诉用户。
- 对照 grok：另开一个 pane 输入 `agent` 启动 grok-build。Herdr 的 `send-text` 不会被 grok 当成"粘贴"，测粘贴要用 `pbcopy` + Ctrl+V。grok 的行为（实测）写进设计文档时注明"实测"。
- 画面重影一类问题，先用 `script` 录下 Epi 的原始输出，在 pyte 里回放；回放正常就是终端（Herdr）的问题，不是 Epi 的。

## 5. 不可违反的约定

- **配置不和 Pi 共享**：Pi 的状态只在 `~/.epi/pi`；不读写 `~/.pi/agent`，不读项目 `.pi/`；Pi 固定收到 `--no-approve`。skills 只从 `~/.agents/skills`、`~/.epi/skills`、被信任项目的 `.epi/skills` 和 Manifest 声明发现（决策 S1）；MCP 配置只来自 Epi 自己的 `mcp.json`（决策 MCP1）。
- **信任**：项目的 `.epi/epi.json` 只有被信任时才读。
- **失败要可见**：不静默兜底、不吞错误；一个失败不能表现成别的失败。
- **对外只有 epi**：参数、子命令、帮助、报错都是 epi 自己的；功能优先对齐官方 Pi，只在和 grok 界面或上面几条冲突时不同，并在文档写明理由（[cli-design.md](cli-design.md)）。
- **Pi 内部接口**：按文件路径引用 Pi 未导出的模块、读 Pi 的私有字段，必须登记在 [pi-internals.md](pi-internals.md) 并有测试（升级门禁靠它发现破坏）。
- **版本号只有一个来源**：Epi 和 Pi 的版本都只在 `package.json`；测试和文档不写死版本号。


## 6. 仓库文件约定

- 根目录 `AGENTS.md` 只作 coding agent 的发现入口，完整开发规则在本文，架构在 [development.md](development.md)。
- README 只说明这个仓库是什么（定位、要点、快速开始、文档索引），不放细节；使用参考放 `docs/guide/`；开发、设计、验收和调研文档放 `docs/`，测试配置放 `test/fixtures/`。
- `.epi/` 是本地活动配置，整目录忽略；自开发模板放 [examples/development](../examples/development/README.md)，每个 worktree 按需手动启用。Herdr 草案不会随 clone 自动加载。
- `dist/` 是发布包入口，源码构建后必须一起提交；提交前执行 `npm run build`、`git diff --exit-code -- dist`，交付前执行完整 `npm test`。
- 合并保留分支历史（`--no-ff`）；主开发基线是 `main`，任务说明固定本次基线 SHA。发布版本与源码分支分开：只有发布流程创建的新 Release 才是安装器的升级来源。
