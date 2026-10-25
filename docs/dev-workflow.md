# Epi 开发流程

状态：2026-09-30 起执行，2026-10-06 全 epi 化（WF1），2026-10-21 起用 Orca 验收，2026-10-22 按历史审查简化并硬拦门禁（[decisions.md](decisions.md) WF2–WF4）。代码规范与预检见 [code-quality.md](code-quality.md)，冒烟清单见 [e2e-acceptance.md](e2e-acceptance.md)，实现与契约见 [development.md](development.md)。

**三条原则**：**小包**（单次送审 `src/` ≤ 800 行，互不相关特性拆开审）、**作者不自审**（主控或 worker 写的代码都经独立审查，G3 超限不得自修自合）、**失败可见**（不吞错、不静默兜底、门禁脚本硬拦）。

## 1. 角色与模型

| 角色 | 用什么 | 职责 |
|---|---|---|
| 主控 | epi 主会话 | 计划、N3 审查验证、合并、Orca 实测、汇报 |
| worker | epi + magpie `claude-opus-5-5`（`devin/`、`auto/`、`factory/`），thinking `high`；独立 git worktree（`dev/<id>`），每任务每轮新开会话 | 实现（N2），写测试、提交、交 `report.md` |
| 阅读子代理 | 内置 `task` 工具 + 预设 `reader`（`~/.epi/agents/reader.md`，`factory/deepseek-v4.1-flash`，只读工具） | 大范围读代码/查资料，结论须带 `文件:行号`，主控核对原文后才用 |
| 执行子代理 | 内置 `task` 工具 + 预设 `runner`（`~/.epi/agents/runner.md`，flash，可跑 `bash`、不改文件） | 跑全套测试、构建、基准，只回报结果与失败项 |
| 审查子代理 | `epi -p` 只读会话，provider `magpie`，模型按 WF3 三级回退由 `scripts/dev/run-review.sh` 解析写入 `pack.md`，复查沿用同模型 | 阶段终审（大节点，N6）、审主控自己写的代码（G5） |
| 顾问 | `epi -p` 独立只读会话（主控把背景材料写成文件交给它） | 仅在**同一个问题第二次出现 / 方案迟迟收不拢**时调用 |
| 用户 | — | 需求歧义拍板；推送/PR/发布人工闸门（G2） |

- **审查模型三级回退（WF3）**：① `gemini-4-argon`（`auto/` 优先，`devin/`、`factory/` 次之，排除 `-disabled`）；② `claude-opus-5-5`（thinking 固定 `medium`，禁 `high`）；③ `deepseek-v4.1-flash`（`factory/deepseek-v4.1-flash`、`devin/deepseek-v4-1-flash-1017`）。一律通过 `scripts/dev/run-review.sh` 启动与等待，禁止手写 `nohup epi -p` 或固定长 `sleep`。
- **子代理（WF5，2026-10-25）**：主控与 worker 都用内置 `task` 工具委派，不再装 `npm:pi-subagents`。硬规则：
  - 要读**不打算改的**文件（Pi 的 `node_modules` 源码、长文档、别的模块）时，`task(agent="reader", task="…问题…，用 文件:行号 回答")`；只在要改的文件、或 <150 行的文件才自己读。
  - 跑全套测试（`node --test test/*.test.mjs`）、`precheck` 之外的长命令，用 `task(agent="runner", task="在 <目录> 跑 <命令>，报失败")`。
  - 互不依赖的问题**同一轮并发发出**多个 `task`；每个子代理给一块像样的工作量（几个文件），不要一个小文件一个。
  - 子代理跑偏用 `task({jobId, task})` 纠偏；结束后追问用同一个 `jobId` 续跑；`task_status({})` 查全部。
  - 子代理自己会压缩上下文；压不下时以 `partial` 结束并保留已做的工作。
- **启动 worker**：`orca terminal create --worktree <path> --title <id>`，运行 `epi --provider magpie --model devin/claude-opus-5-5 --thinking high`，发送 `Read .dev/tasks/<id>/brief.md and do the task. Write your report to .dev/tasks/<id>/report.md.`。

## 2. 一个任务（N1–N7）

设计先行（规格写进 `docs/` 并注明来源）；合并前强制审查；只提交本地分支，对外操作过 G2。

