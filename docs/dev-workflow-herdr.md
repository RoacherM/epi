# 用 mmp 开发 mmp（Herdr 自举流程）

状态：2026-09-30 用户确认。当前功能（Pi 0.99 + 原生 MCP）验收后启用；启用后替换 [dev-workflow.md](dev-workflow.md) 第 1–4 节，第 5 节（不可违反的约定）不变。

目标：开发和审查都由 Herdr 里运行的 mmp 完成，mmp 在给自己干活的过程中暴露问题，再按优先级修掉。主控只管进度、文档和质量把关。

## 1. 角色

| 角色 | 谁 | 在哪 | 做什么 |
|---|---|---|---|
| 主控 | Claude Code 主会话 | 用户的会话 | 拆任务、写任务说明、盯进度、合并、同步文档、分拣 mmp 问题、向用户汇报 |
| 编码 | mmp，`magpie` 的 `claude/claude-sonnet-5-5`，thinking `high` | Herdr pane，cwd 是任务的 worktree | 按任务说明实现、写测试、提交 |
| 编码（升级） | mmp，`claude/claude-opus-5-5`，thinking `high` | 同上 | 同一任务被退回 2 轮、或修复引入倒退时接手 |
| 初审 | mmp，`claude/claude-opus-5-5`，thinking `high` | 另一个 pane，同一 worktree，只读 | 每个任务合并前审查：复现、分级、写审查报告 |
| 终审 | Fable（主控的只读 subagent） | 主控会话 | 大节点审查：主控把一个阶段的改动打成审查包交给它（见第 5 节） |
| 调研 | agy（`agy -p`）或 mmp | — | 同现在；写进 scratchpad，主控核对后再用 |

用哪个模型、什么 thinking 级别，由启动命令决定（第 3 节），不靠 mmp 的默认设置。

## 2. 两个 mmp：工具版和开发版

自己改自己有个风险：改坏了就没法用它来修。所以分两份：

```
工具版（tool）   ~/Desktop/Projects/sides/mmp-tool  ← 最近一次验收通过的提交（git worktree，detached）
                 用它干活：编码、审查都跑 `node <tool>/dist/cli.js`
开发版（dev）    .claude/worktrees/<任务>/           ← 正在改的代码
                 只用来跑测试和 Herdr 验收，不用来干活
```

- **升级工具版**：每次合并、通过 Herdr 验收、并跑完 [e2e-acceptance.md](e2e-acceptance.md) 里标 ★ 的冒烟条目后，主控把工具版切到新的提交（`git -C mmp-tool checkout --detach <commit>` 再 `npm run build`）。这样新功能马上进入日常使用，问题尽早暴露。
- **回退**：工具版出了阻塞问题（第 6 节 P0），先把工具版切回上一个提交继续干活，同时开任务修。实在修不动时，这个任务退回到现在的做法（Claude Code 的 Sonnet/Opus subagent），修好后再切回来。
- 两份共用用户真实的 `~/.mmp`（凭证、会话、magpie 配置）。自动测试照旧用临时 `HOME`/`MMP_HOME`，不受影响。

## 3. 启动一个 mmp 工作者

仓库根目录提交一份项目 Manifest（`.mmp/mmp.json`，要从 `.gitignore` 里放开这一个文件），把开发规范作为 Rules 声明进去，每个 worktree 都自动带上：

```json
{ "version": 1, "rules": ["../AGENTS.md", "../docs/dev-workflow-herdr.md"], "skills": [], "extensions": [] }
```

（MMP 不自动读 `AGENTS.md`，必须声明成 Rules 才会进 system prompt。）

启动命令（主控在 pane 里执行，`--approve` 只让这一次信任 worktree 的 `.mmp/mmp.json`，不写进信任记录）：

```bash
cd <worktree> && node ~/Desktop/Projects/sides/mmp-tool/dist/cli.js --approve \
  --provider magpie --model claude/claude-sonnet-5-5 --thinking high
```

审查者把模型换成 `claude/claude-opus-5-5`。每个任务用一个新会话，不复用上一个任务的上下文。

## 4. 任务交接：用文件，不靠读屏

每个任务在仓库里有一个不提交的目录 `.dev/tasks/<编号>/`（加进 `.gitignore`）：

| 文件 | 谁写 | 内容 |
|---|---|---|
| `brief.md` | 主控 | 任务说明，格式同现在第 3 节（起点、规格来源、状态清单、测试要求、测试卫生、边界、交付） |
| `report.md` | 编码者 | 每项做了什么、对照了 Pi 的哪些函数、测试数、没验证的地方；最后一行 `STATUS: done` 或 `STATUS: blocked` |
| `question.md` | 编码者 | 需要主控决定的问题；写完就停下等 |
| `review-N.md` | 初审 | 第 N 轮审查：结论（可合并 / 不可合并）、按严重程度排的发现，每条标 CONFIRMED 或 PLAUSIBLE、附文件行号和复现命令 |

