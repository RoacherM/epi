# 用 mmp 开发 mmp（Herdr 自举流程）

状态：2026-09-30 用户确认，2026-10-01 起启用，是 [dev-workflow.md](dev-workflow.md) 第 1–2 节摘要的完整版；那里的第 5 节（不可违反的约定）不变。2026-10-03 用户确认调整：去掉 mmp 初审，主控自己审查和验证；Fable 作为主控的顾问，在固定时点给意见；读代码和查资料只交给 Sonnet 子代理，不再用 agy；流程按通用的[工作流图](https://github.com/RoacherM/Wayne-Skills/blob/main/skills/workflow-graph/SKILL.md)（wayne-skills 的 `workflow-graph` skill）写成节点、交接和闸门。

目标：编码由 Herdr 里运行的 mmp 完成，mmp 在给自己干活的过程中暴露问题，再按优先级修掉。主控管进度、文档，并负责每个任务的审查和验证。

**怎么读本文**：第 1–3 节是完整流程，只读这三节就能把一个任务从计划走到汇报；那里出现的术语都在第 1 节定义。链接只指向细节：命令原文（[code-quality.md](code-quality.md) 第 3 节）和冒烟测试条目（[e2e-acceptance.md](e2e-acceptance.md)）。第 4 节以后是工具和环境的细节。只有要改流程本身的结构时，才需要读通用的 [workflow-graph skill](https://github.com/RoacherM/Wayne-Skills/blob/main/skills/workflow-graph/SKILL.md)。

## 1. 术语

| 术语 | 意思 |
|---|---|
| 主控 | 用户会话里的 Claude Code 主会话，运行本流程：派活、审查、合并、汇报 |
| 顾问 | Fable，主控会话里的 `advisor` 工具，调用时自动读到主控的整个会话。只在第 2 节的三个时点调用，不写代码、不做决定 |
| worker | 在 Herdr pane 里运行的 mmp，负责写代码。Herdr 是终端多路复用器，pane 是其中一个终端窗格 |
| magpie | 一个模型服务商（provider）。worker 通过它使用 Opus；主控自己不调用 magpie |
| worktree | 每个任务一个 git worktree（独立的工作目录和分支，分支名 `dev/<任务编号>`），worker 只在自己的 worktree 里改 |
| 基准提交 | 任务开始时 worktree 所基于的 `main` 上的提交，写在 `brief.md` 里；审查时 diff 就是对它比 |
| 节点 | 流程里的一步，内部是一个循环：触发 → 动作 → 检查 → 不过就重试，到停止条件就移交 |
| 交接物 | 节点之间传递的文件或提交，格式固定（第 3.2 节） |
| 回边 | 检查不过时，交接物退回造成问题的那个节点，附发现和复现方法 |
| 闸门 | 交接通过前必须满足的条件，带阈值；人工闸门要等用户确认（第 3.3 节） |
| 移交 | 节点到了停止条件，把问题和已有证据交给写明的下一个执行者 |
| 修复前失败 | 新测试在修复之前的代码上会失败、修复后通过，证明测试真能抓到这个问题。在临时副本里验证（`git archive <修复前提交>` 解到临时目录），禁止联网运行；不用 `git stash`（所有 worktree 共用一个 stash 栈） |
| 硬规则 | 碰到就阻塞合并的约定：配置不和 Pi 共享（不读 `~/.pi`、项目 `.pi/`、用户的 `PI_*`）、项目配置只在被信任时读、不泄露密钥、对外只暴露 `mmp` 自己的命令和帮助 |
| P0–P3 | 问题级别。P0：开发流程本身卡住；P1：行为错误、安全或配置隔离问题、数据丢失；P2：能用但别扭；P3：小毛病、文案、测试整洁 |
| CONFIRMED / PLAUSIBLE | 审查发现的可信度：CONFIRMED 是跑出来了，PLAUSIBLE 是推断 |
| 大节点 | 一组相关任务全部合并、准备整体验收的时候，例如"Pi 0.99 + MCP"做完，或工具版要跨大版本升级前 |
| 工具版 | worker 实际运行的那份 mmp，固定在最近一次验收通过的提交（第 4 节） |

## 2. 执行者

| 执行者 | 用什么 | 负责的节点 |
|---|---|---|
| 主控 | Claude Code 主会话，Opus 5.5，effort high | 计划、审查验证、合并、验收和升级、汇报 |
| worker | mmp + magpie `claude/claude-opus-5-5`，thinking high（用户 2026-10-01 定，2026-10-03 确认不改），每个任务、每轮修改都开新会话 | 实现 |
| 阅读子代理 | Claude Code 的 Agent 工具，`model: "sonnet"`，只读。读代码用 `Explore` 类型，查外部资料用 `general-purpose` 类型 | 被计划、审查验证节点调用。结论必须带文件行号或来源链接，主控打开原文核对后才用 |
| 审查子代理 | Claude Code 的 Agent 工具，`model: "fable"`，只读 | 大节点终审；审查主控自己写的代码（闸门 G5） |
| 顾问 | Fable（`advisor` 工具） | 下表三个时点 |
| 用户 | — | 需求有歧义时拍板；对外动作的人工闸门 |

顾问的三个时点，日常步骤不调用：

| 时点 | 什么时候算 |
|---|---|
| 定计划之前 | 读完材料之后、写 `brief.md` 或拆任务之前 |
| 同一个问题第二次出现 | 同一条审查发现第二次退回；worker 或主控第二次撞上同一个错误；方案迟迟收不拢 |
| 宣布完成之前 | 合并一个任务之前（审查验证做完以后）；向用户汇报之前。先把成果落盘（提交、写文件），再问 |

主控会话里没有 `advisor` 工具时，先告诉用户，不跳过这些时点。顾问的意见和主控查到的证据冲突时，带着证据再问一次，再决定。

## 3. 流程

### 3.1 节点

| 节点 | 执行者 | 触发 | 动作 | 检查（通过才交给下一个节点） | 停止和移交 |
|---|---|---|---|---|---|
| N1 计划 | 主控 | 用户提需求；`docs/dogfood-issues.md` 里该修的条目；终审发现 | 读材料（大范围读代码交阅读子代理）→ 问顾问 → 拆任务，并行的任务改的文件不重叠 → 每个任务写 `brief.md` | `brief.md` 的七项都写了（3.2 节），基准提交写明了 | 需求有歧义 → 问用户 |
| N2 实现 | worker | pane 里收到一行指令：`Read .dev/tasks/<id>/brief.md and do the task. Write your report to .dev/tasks/<id>/report.md.` | 按 `brief.md` 实现、写测试、在 worktree 里提交、写 `report.md` | `report.md` 最后一行是 `STATUS: done` | 要主控决定的事 → 写 `question.md` 停下等；做不下去 → `STATUS: blocked`，交主控；等待超时 → 主控读屏看卡在哪 |
| N3 审查验证 | 主控 | `STATUS: done` | 读 diff；逐条过下面的审查清单；在临时副本里重跑"修复前失败"；跑完整测试；要知道改动影响到哪里时派阅读子代理 | 闸门 G1 的条件全部满足 | 不过 → 写 `review-N.md` 走回边退回 N2；同一条发现第二次退回 → 先问顾问；退回到第 3 轮仍不过（G3）→ 主控改 `brief.md`、拆小，或自己接手（接手的代码按 G5 审） |
| N4 合并 | 主控 | G1 通过且顾问没有提出阻塞问题 | 单独执行 `git merge --no-ff`，确认退出码为 0、没有冲突标记，再提交；在 main 上跑完整测试 | main 上完整测试全过 | 合并时主控改了代码 → 按 G5 审过再提交；测试失败 → 回 N3 查原因 |
| N5 验收和升级 | 主控 | N4 完成 | Herdr 里用真实终端、真实模型走 [e2e-acceptance.md](e2e-acceptance.md) 里标 ★ 的冒烟条目 → 把工具版切到新提交 | ★ 条目全部通过 | 发现问题 → 记进 `docs/dogfood-issues.md`；P0 → 先把工具版切回上一个提交，再开任务修 |
| N6 大节点终审 | 审查子代理 | 到了大节点 | 主控写 `pack.md` 交给它；它按审查清单看整个阶段，重点看跨任务的交互 | 结论"可接受"，没有 P0–P2 | 有发现 → 拆成新任务回 N1；修完主控再打一个小的补充包复查 |
| N7 汇报 | 主控 | 一个任务或一个阶段完成 | 问顾问 → 告诉用户做了什么、怎么验证的、文件在哪、还没做什么，附三个指标（3.4 节） | — | 推送、开 PR、发布 → 闸门 G2 |

**审查清单**（N3 和 N6 用；不改 worker 的 worktree，所有复现都在临时副本里、禁止联网运行）：

1. 对照 `brief.md`：每项要求都做到了，没有任务以外的改动。
2. 复跑证据：至少重跑两个"修复前失败"检查；必要时故意改坏代码，确认测试能抓到。
3. 硬规则：碰到就阻塞合并。
4. 状态和路径：新增或改动的状态（队列、标志、坐标、缓存），在启动、切换会话、`/new`、`/resume`、`/reload`、中止、退出时都对。
5. 代码规范：新代码的单个函数认知复杂度不超过 15、不超过 80 行、嵌套不超过 4 层、参数不超过 5 个（超出要拆，或说明理由，例如和 Pi 的函数一一对应）；注释只写"为什么"；没有无用导出；没人用的旧路径已删；失败看得见，不静默兜底。
6. 测试质量：测试真能失败（不是被重绘、缓存或宽松的匹配碰巧满足）；没碰真实环境（`HOME`/`MMP_HOME` 用临时目录、不联网、不碰剪贴板和 `~/.mmp`）。
7. 构建产物：重新构建后的 `dist/` 和提交的一致。

### 3.2 交接物

都放在不提交的 `.dev/tasks/<任务编号>/` 或 `.dev/milestones/<名字>/` 里，合并提交除外。

| 交接物 | 从 → 到 | 格式 |
|---|---|---|
| `brief.md` | N1 → N2 | 七项：①起点：基准提交、`node_modules` 用软链接、不 `npm install`（要加依赖时写明允许）；②规格来源：设计文档章节和 Pi 的参考代码位置，要求在提交说明里写出对照了 Pi 的哪些函数；③状态清单：新增或改动的状态，以及会重置、读取它的所有路径；④测试要求：修复前失败、修复后通过，覆盖多行、非首行、多个实例、窄屏 40/80/120 列等边界，不在测试里加人为步骤；⑤测试卫生：临时 `HOME`/`MMP_HOME`、不联网、不碰剪贴板和 `~/.mmp`；⑥边界：并行任务在改哪些文件；⑦交付：提交、写 `report.md` |
| `report.md` | N2 → N3 | 每项做了什么、对照了 Pi 的哪些函数、测试数、做了哪些假设、没验证的地方；最后一行 `STATUS: done` 或 `STATUS: blocked` |
| `question.md` | N2 → 主控（提问，不是回边） | 需要主控决定的问题，带选项。主控在 pane 里回答后 worker 继续，主控同时把它改名为 `question-N.md`（第 N 个问题），所以 `question.md` 存在就表示有没回答的问题 |
| `review-N.md` | N3 → N2（回边） | 第 N 轮的发现，按严重程度排，每条标 CONFIRMED 或 PLAUSIBLE，附文件行号和复现命令；策略问题（"这算不算问题"）主控当场决定并写进去。发出前先把旧的 `report.md` 改名为 `report-N.md`，否则旧文件里的 `STATUS:` 会让等待立刻结束。`STATUS: blocked` 之后重新派工也一样先改名 |
| 合并提交 | N4 → N5 | 标题以 `Merge dev/<任务编号>:` 开头（任务面板靠它判断已合并）；说明写作者、审查情况、合并时主控改了什么 |
| `pack.md` | N5 → N6 | 目标和范围（设计文档章节、决策编号）；提交范围；每个任务的 `brief.md`/`report.md`/`review-N.md` 路径和没解决的分歧；风险清单（碰到硬规则和复杂状态的文件、函数）；证据（完整测试输出、模型可见快照的差异、Herdr 验收步骤）；已知问题；要终审回答的问题 |
| 终审结论 | N6 → N1（回边） | 可接受 / 不可接受，按严重程度排的发现（CONFIRMED / PLAUSIBLE、文件行号、复现） |

### 3.3 闸门

| 闸门 | 位置 | 条件 | 阈值和依据 | 谁判断 |
|---|---|---|---|---|
| G1 合并 | N3 → N4 | 构建产物同步；无未使用的变量和参数；相关测试和完整测试全过；新测试修复前失败已验证；模型可见内容的变化已说明；TUI 改动已在 Herdr 里实测；审查清单没有阻塞项 | 全部满足。偶发失败要查出原因修掉，不靠重跑通过。各项的命令见 [code-quality.md](code-quality.md) 第 3 节 | 主控。本地合并可以撤回，所以不设人工闸门（用户 2026-10-03 同意） |
| G2 对外 | N7 之后 | 推送、开 PR、发布 | 每次都要用户明确同意 | 用户 |
| G3 退回上限 | N3 → N2 的回边 | 同一个任务退回的轮数 | 第 3 轮仍不过就停止退回，改由主控处理。依据：质量记录里 D21 退回 3 轮后通过；skills/hooks 退回 4 轮，后两轮收益明显递减；D11 退回 5 轮，主因是任务说明给错了实现提示 | 主控 |
| G4 恢复独立初审 | 合并之后 | 主控审查放过、合并后或大节点才查出的 P1 个数 | 累计 2 个就向用户提出恢复独立初审。依据：10-01 到 10-02 有独立初审时，约 40 个 mmp-opus 任务合并后 0 个 P1。没有独立初审之后还没有数据，这个值待校准 | 主控提出，用户决定 |
| G5 作者不自审 | 主控自己写的代码（接手的任务、合并时的修改）提交前 | 审查子代理按审查清单审过，没有阻塞项 | 主控写的代码一律要审 | 审查子代理 |

### 3.4 三个指标

每次合并后在质量记录（memory 里的 `subagent-quality-log.md`）记一行：任务、作者、退回轮数、合并后查出的问题，以及从写好 `brief.md` 到合并的时长。汇报时附上这三个数：

| 指标 | 怎么算 | 说明什么 |
|---|---|---|
| 漏网问题 | 合并后或大节点才查出的 P1、P2 个数，标明是不是主控审查放过的 | 去掉独立初审后，审查够不够严（对应 G4） |
| 退回轮数 | 每个任务退回 N2 的次数 | 任务说明写得好不好（对应 G3） |
| 周期 | 从 `brief.md` 写好到合并的时长 | 流程哪里卡住。2026-10-03 起开始记，之前没有数据 |

### 3.5 运行顺序

```
N1 计划 ──brief.md──▶ N2 实现 ──report.md──▶ N3 审查验证 ──G1──▶ N4 合并 ──▶ N5 验收和升级 ──▶ N7 汇报 ──G2──▶ 推送 / PR / 发布
 ▲  ▲                   │  ▲                      │                          │
 │  └───question.md─────┘  └────review-N.md───────┘ （G3：最多 3 轮）         │ 一个阶段的任务都合并后
 │                                                                            ▼
 └──────────────────────────────── 终审结论 ◀── N6 大节点终审 ◀──pack.md─────┘
```

## 4. 两个 mmp：工具版和开发版

自己改自己有个风险：改坏了就没法用它来修。所以分两份：

```
工具版（tool）   ~/Projects/sides/mmp-tool  ← 最近一次验收通过的提交（git worktree，detached）
                 用它干活：worker 跑的是 `node <tool>/dist/cli.js`
开发版（dev）    .claude/worktrees/<任务>/           ← 正在改的代码
                 只用来跑测试和 Herdr 验收，不用来干活
```

- **升级工具版**：每次合并、通过 Herdr 验收、并跑完 [e2e-acceptance.md](e2e-acceptance.md) 里标 ★ 的冒烟条目后，主控把工具版切到新的提交（`git -C mmp-tool checkout --detach <commit>` 再 `npm run build`）。这样新功能马上进入日常使用，问题尽早暴露。
- **回退**：工具版出了阻塞问题（第 6 节 P0），先把工具版切回上一个提交继续干活，同时开任务修。实在修不动时，这个任务改由 Claude Code 的 Opus 子代理在 worktree 里做，修好后再切回来。
- 两份共用用户真实的 `~/.mmp`（凭证、会话、magpie 配置）。自动测试照旧用临时 `HOME`/`MMP_HOME`，不受影响。

## 5. 启动一个 worker

仓库只提交可选模板 [examples/development/mmp.json](../examples/development/mmp.json)，运行时 `.mmp/` 全部忽略。需要用 MMP 开发本仓库时，在每个 worktree 根目录按需创建本地配置，已有配置不要覆盖：

```bash
mkdir -p .mmp
if [ -e .mmp/mmp.json ] || [ -L .mmp/mmp.json ]; then
  echo '保留现有 .mmp/mmp.json；请手动合并需要的 rules。'
else
  (set -C; cat examples/development/mmp.json > .mmp/mmp.json)
fi
```

模板内容：

```json
{ "version": 1, "rules": ["../AGENTS.md", "../docs/dev-workflow.md"], "skills": [], "extensions": [] }
```

路径相对复制后的 `.mmp/mmp.json` 所在目录解析，而非模板的 `examples/development/` 目录；不要直接把模板目录当作运行配置目录。MMP 不自动读 `AGENTS.md`，必须声明成 Rules 才会进 system prompt。模板只加载当前开发流程，不自动启用本文的 Herdr 草案；正式切换仍需完成验收与启用步骤。

启动命令（主控在 pane 里执行，`--approve` 只让这一次信任 worktree 的 `.mmp/mmp.json`，不写进信任记录）：

```bash
cd <worktree> && node ~/Projects/sides/mmp-tool/dist/cli.js --approve \
  --provider magpie --model claude/claude-opus-5-5 --thinking high
```

编码用 `startmmp <worktree> opus`。每个任务、每轮修改都用新会话，不复用上一个的上下文。

## 6. mmp 自己的问题：记录和修复顺序

用 mmp 干活时看到的任何 mmp 问题（主控读屏看到的、工作者在 report 里提到的、审查发现的），都记进 `docs/dogfood-issues.md`（提交进仓库）：

| 字段 | 说明 |
|---|---|
| 编号 | D1、D2… |
| 级别 | P0 / P1 / P2 / P3 |
| 现象 | 看到了什么，和期望的差别 |
| 复现 | Herdr 命令或步骤 |
| 状态 | 待修 / 修复中（任务编号）/ 已修（提交） |

| 级别 | 定义 | 什么时候修 |
|---|---|---|
| P0 | 开发流程本身卡住：工具版起不来、会话丢失、工具调用坏掉 | 立刻：先回退工具版，再开任务修 |
| P1 | 行为错误、安全或配置隔离问题、数据丢失 | 插到下一个任务 |
| P2 | 能用但别扭：显示错、交互和 grok 不一致、性能差 | 攒几条一起修 |
| P3 | 小毛病、文案、测试整洁 | 空闲时批量 |

对比 grok 的做法不变：另开 pane 运行 `agent`，行为写进设计文档时注明"实测"。

## 7. Herdr 布局

在当前 workspace 新开一个 tab 专门给 mmp 开发用，不碰用户自己的 pane：

| pane | 用途 |
|---|---|
| worker-1 | 编码者（必要时 worker-2 并行第二个任务，两个任务改的文件不重叠） |
| check | 主控的 Herdr 验收、跑命令。用户可能随时关掉它，用之前先确认还在（`herdr.sh` 找不到 pane 会直接报错），不在就重新 split 一个 |
| grok | 对比 grok（需要时开） |

主控的 Claude Code 可以加载任务面板：`claude --plugin-dir scripts/dev/task-pane`（在仓库根目录启动），输入 `/mmp-tasks` 打开（`/tasks` 是 Claude Code 自带的命令）。面板每 5 秒读一次 `.dev/tasks/` 和合并记录，每个任务一行（状态、退回轮数、周期），输入框下方常驻一行计数；有任务变成待审查、有提问或卡住时弹出提醒。只认第 3.2 节的格式，2026-10-03 之前的任务目录不显示。

mmp 不是 Herdr 认识的 agent 类型，所以用 pane 命令（`pane run` / `send-text` / `wait-output` / `read`）操作，pane 编号记在 `.dev/panes.json`。现在放在 scratchpad 的辅助脚本 `h.sh`（`startmmp` / `quitmmp` / `say` / `scr`）移进仓库 `scripts/dev/herdr.sh`，因为 scratchpad 只在当前会话有效。

## 8. 启用前要做的准备

| # | 事项 | 说明 |
|---|---|---|
| 1 | MMP 自己的 magpie 配置 | **已完成（2026-09-30）**：`~/.mmp/extensions/magpie/index.mjs` 用 `pi.registerProvider` 注册 magpie，全局 Manifest `~/.mmp/mmp.json` 声明它。配置是从 magpie 接给 Pi 的那份手动复制来的，不读 Pi 的文件；magpie 改地址、key 或模型时手动改这个文件。`mmp -p` 实测 sonnet-5.5 和 opus-5.5 都能回复 |
| 2 | 工具版 | 建 `mmp-tool` worktree，切到验收通过的提交，`npm install` + `npm run build` |
| 3 | 项目 Manifest | 模板见 `examples/development/mmp.json`；按第 5 节在每个 worktree 按需复制，保留已有配置；`.mmp/` 与 `.dev/` 不提交 |
| 4 | 辅助脚本 | **已完成**：`scripts/dev/herdr.sh`（`startmmp` / `quitmmp` / `say` / `scr` / `waitreport`） |
| 5 | Herdr tab | 新开 tab 和 pane，记进 `.dev/panes.json` |
| 6 | 试运行 | 用 `docs/dogfood-issues.md` 的 D2（加速界面测试）完整走一遍，看交接、等待、审查哪里卡，调整本文后正式切换 |

## 9. MMP 的扩展放在哪

和 skills 一样与 Pi 分开，但扩展会执行代码，所以**不做自动发现**，只认 Manifest 声明：

- 用户自己的扩展：放 `~/.mmp/extensions/<名字>/`，在 `~/.mmp/mmp.json` 的 `extensions` 里声明（magpie 就是这样）。
- 项目的扩展：放项目 `.mmp/extensions/<名字>/`，在项目 `.mmp/mmp.json` 里声明，项目被信任才加载。
- Pi 的扩展目录一律不读：`~/.pi/agent/extensions`、`~/.mmp/pi/extensions`、项目 `.pi/extensions`。Pi 自己的扩展发现是关掉的（`--no-extensions` / `noExtensions: true`），`test/ambient-isolation.test.mjs` 在这三处放了会留下标记的扩展，验证它们都不会加载。

## 10. 还没解决的问题

- mmp 没有权限系统，编码者和审查者都能执行任意 bash。靠 worktree 隔离、指令和事后 `git status` 检查兜底。
- 等待完成靠 `wait-output` 匹配 `STATUS:`，模型忘了写就会一直等到超时；超时后主控读屏处理。
- magpie 的 thinking `high` 通过 `thinkingLevelMap` 传给 Claude；实际效果（是否真的开了高思考）要在试运行时确认。
