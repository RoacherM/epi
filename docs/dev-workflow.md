# Epi 开发流程

代码规范与预检见 [code-quality.md](code-quality.md)，冒烟清单见 [e2e-acceptance.md](e2e-acceptance.md)，实现与契约见 [development.md](development.md)，拍板记录见 [decisions.md](decisions.md)。

**核心原则**：机器检查先行；同一段代码只按一个完整功能或重构在完成时盲审一次（中途开发包不单独审，也不设重复的阶段终审；原先逐包审加阶段终审让同一段代码被审两遍，对 2026 年 10 到 11 月评审日志的统计显示多轮复审占了 87% 的评审耗时，且近半数复审抓到的是上一轮修复引入的新问题）；失败可见（不吞错、不静默兜底）。

## 1. 角色与分工

| 角色 | 用什么 | 职责 |
|---|---|---|
| 主控 | epi / agy 主会话 | 计划、预检、功能完成时启动一次全量评审、合并、Orca 实测、汇报 |
| worker | epi + magpie `claude-opus-5-5`（thinking `high`），独立 `dev/<id>` worktree | 实现、写测试、提交、交 `report.md` |
| 阅读子代理 | 内置 `task` 工具 + `reader`（`factory/deepseek-v4.1-flash`，只读） | 读不打算改的源码或长文档，结论带 `文件:行号` |
| 执行子代理 | 内置 `task` 工具 + `runner`（flash，只跑 `bash` 不改文件） | 跑全套测试、构建、基准，只回报结果与失败项 |
| 审查子代理 | `agy` 并行盲审（`gemini-4-carbon-high` + `gemini-4-argon-high`），由 `scripts/review.sh` 转调全局评审执行器驱动 | 功能或重构完成（或触及高风险路径）合入 `main` 前盲审一次冻结副本 |

- **本地 Git 钩子（`.githooks/pre-commit` 与 `.githooks/pre-merge-commit`，`core.hooksPath=.githooks`）**：转调 `scripts/review.sh hook-pre-commit`（读取 `.review.json`）：① 不允许在 `main` 直接提交 `src/**`；② 在 `main` 执行 `git merge --no-ff`（无论有无冲突）时均运行 `check-gate`，只改文档或测试直接放行，触及高风险路径或属功能/重构分支凭 `verified.sha` 放行，带 `test/**` 改动且未碰高风险路径的修复分支凭 `fix.sha` 放行；③ 提交 `src/**` 时检查无半暂存且 `dist/` 与构建产物一致。
- **子代理（WF5）**：用内置 `task` 工具并发派发互不依赖的阅读或长命令，不再装 `npm:pi-subagents`。子代理默认 `rules: false`、`skills: false`（`src/assembly.ts`）；派发执行代码修改的 `task` 子代理时传 `rules: true, skills: ["vibe-coding", "ub-mode"]`，让子代理直接继承仓内开发规范与预加载技能。

## 2. 任务闭环（合并原 N3 逐包评审与 N6 阶段终审）

1. **计划**：界面、交互、流程设计先写 `scripts/probes/<名字>-prototype.html`，等用户试用同意后再改 `src/`（决策 WF6）。派 worker 时写 `.dev/tasks/<id>/brief.md`。一个功能中途的提交或子开发包不单独送审。
2. **实现与机器预检**：在 `dev/<id>` 分支完成代码与测试（修复前失败、修复后通过）。`scripts/dev/run-review.sh` 保留为指向 `scripts/review.sh` 的薄转发入口：
   - 功能或重构：`scripts/review.sh precheck <id> main HEAD`。
   - 带复现测试的 bug 修复：`scripts/review.sh precheck --fix <id> main HEAD`（脚本校验含 `test/**` 改动且未碰高风险路径后写 `fix.sha`；碰高风险路径或缺测试改动时拒绝 `--fix`）。
3. **一次全量评审**：带 `fix.sha` 的非高风险修复、纯文档或测试改动直接进合并；功能、重构及高风险改动跑 `scripts/review.sh start <id> HEAD` → `scripts/review.sh wait <id>` → `scripts/review.sh verify <id> HEAD` 签发 `verified.sha`（可按需先写自定义 `.dev/reviews/<id>/pack.md`，未写时由统一脚本自动生成）。
4. **合并与实测**：`git merge --no-ff dev/<id>` 合入 `main`；界面改动在 Orca 跑 [e2e-acceptance.md](e2e-acceptance.md) ★ 条目。

## 3. 本仓评审参数（遵循 `vibe-coding` 统一评审规则）

评审流程由 `vibe-coding` Skill 的「统一评审规则」和全局执行器 `~/.agents/skills/vibe-coding/scripts/review.sh` 统一规定，本仓不另立流程，参数均配在 `.review.json`：

