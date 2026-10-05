# 代码规范与质量检查

状态：2026-10-02 用户确认（"把我们的代码开发规范、代码质量检查写到文档中，后续按照这个模式进行"）；2026-10-03 角色、审查清单和记录移到流程文档。流程（谁拆任务、怎么交接）见 [dev-workflow-herdr.md](dev-workflow-herdr.md)；不可违反的约定见 [dev-workflow.md](dev-workflow.md) 第 5 节。本文只管两件事：代码写成什么样，合并前和阶段结束时怎么检查。

## 1. 角色和模型

谁编码、谁审查、用什么模型，见 [dev-workflow-herdr.md](dev-workflow-herdr.md) 第 2 节。本文用到的"主控""worker""修复前失败"等术语也在那里第 1 节定义。

## 2. 写代码的规范

| 规则 | 具体做法 |
|---|---|
| 先做最简单能跑通的版本 | 复用顺序：本仓库已有代码 → 依赖（Pi SDK）→ 常见库。只有现在就需要时才加新的层、配置项或脚本 |
| 新人第一次读就能懂 | 函数名说清做什么；需要注释才看得懂的代码先改简单。注释只写"为什么"，不复述代码，不写长篇历史（问题编号一句话带过） |
| 失败要可见 | 不静默兜底、不吞错误；一个失败不能表现成另一个失败。只为真实发生过的失败写重试或恢复，恢复不了就停下并报告 |
| 旧路径只在还有人用时保留 | 兼容层、迁移表、空的占位分支，没人用就删 |
| 对齐 Pi | 功能和 Pi 一致；照着 Pi 写的函数在提交说明里写出对照的 Pi 函数，结构尽量和 Pi 对应，方便升级时比对 |
| Pi 内部接口要登记 | 引用 Pi 未导出的模块或私有字段，登记在 [pi-internals.md](pi-internals.md) 并有测试 |
| 版本号只有一个来源 | `package.json`；代码、测试、文档不写死版本号 |
| 不加没用的导出 | 只在本文件用的东西不导出；测试要用的除外（测试里动态 import 的名字也算有人用） |
| 复杂度上限（新代码） | 单个函数认知复杂度 ≤ 15、不超过 80 行、嵌套不超过 4 层、参数不超过 5 个。超出的要么拆，要么在审查里说明理由（例如和 Pi 的函数一一对应） |
| 测试 | 测会真实出错的地方，不测写法；修复前失败、修复后通过；不碰真实环境（临时 `HOME`/`EPI_HOME`、不联网、不碰剪贴板和 `~/.epi`） |

## 3. 每个任务合并前必须过的检查

这是合并闸门 G1 的各项命令（[dev-workflow-herdr.md](dev-workflow-herdr.md) 第 3.3 节）。worker 交付前自己跑，主控审查时复核，合并后再跑一遍完整测试。

| 检查 | 命令 | 通过标准 |
|---|---|---|
| 构建产物同步 | `npm run build && git diff --exit-code -- dist` | 无输出 |
| 无未使用的变量和参数 | `npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters` | 不新增报错 |
| 相关测试 | `node --test test/<相关>.test.mjs` | 全过 |
| 完整测试 | `env -u PI_OFFLINE sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))(allow network-outbound (remote ip "localhost:*"))' npm test` | 全过；偶发失败要查出原因修掉，不靠重跑 |
| 修复前失败 | 在临时副本里跑：`git archive <修复前的提交> \| tar -x -C <dir>`，链好 `node_modules`，放进新测试，在禁网沙箱里跑 | 新测试在修复前失败、修复后通过。**不用 `git stash`**（所有 worktree 共用一个 stash 栈） |
| 模型可见内容 | `node scripts/model-snapshot.mjs --diff test/snapshots/model-visible.json` | 预期之外的变化要在报告里说明；变了就要考虑重跑 benchmark 基线 |
| 不改行为的重构 | 改动前后各跑一遍受影响的命令（`--help`、子命令、`-p` 配假模型、`--dry-run` 等），比对 stdout、stderr、退出码 | 逐字节一致 |
| TUI 改动 | Herdr 里用真实终端、真实模型走一遍（[e2e-acceptance.md](e2e-acceptance.md) 对应条目） | 按清单 |