| 节点 | 执行者 | 触发 | 动作 | 检查（通过才交下一节点） | 停止与移交 |
|---|---|---|---|---|---|
| N1 计划 | 主控 | 用户需求 / dogfood / 终审发现 | 读材料 → 拆不重叠小任务 → 写 `.dev/tasks/<id>/brief.md` | 含七项（第 5 节），写明基准 SHA，`src/` 预计 ≤ 800 行 | 需求有歧义 → 问用户 |
| N2 实现 | worker | 收到 `brief.md` 指令 | 实现、写测试、worktree 提交、写 `report.md` | `report.md` 末行 `STATUS: done` | 需拍板 → 写 `question.md` 停等；卡住 → `STATUS: blocked` 交主控 |
| N3 审查验证 | 主控 | `STATUS: done` | 跑 `run-review.sh precheck <id> <base> <head>` → 过第 3 节清单 → 验修复前失败与 ≥2 个变异 | 闸门 G1 满足，`precheck.sha` 匹配被审 head | 有 P0–P2 → 写 `review.md` 退回 N2；同一问题第 2 次出现 → 问顾问；满 2 轮仍不过 → G3 |
| N4 合并 | 主控 | G1 通过 | `git merge --no-ff` 确认无冲突 → `main` 上跑完整测试 | `main` 完整测试全过 | 合并时主控改了代码 → 过 G5 再合；测试挂 → 回 N3 |
| N5 Orca 实测 | 主控 | N4 完成 | 在 Orca 真实终端、真实模型跑 [e2e-acceptance.md](e2e-acceptance.md) ★ 条目 | ★ 条目全过 | 发现问题 → 记 `docs/dogfood-issues.md` 分级处理 |
| N6 阶段终审（大节点） | 审查子代理 | 阶段合入完成（单特性已过 N3/G5，N6 只审跨特性交互） | 分配独立 `<id>`，主控跑 `precheck`、写 `pack.md`，用 `run-review.sh start/wait` 跑审查，出 `review-notes.md` 与 `review.md` | 首行「可接受」（无 P0–P2），符合第 3 节预算 | `src/` >800 行 → `precheck` 退 2 拒审；有 P0–P2 → 修完换新 `<id>` 跑增量复查；满 2 轮 → G3 |
| N7 汇报 | 主控 | 任务或阶段完成 | 汇报做了什么、验证方式、文件位置、未做项，附漏网问题/退回轮数/周期三指标 | — | 推送 / PR / 发布 → 闸门 G2 |

```
N1 计划 ─brief.md─▶ N2 实现 ─report.md─▶ N3 审查验证 ─G1─▶ N4 合并 ─▶ N5 Orca 实测 ─▶ N7 汇报 ─G2─▶ 推送/PR/发布
 ▲  ▲                │  ▲                   │                        │
 │  └──question.md───┘  └────review.md──────┘ (G3: ≤2 轮)            ▼ 阶段合入后
 └────────────────────── review.md ◀── N6 大节点终审 ◀──pack.md──────┘
```

## 3. 审查

所有复现均在 `.dev/reviews/<id>/` 隔离副本和禁网沙箱（`sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))' …`，需本地服务加 `(allow network-outbound (remote ip "localhost:*"))`）里执行，**严禁 `git stash`**。

1. **800 行硬拦与冻结 head**：`run-review.sh precheck` 开头检查 `src/**/*.ts` 新增+删除行数，> 800 行（且未设 `EPI_ALLOW_LARGE_DIFF=1`）直接打印 `need split (>800 lines in src/)` 退出 **2**（不建副本）。审查期间不得修改被审分支引用。
2. **复用 `precheck` 与 `precheck.sha` 门禁**：`precheck` 成功后写入 `precheck.sha`（`git rev-parse <head>`）和 `=== precheck passed ===`。`run-review.sh start` 强制校验 `precheck.sha` 等于被审 head 且 `precheck.log` 含通过标记，否则退出 **1**。审查方直接复用副本与日志，**禁止重跑全量测试、禁止重装 ESLint/knip**。
3. **审查 6 项短清单**：① 对照 `brief.md` 无越界改动；② 新测试在 `before/` 下修复前失败 + 至少 2 个故意改坏（变异）检查；③ 硬规则零违约（第 6 节）；④ 状态在启动、切会话、`/new`、`/resume`、`/reload`、中止、退出时均正确；⑤ 认知复杂度 ≤15、≤80 行、嵌套 ≤4、参数 ≤5（看 `precheck.log`）、无死导出、测试隔离；⑥ 模型可见快照差异已说明。
4. **P0–P2 与 P3 规则（WF4）**：
   - **P0–P2**（阻塞合并）：必须标 `CONFIRMED` 并附可执行 `.mjs` 复现探针。
   - **P3**（文案、小毛病、整洁项）：只写 `文件:行号` 与一行 `rg`（标 `PLAUSIBLE`），**不要求为 P3 写 `.mjs` 探针**；首轮只有 P3 则判「可接受」，不开第 2 轮。
   - **P3 不能免检**：P3 修复只要改了 `src/**/*.ts`，合并前**必须跑 `precheck`**；与 P0–P2 同修时，其 `src/` diff **一并纳入增量复查**。