流程：

```
主控写 brief.md
  → pane 里发一行：Read .dev/tasks/<id>/brief.md and do the task. Write your report to .dev/tasks/<id>/report.md.
  → 等：herdr pane wait-output <pane> --match "STATUS:"（再读 report.md 确认），超时就读屏看卡在哪
  → 有 question.md → 主控回答（send-text）→ 继续等
  → report.md 写完 → 主控看 diff、跑 npm test
  → 初审 pane：Review the diff of <branch> against pi-087-upgrade per .dev/tasks/<id>/brief.md; write .dev/tasks/<id>/review-1.md. Do not modify files.
      审完主控检查 worktree `git status` 仍然干净（mmp 没有权限系统，只读靠指令 + 事后检查）
  → 不可合并 → 把 review-N.md 发给编码者修 → 再审（只审新提交，但重跑上一轮全部复现命令）
  → 可合并 → 主控合并、跑完整测试、Herdr 验收 → 升级工具版
  → 一个阶段的任务都合并后 → 主控打审查包交 Fable 终审（第 5 节）
```

退回时主控先把上一轮的 `report.md` 改名为 `report-N.md` 再发指令，否则旧文件里的 `STATUS:` 会让等待立刻结束（D2 试跑时发现）。

退回规则、测试要求、策略问题由主控拍板等，和 [dev-workflow.md](dev-workflow.md) 第 2 节一样。

## 5. 质量把关

- **初审**：每个任务合并前都要，由 mmp（opus）做。
- **终审（Fable）**：只在大节点做（用户 2026-09-30 定），不逐个任务审。大节点指一个阶段的功能做完、准备验收的时候，例如"Pi 0.99 + MCP"、"/settings"这样一组任务全部合并后，或者工具版要跨大版本升级前。
- **审查包**：主控在 `.dev/milestones/<名字>/pack.md` 里打包，交给 Fable：

  | 内容 | 说明 |
  |---|---|
  | 目标和范围 | 这个阶段要做成什么，对应哪些设计文档章节和决策编号 |
  | 提交范围 | `git log <上一个大节点>..<现在>`，每个任务的分支和合并提交 |
  | 每个任务的材料 | `brief.md`、`report.md`、各轮 `review-N.md` 的路径，以及初审没解决的分歧 |
  | 风险清单 | 主控标出碰到硬规则（配置隔离、信任、密钥、对外接口）和复杂状态的文件和函数，请 Fable 重点看 |
  | 证据 | 完整测试的输出、模型可见快照的差异、Herdr 验收的步骤和画面 |
  | 已知问题 | `docs/dogfood-issues.md` 里这个阶段新增、还没修的条目 |
  | 要 Fable 回答的问题 | 主控拿不准的具体点 |

  Fable 的结论照旧：可合并/不可合并、按严重程度排的发现（CONFIRMED / PLAUSIBLE、文件行号、复现）。不通过的发现拆成任务交回 mmp 修，修完主控再打一个小的补充包复查。
- **质量记录**：`subagent-quality-log.md` 继续记，作者一栏写 `mmp-sonnet` / `mmp-opus`，另记"初审放过、被 Fable 在大节点查出"的问题数——这是判断初审能不能信任的依据。

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
| reviewer | 初审 |
| check | 主控的 Herdr 验收、跑命令。用户可能随时关掉它，用之前先确认还在（`herdr.sh` 找不到 pane 会直接报错），不在就重新 split 一个 |
| grok | 对比 grok（需要时开） |

mmp 不是 Herdr 认识的 agent 类型，所以用 pane 命令（`pane run` / `send-text` / `wait-output` / `read`）操作，pane 编号记在 `.dev/panes.json`。现在放在 scratchpad 的辅助脚本 `h.sh`（`startmmp` / `quitmmp` / `say` / `scr`）移进仓库 `scripts/dev/herdr.sh`，因为 scratchpad 只在当前会话有效。

## 8. 启用前要做的准备

| # | 事项 | 说明 |
|---|---|---|
| 1 | MMP 自己的 magpie 配置 | **已完成（2026-09-30）**：`~/.mmp/extensions/magpie/index.mjs` 用 `pi.registerProvider` 注册 magpie，全局 Manifest `~/.mmp/mmp.json` 声明它。配置是从 magpie 接给 Pi 的那份手动复制来的，不读 Pi 的文件；magpie 改地址、key 或模型时手动改这个文件。`mmp -p` 实测 sonnet-5.5 和 opus-5.5 都能回复 |
| 2 | 工具版 | 建 `mmp-tool` worktree，切到验收通过的提交，`npm install` + `npm run build` |
| 3 | 项目 Manifest | **已完成**：`.mmp/mmp.json`（第 3 节），`.gitignore` 放开它、忽略 `.dev/` |
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
