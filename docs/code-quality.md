# 代码规范与质量检查

状态：2026-10-02 起执行，2026-10-22 按历史审查精简并增补多入口装配、渲染属性测试与测试卫生规则（[decisions.md](decisions.md) WF4）。角色、节点与硬规则见 [dev-workflow.md](dev-workflow.md)。

## 1. 写代码的规范

| 规则 | 具体做法 |
|---|---|
| 先做最简可用版 | 复用顺序：本仓库已有代码 → 依赖（Pi SDK）→ 常见库。只有当下需要才加新层或配置项 |
| 一眼能读懂 | 函数名说清做什么；注释只写「为什么」，不复述代码、不写长篇历史（问题编号一句话带过） |
| 失败要可见 | 不静默兜底、不吞错误；一个失败不能伪装成另一个失败。只为真实发生过的失败写重试/恢复 |
| 清理死代码与无用导出 | 旧兼容分支没人用就删；只在本文件用的符号不导出（测试动态 import 的除外） |
| 对齐 Pi 与登记内部接口 | 照 Pi 写的函数在提交说明注明对照函数；引用 Pi 未导出模块或私有字段必须登记在 [pi-internals.md](pi-internals.md) 并配测试 |
| 版本号唯一来源 | 只在 `package.json`；代码、测试、文档不写死版本号 |
| 复杂度上限（新代码） | 单函数认知复杂度 ≤ 15、≤ 80 行、嵌套 ≤ 4 层、参数 ≤ 5 个；超出须拆分或在报告说明理由 |
| 多入口不重复装配 | `-p`/json、TUI、`rpc`、`worker`、`--list-models` 的启动刷新、跨项目检查、扩展加载诊断和错误提示必须走同一个 helper，禁止各入口各写一套 |
| 渲染/状态不变量用属性测试守住 | TUI 渲染（如 tip 外零整屏重绘、图片占位、折叠/展开）和复杂编辑器状态用「随机/枚举交互序列 + 只推进时钟」断言不变量，不靠每个版本手写单点探针 |
| 测试与测试卫生 | 测真实出错点，修复前失败、修复后通过；用临时 `HOME`/`EPI_HOME`、禁网、不碰真实剪贴板和 `~/.epi`；**临时目录清理必须带 `maxRetries`**（防子进程仍在写文件报 `ENOTEMPTY`）；**单个测试文件超过 25 秒要在 `report.md` 说明原因** |

## 2. 主控打包前的预检（G1 确定性门禁）

送审或合并前由主控运行 `scripts/dev/run-review.sh precheck <id> <base> <head>`（P3 修复只要改了 `src/**/*.ts` 也必须重跑），命令实现由脚本负责。**审查方直接复用 `.dev/reviews/<id>/{repo,before,precheck.log,precheck.sha}`，不再自己跑全量测试或重装 ESLint。**

| 检查项 | 通过标准 |
|---|---|
| `src/` 规模门禁 | `src/**/*.ts` 新增+删除 ≤ 800 行（超限且无 `EPI_ALLOW_LARGE_DIFF=1` 时在建副本前直接退出 2） |
| 隔离副本导出 | `head` 与 `base` 分别导出到 `.dev/reviews/<id>/{repo,before}`，含最小 `.git` 索引与 `node_modules` 软链（严禁 `git stash`） |
| 构建与 `dist/` 同步 | `npm run build` 成功且 `git diff --exit-code -- dist` 无差异 |
| 未使用变量与参数 | `tsc --noEmit --noUnusedLocals --noUnusedParameters` 零报错 |
| 模型可见快照 | `model-snapshot.mjs --diff` 无非预期变化（有变化须在报告说明） |
| 改动文件复杂度 | 改动 `src/**/*.ts` 过 ESLint + `sonarjs`（符合第 1 节上限；依赖装在 `EPI_ESLINT_DIR`，默认 `/tmp/epi-eslint`，配置由 `scripts/dev/eslint.config.mjs` 自动复制） |
| 禁网全量测试与耗时告警 | 副本禁网沙箱跑全套测试全过，写入 `precheck.sha` 与 `=== precheck passed ===`；总耗时 > 240s 打 `WARNING` |
| 修复前失败与实测（主控/审查） | 新增回归测试在 `before/` 下失败、在 `repo/` 下通过；重构命令前后输出一致；TUI 改动在 Orca 实测通过 |

## 3. 定期的 code smell 扫描（非每次审查清单项）

阶段结束或整体简化时由主控在临时副本单独运行，**不是每次任务审查或 N6 审查子代理的清单项**（审查子代理禁止自己装/跑以下工具）。结果放 `.dev/simplify/<日期>/`。

| 工具 | 查什么 | 阈值 |
|---|---|---|
| `knip@5`（把测试中 `dist/` 替换成 `src/` 后跑） | 无用文件、导出、依赖 | 新增无用导出为 0 |
| `tsc --noUnusedLocals --noUnusedParameters` | 未使用变量和参数 | 0 |
| `jscpd@4 src --min-lines 8 --min-tokens 60` | 跨文件重复代码 | 无新增大块重复 |
| `madge@8 --circular --extensions ts --ts-config tsconfig.json src` | 循环依赖 | 运行时循环为 0 |
| `eslint@9` + `typescript-eslint` + `eslint-plugin-sonarjs` | 认知复杂度/圈复杂度 ≤15、函数 ≤80 行、嵌套 ≤4、参数 ≤5 | 符合第 1 节上限 |

扫描后流程：主控跑工具 → 阅读子代理（`epi -p`）通读出带行号的 smell 报告 → 主控核实源码并拆成互不重叠的任务包 → 涉及用户/模型可见变化先与用户对齐 → 按标准流程实现与审查。