5. **首轮与增量复查预算**：首轮墙钟 ≤ **20 分钟**、输出 ≤ **40k token**、轮次 ≤ **45**；第 2+ 轮增量复查（换新 id，如 `0.1.24-r2`）墙钟 ≤ **10 分钟**、输出 ≤ **20k token**、轮次 ≤ **25**，只做三步：① 新副本重跑上轮失败探针；② 新回归测试在 `before/` 失败；③ 只读 `git show <fix-commit>`（含同修 P3 的 `src/` diff），每条修复最多写 1 个 ≤3s 绕过探针。到预算立即收口写结论 +「未覆盖」。
6. **工具纪律**：每条命令前分析 ≤ **10 行**；`grep`/`rg` 只定位，读源码必须并行调 `read`，**禁止用 `bash` 的 `cat/head/sed` 逐段读源码**。

## 4. 闸门与停止条件

| 闸门 | 位置 | 通过条件與停止条件 | 谁判断 |
|---|---|---|---|
| G1 合并 | N3 → N4 | `precheck` 全过（含 P3 改 `src/` 后的复跑）、新测试修复前失败已验、TUI 改动已 Orca 实测、无 P0–P2。偶发失败必须查因修掉 | 主控 |
| G2 对外 | N7 之后 | 推送、开 PR、发布每次均需用户明确同意 | 用户 |
| G3 退回上限 | N3/N6 退回或复查的返回路径 | 退回或复查上限 **2 轮**。满 2 轮仍不过立即停止循环：① 若原代码作者是 worker，由主控拆小、接手（按 G5 审）或问顾问；② **若原代码作者就是主控，严禁自修自合，必须拆成 `src/` ≤ 300 行的小包重走 G5，或回退重做**（WF4） | 主控 |
| G5 作者不自审 | 主控写代码合入前 | 主控自己写的代码（含接手任务、合并修改）一律由审查子代理按第 3 节审过，无 P0–P2，`src/` ≤ 800 行且 `precheck.sha` 匹配 | 审查子代理 |

## 5. 交接物与目录

除合并提交外均在 `.dev/` 下（不入库）：任务放 `.dev/tasks/<id>/`，审查放 `.dev/reviews/<id>/`（每轮独立 `<id>`），阶段材料放 `.dev/milestones/<名字>/`。

- **`brief.md`**（`.dev/tasks/<id>/brief.md`）七项：① **起点**（`git merge --ff-only origin/main` 含基准 SHA，软链 `node_modules`，禁擅自 `npm install`）；② **规格来源**（设计文档章节与对照的 Pi 函数）；③ **状态清单**（列出状态及启动/切会话/`/new`/`/resume`/`/reload`/中止/退出重置路径）；④ **测试要求**（修复前失败、40/80/120 列边界、禁人为多渲染；开发中单跑相关测试，交付前跑全套）；⑤ **测试卫生**（临时 `HOME`/`EPI_HOME`、禁网、不碰真实剪贴板与 `~/.epi`、清理带重试）；⑥ **边界**（不碰并行任务文件）；⑦ **交付**（提交附 `Co-Authored-By`，写 `report.md`，末行 `STATUS: done/blocked`）。
- **`report.md` / `question.md`**：重派前把旧 `report.md` 改名 `report-1.md`…；回答 `question.md` 后同一步改名 `question-1.md`…。
- **`pack.md`**（`.dev/reviews/<id>/pack.md`）：写明基准与锁定 head SHA、WF3 模型 ID 与预算、`.dev/reviews/<id>/{repo,before,precheck.log,precheck.sha}`、目标与风险清单；复查轮附修复 SHA（含同修 P3 的 `src/` 改动）、上轮探针与新回归测试。
- **`review.md`**（`.dev/reviews/<id>/review.md`）：边查边记 `review-notes.md`，汇总成 `review.md`。首行「可接受」或「不可接受」，P0–P2 标 `CONFIRMED` 附探针，P3 标 `PLAUSIBLE` 附 `文件:行号`。`run-review.sh wait` 退出码：`0` 有 `review.md`、`3` 无 `review.md`、`124` 超时。
- **合并提交**：标题 `Merge dev/<id>: …`，正文写明作者、审查结论与主控改动。
- **三个指标**：**漏网问题** = 合并后或大节点才查出的 P1/P2 数（注明是不是审查放过的）；**退回轮数** = 该任务退回 N2 + 复查的次数；**周期** = 从写好 `brief.md` 到合并进 `main` 的时长。

## 6. 不可违反的约定