1. **预检命令（`precheck`）**：`scripts/dev/precheck.sh` 在冻结副本内依次执行 `npm run build`、`git diff --exit-code -- dist`、`tsc --noEmit --noUnusedLocals --noUnusedParameters`、`model-snapshot.mjs --diff`、改动 `src/**/*.ts` 的 ESLint + `sonarjs` 检查，以及禁网沙箱全套测试。
2. **高风险路径（`highRisk`，触及任一路径时再小也审）**：
   - **线协议 / IPC / MCP**：`src/noninteractive.ts`、`src/worker.ts`、`src/worker-reaper.ts`、`src/monitor-stream.ts`、`src/extensions/mcp.ts`、`src/commands/mcp-cli.ts`
   - **凭证与环境隔离**：`src/commands/auth-cli.ts`、`src/providers/**`、`src/provider-startup.ts`、`src/provider-validation.ts`、`src/web/config.ts`、`src/isolate-pi-env.ts`、`src/pi-env.ts`
   - **权限白名单、信任与门禁边界**：`src/bash-guard.ts`、`src/trust-prompt.ts`、`src/tui/project-guard.ts`、`src/manifest.ts`、`src/commands/manifest-cli.ts`、`src/skill-discovery.ts`、`src/hooks-config.ts`、`src/hooks-runtime.ts`、`src/extensions/hooks.ts`、`src/extensions/runtime.ts`、`.review.json`、`.githooks/**`、`scripts/review.sh`、`scripts/dev/{run-review.sh,precheck.sh,eslint.config.mjs}`
   - **持久化、装配与自更新发版**：`src/task-runtime.ts`、`src/task-worktree.ts`、`src/paths.ts`、`src/project.ts`、`src/assembly.ts`、`src/host.ts`、`src/update.ts`、`scripts/release.mjs`、`install.sh`
3. **分片、目录与修复确认**：非生成文件全量 diff 超过 2000 行时按 `.review.json` 的 `shards`（`tui`、`extensions`、`task`、`core`）自动切分并行双审；评审产物写 `.dev/reviews/<id>/`；非阻塞意见（P2/P3）记入 `docs/dogfood-issues.md`；阻塞修复跑过 `precheck <id>-r2 <fix-base> HEAD` 后，用 `scripts/review.sh confirm <id>-r2 <carbon|argon> <fix-base> HEAD` 由原阻塞模型单审修复 diff 与碰到的文件。

## 4. 交接物与目录

除合并提交外均在 `.dev/` 下（不入库）：任务放 `.dev/tasks/<id>/{brief,report,question}.md`，审查放 `.dev/reviews/<id>/{pack.md,diff.patch,shards/,precheck.log,precheck.sha,fix.sha,review-*.md,review.md,verified.sha}`。本地自开发按需复制 `(set -C; mkdir -p .epi && cat examples/development/epi.json > .epi/epi.json)`，只将 `["../AGENTS.md"]` 注入常驻规则，避免把整篇流程文档变回常驻预读。

## 5. 不可违反的约定

- **硬规则（一票否决）**：① **配置不与 Pi 共享**（状态只在 `~/.epi/pi`，不读写 `~/.pi/agent`、项目 `.pi/` 或用户 `PI_*`，固定传 `--no-approve`；skills 只走 `~/.agents/skills`、`~/.epi/skills`、受信 `.epi/skills` 和 Manifest；MCP 只走 Epi 的 `mcp.json`）；② **项目配置先信任后读取**；③ **不泄露密钥**；④ **失败可见**（不吞错、不静默兜底）；⑤ **对外只有 `epi`**（参数、子命令、帮助、报错全归 `epi`）；⑥ **Pi 内部接口**登记在 [pi-internals.md](pi-internals.md) 并配测试；⑦ **版本号唯一来源**是 `package.json`。
- **扩展位置**：不做自动发现，只认 Manifest 声明（用户 `~/.epi/extensions/<名>/`、受信项目 `.epi/extensions/<名>/`）；不读取 Pi 自己的扩展目录（由 `test/ambient-isolation.test.mjs` 守卫）。
- **Issue 账本（`docs/dogfood-issues.md`）**：编号 `D1…`，含级别、现象、复现、状态。P0 立刻修；P1 插到下一任务；P2 攒几条修；P3 空闲批量修。

## 6. Orca 实测

- 开/关终端：`orca terminal create --worktree active --title epi-smoke --json`（记下 `handle`，不碰用户正在用的终端），测完 `orca terminal close --terminal <handle> --json`。
- 启动与按键：确认前台是 shell 后发 `node dist/cli.js`（`--enter`）；按键不加 `--enter`（`$'\x0f'` Ctrl+O，`$'\x1b'` Esc，`$'\x04'` Ctrl+D 退出并等清理 >2s）；鼠标发 SGR 序列。
- 读屏与剪贴板：`orca terminal read --terminal <handle> --json` 看 `result.terminal.tail`；测粘贴前 `pbpaste` 备份、测完恢复。

## 7. 发版清单

`release: <版本> …` 推送前完成（由 `test/showcase.test.mjs` 和 `test/naming.test.mjs` 守卫）：

1. **核对评审记录（不重审已审功能）**：核对上一版本 tag 以来合入 `main` 的每个功能分支都有对应的 `.dev/reviews/*/verified.sha`（非高风险修复有 `fix.sha`）；只有缺少记录的部分才补审，已审过的功能不重审。
2. **`README.md` 与展示**：更新「最近更新」，生成 `docs/showcase/<版本>/` 并更新索引；界面变化时跑 `node scripts/docs/capture-ui.mjs`。
3. **全套测试与本地 CI**：先 `git add`/提交确保新媒体入库，再跑 `npm test` 和 `scripts/dev/local-ci.sh`。
4. **先问用户确认后发布**：执行 `scripts/dev/local-ci.sh --release`（推 `main` 并跑 `scripts/release.mjs` 打 tag、发 `epi-<版本>.tgz` 和 `install.sh`）。