## 4. 审查清单

审查清单是流程的一部分，写在 [dev-workflow-herdr.md](dev-workflow-herdr.md) 第 3.1 节；退回时写的 `review-N.md` 格式见同文第 3.2 节。

## 5. 定期的 code smell 扫描

时机：一个阶段做完、准备大节点终审之前，或者用户要求整体简化时。结果放 `.dev/simplify/<日期>/`。

| 工具 | 查什么 | 关注的阈值 |
|---|---|---|
| knip | 没人用的文件、导出、依赖 | 新增的无用导出 |
| `tsc --noUnusedLocals --noUnusedParameters` | 没用的变量和参数 | 0 |
| jscpd（`--min-lines 8 --min-tokens 60`） | 重复代码 | 跨文件的重复块 |
| madge（`--circular`，再加 `skipTypeImports` 跑一遍） | 循环依赖 | 运行时（非 `import type`）循环为 0 |
| ESLint + `eslint-plugin-sonarjs` | 认知复杂度、圈复杂度、函数长度、嵌套、参数个数 | 第 2 节的上限 |

这些工具不加进 `package.json`，在临时副本里用 `npx` 跑：

```bash
D=<scratch>/repo && mkdir -p $D && git archive main | tar -x -C $D && ln -s "$PWD/node_modules" $D/node_modules
# 测试 import 的是 dist/，改指向 src/，knip 才能看到真实的使用
grep -rl "dist/" $D/test $D/scripts | xargs sed -i '' -E 's#((\.\./)+|\./)dist/#\1src/#g'
cat > $D/knip.json <<'EOF'
{ "entry": ["src/cli.ts", "src/worker.ts", "scripts/**/*.mjs", "test/**/*.test.mjs", "test/fixtures/**/*.mjs"],
  "project": ["src/**/*.ts", "scripts/**/*.mjs", "test/**/*.mjs"], "ignore": ["dist/**"] }
EOF
(cd $D && npx -y knip@5 --no-progress --reporter compact)
(cd $D && npx -y jscpd@4 src --min-lines 8 --min-tokens 60 --reporters console)
(cd $D && npx -y madge@8 --circular --extensions ts --ts-config tsconfig.json src)
```

ESLint 装在单独的临时目录（`npm i eslint@9 typescript-eslint eslint-plugin-sonarjs`），配置：

```js
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
export default [{
  files: ["**/*.ts"], languageOptions: { parser: tseslint.parser }, plugins: { sonarjs },
  rules: {
    "sonarjs/cognitive-complexity": ["warn", 15], "complexity": ["warn", 15],
    "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
    "max-depth": ["warn", 4], "max-params": ["warn", 5],
  },
}];
```

运行：`cd $D && <eslint目录>/node_modules/.bin/eslint --config <eslint目录>/eslint.config.mjs -f json src`。

扫描之后的步骤：

```
工具扫描（主控）
  → Sonnet explorer 按工具结果通读代码，写带文件行号的 smell 报告
  → 主控逐条打开代码核实：属实 / 部分属实 / 不成立
  → 主控整理成方案：每项写收益、风险、测试覆盖，分成互不改同一文件的任务包
  → 和用户对齐（会改变用户可见行为或模型可见内容的项单独列出，由用户决定）
  → 按任务包走第 3、4 节
```

## 6. 记录

每次合并后记什么、汇报时附哪三个指标，见 [dev-workflow-herdr.md](dev-workflow-herdr.md) 第 3.4 节。用 epi 干活时发现的 epi 自身问题记进 [dogfood-issues.md](dogfood-issues.md)，按 P0–P3 排。