- **硬规则（一票否决）**：① **配置不与 Pi 共享**（状态只在 `~/.epi/pi`，禁读写 `~/.pi/agent`、项目 `.pi/`、用户 `PI_*`，固定传 `--no-approve`；skills 只走 `~/.agents/skills`、`~/.epi/skills`、受信 `.epi/skills` 和 Manifest；MCP 只走 Epi 的 `mcp.json`）；② **项目配置先信任后读取**；③ **不泄露密钥**；④ **失败可见**（不吞错、不静默兜底）；⑤ **对外只有 `epi`**（参数、子命令、帮助、报错全归 `epi`，多入口共用同一套诊断装配）；⑥ **Pi 内部接口**必登记在 [pi-internals.md](pi-internals.md) 并配测试；⑦ **版本号唯一来源**是 `package.json`。
- **扩展位置**：不做自动发现，只认 Manifest 声明（用户 `~/.epi/extensions/<名>/`、受信项目 `.epi/extensions/<名>/`）；Pi 扩展目录一律不读（`test/ambient-isolation.test.mjs` 守卫）。
- **Dogfood 分级（`docs/dogfood-issues.md`）**：编号 `D1…`，含级别、现象、复现、状态。**P0**（卡住开发流程）立刻开任务修；**P1**（行为错/安全/隔离/丢数据）插到下一任务；**P2**（能用但别扭/显示错/性能差）攒几条修；**P3**（小毛病/文案/测试整洁）空闲批量修。
- **仓库文件与本地 `.epi/epi.json`**：`AGENTS.md` 只做入口；`dist/` 同步提交；本地自开发按需复制模板 `(set -C; mkdir -p .epi && cat examples/development/epi.json > .epi/epi.json)`，内容为 `{ "version": 1, "rules": ["../AGENTS.md", "../docs/dev-workflow.md"], "skills": [], "extensions": [] }`（路径相对 `.epi/` 解析）。

## 7. Orca 实测

- 开/关终端：`orca terminal create --worktree active --title epi-smoke --json`（记下 `handle`，禁碰用户终端），测完 `orca terminal close --terminal <handle> --json`。
- 启动与按键：确认前台是 shell 后发 `node dist/cli.js`（`--enter`）；按键不加 `--enter`（`$'\x0f'` Ctrl+O，`$'\x1b'` Esc，`$'\x04'` Ctrl+D 退出并等清理 >2s）；鼠标发 SGR 序列。
- 读屏与剪贴板：`orca terminal read --terminal <handle> --json` 看 `result.terminal.tail`（算点击坐标时补回被省掉的空行）；测粘贴前 `pbpaste` 备份、测完恢复（非文本先告知用户）；重影先用 `script` 录原始输出在 pyte 回放。

## 8. 发版清单

`release: <版本> …` 推送前完成（由 `test/showcase.test.mjs` 和 `test/naming.test.mjs` 守卫）：

1. **`README.md`「最近更新」**：新版本写在最前，链接 `docs/showcase/<版本>/`。
2. **特性展示**：生成 `docs/showcase/<版本>/`（含 `README.md`、录屏/截图或「本版本无界面变化」说明；场景脚本放 `scripts/docs/showcase/<版本>.mjs`，用 `node scripts/docs/capture-showcase.mjs <版本>` 生成；宣发文案放 `announce.md`），更新 `docs/showcase/README.md` 索引。
3. **README 截图**：界面变化时跑 `node scripts/docs/capture-ui.mjs` 更新 `docs/assets/epi-ui.png` 与 `epi-welcome.png`。
4. **先 `git add`/提交再跑全套测试**：确保新媒体文件已被 git 跟踪，再跑 `npm test`。
5. **本地 CI**：`scripts/dev/local-ci.sh`，在干净 worktree 里按 `ci.yml` 的步骤（`npm ci --ignore-scripts` → build → `dist/` 一致 → `npm test`）跑一遍，约 4 分钟，不用等 GitHub。
6. **过闸门 G2 推送并发布**：`scripts/dev/local-ci.sh --release` 在 CI 通过后推 `main` 并在本机跑 `scripts/release.mjs`（`gh` 已登录）；GitHub 上的 `release.yml` 随后发现 tag 已存在，直接跳过。产物含 `epi-<版本>.tgz` 和 `install.sh`。

## 9. 已知质量风险与下一批任务

**当前三大质量风险（历史审查证据）**：
- TUI 渲染层（`app.ts` 31 次修复、`paste-chips.ts` 78.9% 提交在修 bug），tip 不变量连续三个版本破防；
- 多入口装配重复；
- 大包送审导致审查修复占最近三个 release 的 32.6%。

**下一批任务**：
- TUI：任意交互后只推时钟、`fullRedraws` 增量为 0 的参数化测试；图片行改显式元数据；
- 把五个入口的诊断装配收口到一个模块；
- 测试：慢测试（>25s）要在 report 说明；临时目录清理带重试。
