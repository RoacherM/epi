# Epi contributor entrypoint

Epi 是建在锁定版本 Pi SDK 之上的定制编码终端 Harness：拥有 CLI、TUI 界面、显式装配与内置扩展；Agent 循环、会话与基础工具归 Pi 内核，不 fork。开始工作前先读本文件和 [架构设计（原则）](docs/architecture.md)。

## 1. 目录与边界测试（The Boundary Test）

| 目录 | 职责 | 放进这里的判断标准 |
|---|---|---|
| `src/` + `dist/` | CLI、装配、内置扩展与 TUI 源码；`dist/` 为同步提交的构建产物 | 是在改 Epi 的装配、扩展或界面，而非改 Pi 内核吗？ |
| `test/` | 免预启动离线单测与契约测试 | 不联网、只用临时 `HOME`/`EPI_HOME`，不碰真实 `~/.epi` 或剪贴板能跑通吗？ |
| `scripts/dev/` | 本地 CI 与机器预检（`local-ci.sh`、`precheck.sh`） | 是在跑本地构建、复杂度或门禁检查吗？ |
| `scripts/probes/` | 可交互 HTML 原型与外部行为一次性探针 | 是在做用户试用的交互原型，或验证外部系统的未知行为吗？ |
| `.dev/`（Git 忽略） | 子任务交接文件与 `.dev/reviews/` 冻结评审产物 | 是单次开发或评审的本地过程文件吗？ |

## 2. 按任务读取文档（改到对应内容时才读，避免开工全量扫 `docs/`）

- 改分支合入、子代理分工、Orca 验收或发版：读 [开发流程](docs/dev-workflow.md) 与 [端到端验收](docs/e2e-acceptance.md)
- 改 TypeScript 规范、复杂度上限或测试隔离：读 [代码规范与质量检查](docs/code-quality.md)
- 改 CLI 参数、Manifest、Hooks、MCP 或用到 Pi 内部接口：读 [实现与契约](docs/development.md) 与 [Pi 内部接口登记](docs/pi-internals.md)
- 查历史拍板边界或登记非阻塞问题：读 [已定决策](docs/decisions.md) 或 [dogfood-issues.md](docs/dogfood-issues.md)
- 改具体模块时读对应单篇设计（如 `docs/{tui,mcp,subagents,cli,magpie,web-search}-design.md`）；`docs/notes/` 只在追溯调研背景或用户要求时查阅，以免旧笔记干扰当前实现

## 3. 常用命令

```sh
npm test                                                           # 构建 + 离线单测（秒级启动，零外部副作用）
npm run typecheck                                                  # TypeScript 类型检查（tsc --noEmit）
node scripts/model-snapshot.mjs --diff test/snapshots/model-visible.json  # 模型可见契约快照比对
scripts/dev/local-ci.sh                                            # 干净 worktree 跑完整本地 CI（加 --release 先问用户）
scripts/review.sh precheck <id> main HEAD                          # 机器预检并冻结快照（修复加 --fix；随后 start / wait / verify）
```

## 4. 开发规范

1. **外部检查判定结果**：用 `npm test`、`npm run typecheck` 与 `model-snapshot.mjs --diff` 验收，避免凭主观印象判断完成。修 bug 先写出在旧代码上失败、新代码上通过的测试；改完代码对改动文件跑 `ub-mode`（复杂度、重复度、变异测试），提前拦住低阶缺陷。
2. **目标环境验证**：改完 `src/` 用 `npm run build` 同步 `dist/`，不手改 `dist/` 或 `~/.epi` 安装态副本，以免下次构建或升级被覆盖。界面改动在 Orca 隔离终端（`orca terminal create --worktree active --title epi-smoke --json`）跑 `node dist/cli.js` 核对 [e2e-acceptance.md](docs/e2e-acceptance.md)；未跑 Orca 或真实模型时写明「尚未在目标环境验证」。调付费真实模型前先问用户。
3. **本窗口隔离测试**：测试使用临时 `HOME`/`EPI_HOME`，不联网、不碰真实凭证或系统剪贴板，避免污染本机环境。在当前会话终端和新端口跑验证，除非用户要求不开新窗口或抢占键鼠焦点；Orca 冒烟测完只关自建的 `handle`，以免关掉用户的终端。
4. **设计先出可交互 HTML 原型**：界面、交互或流程设计先交 `scripts/probes/<名字>-prototype.html`，等用户亲自试过并同意后才改 `src/`、才合并（决策 WF6），避免方向未定造成返工。无界面和接口取舍的明确改动直接做完闭环。
5. **分支、构建与原子提交**：不在 `main` 分支直接提交 `src/` 改动，切 `dev/<id>` 分支开发，保证合入前经过预检或评审门禁。`dist/` 与 `src/` 同步提交，并用 `git commit --only -- <本次改动路径>` 提交，防止把并行会话未完成的改动卷入提交。
6. **活文档与决策同步**：改 CLI、Manifest、Hooks、MCP 或开发流程时，同步更新 `docs/{development,dev-workflow,code-quality,pi-internals}.md`（改协议或持久化格式前先写清兼容行为），避免旧文档误导后续会话。定下会约束后续工作的决定时，当轮写进 [docs/decisions.md](docs/decisions.md)，写明原因和被否掉的选项。写文档引用代码前重读源文件核实，探针结论标明依赖版本与日期。
7. **单篇自包含设计文档**：每个子系统只维护一份当前自包含文档（如 `docs/{tui,mcp,subagents}-design.md`），让只读这一份文件的读者也能看懂完整流程与术语，避免多份残片说法打架。一次性调研放 `docs/notes/`，旧方案及时清理或归档。
8. **独立评审**：按 `vibe-coding` Skill 的「统一评审规则」对完整功能或重构做一次全量评审，避免拆小包和阶段终审把同一段代码审两遍；本仓不另立评审流程，发版前只核对 `main` 评审记录、不重审已审功能。本仓参数写在 `.review.json`（预检 `scripts/dev/precheck.sh`、高风险路径、超 2000 行按 `tui`/`extensions`/`task`/`core` 切分、评审目录 `.dev/reviews`、非阻塞意见记 `docs/dogfood-issues.md`），由薄入口 `scripts/review.sh`（兼容旧入口 `scripts/dev/run-review.sh`）和 `.githooks/{pre-commit,pre-merge-commit}` 转调全局评审脚本。

## 教训

<!-- 本仓犯过的错和被纠正过的做法写在这里，每条一行写清情境、做法与原因；写法见 ~/.agents/corrections/README.md -->
