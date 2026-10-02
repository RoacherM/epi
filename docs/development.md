# Make My Pi 开发文档

- 项目：MMP（Make My Pi）
- 状态：自有 TUI、原生 MCP、Rules/Skills、Task/Hooks 和 benchmark adapter 已实现；验收与遗留项见 §21
- 目标依赖：`@earendil-works/pi-coding-agent`（见 `package.json`）；Node.js `>=22.19.0`
- 当前验证环境：`package.json` 锁定的 Pi 版本已通过全部契约测试、ambient 隔离测试和离线 MCP 验收；真实模型冒烟和 benchmark adapter 冒烟是 Pi `0.83.0` 时做的，升级后还没重做，之后每次升级也要看是否需要重跑（见 `docs/pi-upgrade-design.md` 第 3 节"模型可见内容快照"）。OMP `17.1.3` 仅作能力边界参考，不是运行依赖
- Pi 升级：设计见 `docs/pi-upgrade-design.md`（版本锁死、升级自动化，已定，见 `docs/decisions.md`）
- 交互界面：设计见 `docs/tui-design.md`，代码在 `src/tui/`，是 `mmp` 唯一的交互入口（不再启动 Pi 经典交互界面），进度见设计文档第 15 节
- 开发流程：角色分工、独立合并前审查、任务说明要求、Herdr 实测和对照 grok，见 `docs/dev-workflow.md`；给 agent 的入口见根目录 `AGENTS.md`，硬规则见 `docs/dev-workflow.md`
- 最后更新：2026-10-01

## 1. 产品定义

MMP（Make My Pi）是在同一 Node.js 进程中使用锁定版本 Pi SDK 的定制 Harness。功能优先对齐 Pi；MMP 拥有 grok-build 风格的交互界面、配置装配、项目信任和能力选择。

定位（决策 H1、H2、H3，2026-10-02 对齐；OMP 对照见 [notes/omp-study.md](notes/omp-study.md)）：

- 跟着官方 Pi 走：用官方 Pi 包、锁定版本、自动升级门禁，**不 fork**（OMP 是硬 fork，手工移植上游，已落后半年）。
- 先把外围做好（界面、CLI、配置、已有扩展）；harness 能力参照 OMP 的设计以后再补，遇到瓶颈才考虑修改 Pi 的行为（H2）。
- 配置严格只属于 MMP：不读 Pi，也不读 Claude/Codex/Gemini/Cursor 的配置，不认用户给 Pi 设的 `PI_*` 环境变量（D63），项目配置要信任（H3/K3）。
- 和 Pi 一样默认不审批；审批分级先不做（H3/K6）。

| 层 | 所有权 | 入口 |
|---|---|---|
| Pi | 模型、Agent Loop、认证、Session、基础工具、Auto Compact、TUI 组件和 MCP runtime | 锁定的 Pi SDK |
| MMP | CLI、交互应用、Manifest、信任边界、资源来源与运行时身份 | `src/host.ts`、`src/tui/` |
| Extension | Task、Hooks 和显式选择的第三方能力；MCP 的配置接入 | `src/extensions/` |

MMP 不调用 PATH 中的全局 `pi`，不复制 Agent Loop。交互应用由 MMP 调用 `createAgentSessionRuntime()` 并复用 pi-tui 组件；print/json/rpc 等模式仍通过 Pi 的 `main()` 运行。

`mmp:runtime` 始终注入，用于运行时身份、Rules、Skills、`/mmp` 与启动信息。Task、MCP、Hooks 只有被 Manifest 声明后才装配。Skills 除 Manifest 外还从三个固定根目录发现，见 §7.1。

## 2. 核心架构

`src/cli.ts` 启动 `src/host.ts` 的 `runMmp()`：

1. MMP 自己处理子命令、版本和帮助；帮助会加载已声明扩展以收集扩展参数。
2. 解析全局路径、项目发现和 trust，生成 `ResolvedAssembly` 与 runtime identity。
3. 创建内置 Extension factories 并校验其配置；`--dry-run` 到这里输出报告并退出，不执行 factories。
4. 设置独立的 `<MMP_HOME>/pi` 状态目录；按运行模式分流。

| 模式 | 实现 |
|---|---|
| 交互式 TTY（含 `--mode text`） | `src/tui/start.ts` → MMP TUI + Pi session runtime |
| `--list-models` | `src/list-models.ts`，报告扩展诊断并使用 MMP 文案 |
| print/json/rpc、export、非 TTY | `piMain(piArgs, { extensionFactories })` |
| install/remove/uninstall/list/config/auth/mcp/update | MMP 自有子命令实现，不进入 Pi CLI 子命令 |

资源隔离参数由 `src/host.ts` 的 `BASE_PI_RESOURCE_ARGS` 维护：

```text
--no-extensions
--no-skills
--no-prompt-templates
--no-themes
--no-context-files
--system-prompt ""
--append-system-prompt ""
--no-approve
```

交互路径使用对应的受控 SDK services；外部扩展只从 Manifest 传入，Rules 和 Skills 由 `mmp:runtime` 注入。MMP 的 `--approve` 只影响项目 `.mmp`，不会授予 Pi 原生项目资源权限。非交互启动仍有已知 `.pi/settings.json` 读取限制，见 §8.1。

资源选择在 Session 创建前完成，不另建 bootstrap Extension、全局进程 registry 或 shell 包装层。

## 3. 不可违反的边界

### 3.1 Pi Core 拥有这些能力

MMP 不重新实现：

- Agent Loop；
- Model/provider runtime；
- Authentication；
- Session JSONL 格式、tree、resume、fork 和 compact；
- pi-tui renderer、editor 和可复用组件；MMP 负责应用布局、命令接线与交互；
- Session runtime、Print、JSON 和 RPC 执行语义；交互应用由 MMP 启动；
- Auto Compact；
- Pi 基础工具实现；
- MCP 协议栈；
- 通用 Extension 生命周期。

MMP 可以构造和启动这些公开 runtime primitive，但不能 fork 或复制其内部实现。按决策 H2，这条边界暂不重划；遇到瓶颈时再单独评估是否修改 Pi 的行为。

### 3.2 MMP 必须拥有这些能力

- 锁定并直接依赖唯一 Pi 版本；
- `~/.mmp` 和项目 `.mmp` 配置根；
- Manifest schema、相对路径解析和 fail-fast 校验；
- `.mmp` 项目资源的 trust gating；
- Rules、Skills、Extensions 的确定性选择和 provenance；
- 首批内置 Extension factory 的装配；
- `--dry-run`、版本输出和启动前错误；
- 子进程能力的回收边界。

### 3.3 当前实现范围

长期 Harness 方向参考 OMP（决策 H1）。按 H2，harness 路线图暂不启动（先做好外围）；下面是候选能力，新增时需单独设计，不作为永久禁止项。OMP 里值得借鉴的设计（web 搜索/抓取、写后 LSP 诊断、子 agent 结构化结果与 Agent Hub、模型角色、审批分级、设置注册表）见 [notes/omp-study.md](notes/omp-study.md) §7：

- Capability Registry；
- 多 Harness Discovery Provider；
- Profile 系统；
- 通用 Settings Registry；
- Vibe/Goal/Plan 等运行模式；
- Agent Hub、IRC、Collaboration Runtime；
- Advisor、Autolearn、Prewalk；
- Marketplace、Gallery、内置 Bench/Stats（已有 CLI updater 与外部 benchmark adapter 不在此列）；
- 多套 Memory Backend；
- 全局进程 Registry。

### 3.4 显式装配边界

Rules 与第三方 Extensions 未声明就不加载。固定 `mmp:runtime` 与 §7.1 的三个 Skill 自动发现根目录是明确的例外。

内置的标准能力（`mmp:task`、`mmp:mcp`、`mmp:hooks`）默认开启，Manifest 的 `"disable"` 列出的关闭（决策 H3/K4）。生效的关闭集合是全局与可信项目 `disable` 的并集；未信任项目的 Manifest 不读，其 `disable` 不生效。关闭的能力不读对应配置（`mcp.json`、`hooks.json`、`agents/`）、不启动子进程，也不注册工具或 handler。`mmp:hooks` 只在 `hooks.json` 里有 agent handler 时才读 `agents/`，所以关掉 `mmp:task` 之后，坏的 agent 文件也不会通过 `mmp:hooks` 让启动失败。默认开启的能力在没有配置时对模型不可见：没有 MCP 服务时 `mmp:mcp` 和随它加载的 codemode/tool-search 不增加任何工具或提示词（两者的工具注册为 inactive，`scripts/model-snapshot.mjs` 验证过）；`mmp:task` 会增加 `task` 等工具。开启的能力配置写错仍然 fail-fast，报错附带"改正文件或用 `disable` 关掉"的提示。

空 Manifest（或没有 Manifest）可以启动，保留运行时身份和固定 Skill 发现行为，Task/MCP/Hooks 三个内置能力全部开启。

## 4. 仓库结构

单 npm 包，TypeScript + ESM，Pi 依赖使用 exact version 和提交的 lockfile。不引入 DI、通用插件框架或通用配置框架。

| 路径 | 用途 |
|---|---|
| `README.md` | 安装、使用和配置参考 |
| `AGENTS.md` | coding agent 的简短入口，详细规则在 `docs/dev-workflow.md` |
| `docs/` | 架构、开发流程、决策、验收和问题记录；`docs/notes/` 放调研 |
| `examples/development/mmp.json` | 自开发配置模板，复制到本地 `.mmp/mmp.json` 后才启用 |
| `src/host.ts`、`src/args.ts` | CLI 调度、参数和 SDK Host |
| `src/assembly.ts`、`src/manifest.ts`、`src/project.ts` | 装配、schema 和 trust |
| `src/tui/` | 交互应用与工具渲染 |
| `src/extensions/`、`src/worker.ts` | 内置能力与隔离 Task worker |
| `dist/` | 必须与源码构建结果一致的已提交产物 |
| `test/`、`test/fixtures/` | 离线契约测试、伪模型与隔离配置 |
| `scripts/`、`.github/workflows/` | 升级、发布、benchmark 和 CI |

仓库不提交活动的 `.mmp/` 配置、凭证或 `.dev/` 任务交接文件。`examples/` 是供人选择的模板；`test/fixtures/` 是测试输入；两者都不能当作用户的默认配置自动加载。`package.json` 只发布 `dist/`，CLI 仅有 `mmp`，worker 不是第二个用户入口。

## 5. 用户配置目录

全局配置：

```text
~/.mmp/
├── mmp.json
├── RULES.md
├── skills/
├── agents/
├── task.json
├── mcp.json
├── hooks.json
└── pi/                 # Pi auth/settings/sessions/trust
```

项目配置：

```text
<repo>/.mmp/
├── mmp.json
├── RULES.md
├── skills/
├── agents/
├── task.json
├── mcp.json
└── hooks.json
```

所有相对路径必须相对于声明它的配置文件解析，禁止相对于 shell 当前目录猜测。

配置根可通过环境变量覆盖：

```text
MMP_HOME=<absolute path>   # 默认 ~/.mmp
PI_CODING_AGENT_DIR=$MMP_HOME/pi
```

MMP 必须先解析 `MMP_HOME`，再派生所有全局路径和 Pi `agentDir`。Benchmark runner 为每个 trial 提供独立 `MMP_HOME`；未显式覆盖时才使用 `~/.mmp`。任何情况下都不能 fallback 到 `~/.pi/agent`。

`${MMP_HOME}/pi`（默认 `~/.mmp/pi`）作为 MMP 的 Pi `agentDir`。它与用户独立安装的 `~/.pi/agent` 隔离，包含：

- auth；
- settings；
- sessions；
- trust store；
- Pi 自己需要的其他持久状态。

MMP 不复制这些文件的 schema，也不在 Manifest 中代理其字段。

## 6. Manifest v1

`~/.mmp/mmp.json`：

```json
{
  "version": 1,
  "rules": ["./RULES.md"],
  "skills": ["./skills"],
  "extensions": ["npm:some-pi-extension@1.2.3"],
  "disable": ["mmp:hooks"]
}
```

类型边界：

```ts
interface MmpManifestV1 {
  version: 1;
  rules?: string[];
  skills?: string[];
  extensions?: string[];
  disable?: Array<"mmp:task" | "mmp:mcp" | "mmp:hooks">;
}
```

`disable`（决策 H3/K4）：只接受三个内置名字，其他值（包括 `mmp:runtime`、第三方 source）是配置错误，报错带上文件路径。同一个文件里同一个名字既在 `extensions` 又在 `disable` 是配置错误。内置能力仍可写在 `extensions` 里（旧配置有效），但已经多余：没写也是开启的。

Extension source scheme：

```text
mmp:task               -> 包内 createTaskExtension(config)
mmp:mcp                -> 包内 createMmpMcpExtension(source)，接 Pi 原生 createMcpExtension（现状见 §13）
mmp:hooks              -> 包内 createHooksExtension(config)
npm:<package>          -> 交给 Pi package resolver 的临时显式 source
git:<owner>/<repo>     -> 交给 Pi package resolver 的临时显式 source
./local-extension.js   -> 相对当前 Manifest 解析后的 absolute path
```

内置 `mmp:*` 不转换成文件路径，而是转换为有名字的 Pi `InlineExtension`：

```ts
{
  name: "mmp:task",
  factory: createTaskExtension(config)
}
```

第三方 source 转换成 Pi 的显式 `--extension <source>` 参数。即使开启 `--no-extensions`，Pi 仍会加载这些显式 source。

`mmp.json` 不包含：

- model/provider/auth；
- session/compaction；
- MCP server transport 细节；
- Hook matcher/handler 细节；
- Task concurrency/job 细节。

这些分别属于 Pi、`mcp.json`、`hooks.json` 和 `task.json`。

## 7. Manifest 合并规则

Harness Core 只理解资源装配，不理解各 Extension 的内部配置。

```text
rules       = global + trusted project
skills      = global + trusted project + discovered
extensions  = global + trusted project
disable     = global ∪ trusted project
built-ins   = (declared in extensions, in order) + (remaining defaults: task, mcp, hooks) − disable
```

`disable` 优先于另一个文件的 `extensions`：全局 `extensions` 列了 `mmp:task`、可信项目 `disable` 了它，结果是关闭。

处理顺序：

1. 分别相对于声明文件解析路径；
2. 转换为 canonical absolute path；
3. 保留 global 在前、project 在后的声明顺序；
4. 按 canonical path 或规范化 source 去重；
5. 路径不存在、类型错误或版本不支持时 fail-fast；
6. 不做递归 deep merge。

每一项保留 provenance：

```ts
interface ResolvedResource {
  kind: "rule" | "skill" | "extension";
  value: string;
  source: "global" | "project";
  declaredIn: string;
  discovered?: "agents" | "mmp" | "project"; // 只有自动发现的 skill root 才有
}
```

Extension 自己负责其配置文件的 schema 和 global/project 合并语义。Harness 只向开启的内置 Extension 传递可信配置根；被 `disable` 关掉的不读取对应配置文件。

### 7.1 Skill 自动发现（docs/decisions.md S1）

除 Manifest 声明的 skill 路径外，`resolveAssembly`（`src/assembly.ts` 调用 `src/skill-discovery.ts` 的 `discoverSkillRoots`）还固定发现三个目录，缺失时跳过：

- 全局 `~/.agents/skills`；
- MMP 自己的全局 `<mmpHome>/skills`；
- 被信任项目的 `<project.root>/.mmp/skills`——`trustedProjectRoot` 只在 `project.discovery === "loaded"` 时给出，即项目必须先有 `.mmp/mmp.json` 才算 MMP 项目；只有 `.mmp/skills`、没有 `.mmp/mmp.json` 的目录不会被当成项目，其 skills 也不会被发现。

`HOME` 通过 `src/paths.ts` 导出的 `resolveHomeDir(environment)` 解析——`environment.HOME` 优先，缺省时才用真实 `os.homedir()`；`resolveMmpPaths` 的 `~/.mmp` 缺省值和 skill 自动发现共用这一个函数，不会出现一个读真实 home、另一个读测试注入的 fake HOME 的不一致。测试通过 `environment.HOME`/进程 `HOME` 注入临时目录，绝不触碰真实 home。

永远不读取 Pi 自己的 skill 位置（`~/.pi/agent/skills`、项目 `.pi/skills`），也不读取项目 `.agents/skills`（不是用户为 MMP 选定的目录，`test/ambient-isolation.test.mjs`/`test/tui-services.test.mjs` 持续验证这些位置保持不可见）。`<mmpHome>/pi`（`agentDir`）是 MMP 存放 Pi 运行状态（auth、sessions、模型目录、settings）的目录，不是 skill 位置，MMP 不在里面创建或读取 skills 目录；自动发现的目录也不能指向它。这条规则对 symlink 也生效：`discoverSkillRoots` 对每个候选目录先 `realpathSync.native`（返回磁盘上的真实大小写），再检查 canonical 路径：落在 `agentDir`、`~/.pi` 或 `~/.pi/agent` 之下，或者是其中任何一个的上级目录（Pi 的 skill loader 会递归子目录），或者路径里任何一段不区分大小写地等于 `.pi`——命中就 `throw MmpConfigError`（说明声明路径、它实际指向哪里、碰到的是哪个 Pi 目录），不会静默跳过。这样一个项目 `.mmp/skills -> <mmpHome>` 或指向 `<mmpHome>/pi` 内部的符号链接、或 `~/.agents/skills` 本身是指向 Pi 目录（或 `~`）的符号链接，都会让本次运行直接失败。**范围之外**：某个已发现目录内部单个 skill 文件夹本身是指向 Pi 位置的符号链接（例如 `~/.agents/skills/foo -> ~/.pi/agent/skills/bar`）不做检查——Pi 的 resource loader 会照常跟随这类链接加载它；这是用户往 `~/.agents/skills` 里放什么内容的自主选择，MMP 只保证三个固定根目录本身不指向 Pi。

合并顺序：`mergeUnique([globalManifest.skills, projectSkills, discoveredSkills], ...)`——声明的两组在前，发现的一组在后，按 canonical path 去重时声明的一方保留（其 `source`/`declaredIn` 不变，也没有 `discovered` 字段）。发现到的 skill root 和声明的一样，以显式绝对路径传给 Pi（`mmp:runtime` 的 `resources_discover` handler，`src/extensions/runtime.ts`）。

`/reload` 复用同一个 `resolveAssembly` 闭包，因此会重新扫描这三个目录；Pi 的 `AgentSession.reload()`（`core/agent-session.js`）在 `resources_discover` 之前先 emit 完 `session_start(reason:"reload")`，`mmp:runtime` 的 `session_start` handler 在这一步刷新 `activeAssembly`，所以新增的 skill 在同一次 `/reload` 就可见，不用等下一次。

Provenance 通过 `mmp --dry-run`（`skills[].discovered`）、`/mmp`（`declaredResources.skillRoots[].discovered`）、启动页（"resources" 行的 "(N discovered)"）和 `mmp list`（"Discovered skill roots:" 段）暴露。

## 8. Project Trust

### 8.1 Pi 的公开边界（0.83 起）

Pi 已公开：

- `ProjectTrustStore`；
- `hasTrustRequiringProjectResources()`；
- `--approve` / `--no-approve`；
- `DefaultResourceLoader` 的 `resolveProjectTrust`；
- `--no-context-files` / `noContextFiles`。

Pi 原生 trust 会保护 `.pi/settings.json`、`.pi` project resources、项目 package 和 `.agents/skills`。但 `.mmp/mmp.json` 不是 Pi 原生资源，因此 MMP 仍需在读取其内容前显式套用同一个 trust 决策。

**已知限制**：交互路径的 `SettingsManager` 使用 `projectTrusted: false`，不读取项目 `.pi/settings.json`。非交互 `piMain` 路径的 bootstrap 配置使用 `projectTrusted: false`，但后续 `startupSettingsManager` 未传该选项，默认仍读取该文件并用于 `sessionDir` 查找；`--no-approve` 只阻止运行阶段应用项目设置。此项隔离目标尚未完全达成，不能把交互路径的保证推广到所有模式，见 `docs/tui-design.md` 3.3 节和决策 D3。

**已修复（2026-09-29）**：以前 MMP 会把自己的 `--approve` 原样转给 Pi，`mmp --approve` 时项目 `.pi/settings.json` 会在运行阶段整份生效（实测：项目设置指定的模型被选中）。现在 MMP 不再转发，并固定给 Pi 传 `--no-approve`，由 `test/ambient-isolation.test.mjs` 覆盖。

MMP 使用 Pi 导出的 `ProjectTrustStore` API，不直接解析 `trust.json`，也不创建第二套 trust database。

### 8.2 项目信任决策

```text
--no-project
  -> 不发现项目 .mmp

--no-approve
  -> 可发现路径存在，但不读取任何项目 .mmp 文件

--approve
  -> 本次运行读取项目 .mmp；不交给 Pi

无 override
  -> 交互模式下第一次遇到还没决定的项目：先问（Trust / Trust parent folder (<parent>) / Trust
     (this run only) / Do not trust / Do not trust (this run only)），答案写入
     ProjectTrustStore（"this run only" 的两个选项不写盘，只影响这次运行），见
     `src/trust-prompt.ts`
  -> ProjectTrustStore.get(projectRoot) === true 才读取
  -> false 或 unknown（非交互模式，还没问过）都忽略项目 .mmp
```

安全要求：

1. trust 决策前最多检查 `.mmp/mmp.json` 是否存在，不能读取其内容；
2. 未信任时不得读取项目 Rules、Skills、Agents、Extensions、MCP 或 Hooks；
3. MMP 自己消费 `--approve` 和 `--no-approve`，不传给 Pi；Pi 固定收到 `--no-approve`，项目 `.pi/` 永远不可信（2026-09-29 起，原因见 8.1 节的已修复问题）；
4. Pi 不再弹原生 trust prompt。要信任或撤销项目 `.mmp`：交互模式第一次进入未决定的项目会自动问；随时可以在 `mmp` 里用 `/trust` 改。两条路径都写入同一个 `ProjectTrustStore`，重启 `mmp` 后生效（Manifest 里的 Extensions 不能热加载）；
5. non-interactive 模式（`--dry-run`、`-p`、`--mode json/rpc`、非 TTY、MMP 自己的子命令）不弹 MMP prompt；unknown 默认不加载项目 `.mmp`。

不保留旧的 `--trust-project`。沿用 Pi 的 `--approve` / `--no-approve` 这两个名字，用户不用学新开关；但它们只作用于 `.mmp`。

## 9. SDK Host 契约

### 9.1 参数所有权（2026-09-29 起：见 [cli-design.md](cli-design.md)）

`src/args.ts` 的 `MMP_FLAG_TABLE` 是唯一一张参数表，同时驱动解析、校验和 `mmp --help`。未知短参数直接报错。未知长参数暂存为扩展参数，由已声明扩展的 `pi.registerFlag()` 注册表校验；无人认领时按名称报错。`--help` 也收集并展示这些扩展参数。资源覆盖参数仍被保留，不能绕过 Manifest。

MMP 自己消费、从不转发的参数：

```text
--dry-run
--no-project
--version / -v
--help / -h        （只打印 MMP 自己的帮助，不追加任何底层命令的帮助）
--approve / -a
--no-approve / -na
```

MMP 校验（是否认识、是否带值）后原样转发的参数（和底层引擎对齐，取值语义由它在运行时校验，不重复实现）：`--provider`、`--model`、`--thinking`、`--api-key`、`--models`、`-c/--continue`、`-r/--resume`、`--session`、`--session-id`、`--fork`、`--session-dir`、`--no-session`、`-n/--name`、`-t/--tools`、`-xt/--exclude-tools`、`-nt/--no-tools`、`-nbt/--no-builtin-tools`、`-p/--print`、`--mode`、`--list-models`、`--export`、`--offline`、`--verbose`。初始消息和 `@file` 参数：非交互路径原样转发（底层实现自己处理 `@file`）；交互界面自己实现了等价逻辑（`src/file-arguments.ts`），见下。

MMP 固定追加（见 `BASE_PI_RESOURCE_ARGS`）：五个 `--no-*` 参数、`--system-prompt ""`、`--append-system-prompt ""`、`--no-approve`。

以下参数由 MMP 保留，用户直接传入时 fail-fast，提示改用 Manifest：

```text
--extension / -e
--no-extensions
--skill
--no-skills
--prompt-template
--no-prompt-templates
--theme
--no-themes
--no-context-files
--system-prompt
--append-system-prompt
```

原因：允许这些参数绕过 Manifest，会破坏 provenance 和“未声明即不存在”。

以下参数完全不提供，报错说明理由：`--use-theme`、`--tui-mode`（界面已换成 grok 风格的单一全屏主题，由 MMP 管理）。

子命令 `update`/`install`/`remove`/`uninstall`/`list`/`config`/`auth`/`mcp` 只在 `argv[0]` 位置被识别，由 `host.ts` 的 `runMmp` 在参数表解析之前整体接管（`src/commands/manifest-cli.ts`、`src/commands/auth-cli.ts`、`src/update.ts`），从不进入上面的参数表，也从不转发给底层的 CLI 子命令处理逻辑——它们读写的是 MMP 自己的 Manifest 和 `~/.mmp/pi`，不是底层的 `settings.json`。

`--verbose`：非交互路径原样转发；交互界面里由 `src/extensions/runtime.ts` 的 `mmp:runtime` 扩展在 `session_start`（`reason: "startup"`、`mode: "tui"`）时把启动信息（已加载 Rules/Skills/Extensions 数量、当前模型、当前 Session）显示成对话区提示，不产生底层的 verbose 输出格式。

其他参数示例：

```bash
mmp --model anthropic/claude-sonnet-4 --thinking high --print "fix this"
```

### 9.2 核心流程

以 `src/host.ts` 的 `runMmp()` 为准，分流见 §2。`prepareParsedMmpRun()` 保存 `resolveAssembly` 闭包，让 Rules/Skills 重载复用相同 trust 和路径规则。交互路径在退出前回收 TUI/runtime；非交互路径等待 Pi 执行完成、刷新 stdout/stderr 后退出，避免扩展遗留句柄挂住一次性命令。

### 9.3 Pi argv 与重载

`buildPiArgs()` 顺序为 `BASE_PI_RESOURCE_ARGS`、Manifest 的显式外部 `--extension`、已解析的透传参数。不要复制一份缺少 `--system-prompt ""`、`--append-system-prompt ""` 或 `--no-approve` 的隔离参数表。

Rules 与 Skills 不冻结在 Pi argv 中。`mmp:runtime` 通过 `resources_discover` 返回当前 Skill roots；当前 Rules 和运行时契约由同一组代码里的 `mmp:system-prompt` 在 `before_agent_start` 追加。它返回的 `systemPrompt` 会被 Pi 固定成最终文本，之后的 `sections` 修改都会丢失，所以它固定排在 inline 扩展的最后（Pi 1.0 的 MCP 在自己的 `before_agent_start` 里写 `<mcp_servers>`；Manifest 外部扩展本来就排在所有 inline 扩展之前），见 [pi-internals.md](pi-internals.md) `system-prompt-forced-last`。`/reload` 重新解析 Manifest 并加载 Rules/Skills；失败时保留上一份有效装配并显示错误。`/new`、切换会话（`/resume`、rpc `switch_session`）和 fork 同样在 `session_start` 时重新解析（按启动目录解析，不是目标会话的 cwd），规则相同：解析成功就换成新装配，失败就显示错误并沿用最近一次成功解析的装配（可能是启动时的，也可能是之后某次 `/reload` 的），不退回启动装配。Rules、运行时契约、`resources_discover` 返回的 Skill roots、`/mmp` 的输出和欢迎页的计数都读这同一份装配。Pi 在这些路径上都会重新执行扩展工厂，所以这份状态放在 `createMmpRuntimeExtensions` 里、工厂之外，工厂重跑时不重置。

Manifest 的 Extension 选择、Hooks/Task 启动配置改变后需要重启。已启用的原生 MCP 通过 `loadConfig` 重新读取配置，`/reload` 可以应用 MCP 服务配置变化；用 `disable` 关闭或重新开启 `mmp:mcp` 仍需重启。具体能力边界见 [mcp-design.md](mcp-design.md)。

### 9.4 运行约束

```text
PI_CODING_AGENT_DIR=~/.mmp/pi
```

- 不查找全局 `pi`；
- 不启动 shell；
- 不 spawn Pi 主进程；
- 不通过环境变量传递配置 JSON 或 secret；
- 等待当前模式的 runtime 清理完成；非交互 `piMain()` 返回后刷新输出再退出；
- Pi SDK 初始化失败直接以非零状态失败，禁止 fallback 到全局 Pi。

## 10. Effective Assembly

MMP 在内存中构造本次运行的有效装配：

```ts
interface ResolvedAssembly {
  agentDir: string;
  globalManifest: string;
  projectManifest?: {
    path: string;
    trusted: boolean;
    loaded: boolean;
  };
  rules: ResolvedResource[];
  rulesText: string;
  skills: ResolvedResource[];
  externalExtensions: ResolvedResource[];
  inlineExtensions: Array<{
    name: "mmp:task" | "mmp:mcp" | "mmp:hooks";
    source: "global" | "project" | "default"; // "default": 没有 Manifest 列出，默认开启
    declaredIn?: string;                        // "default" 时没有
  }>;
  disabledExtensions: Array<{                   // 每个列出它的文件一条，全局在前
    name: "mmp:task" | "mmp:mcp" | "mmp:hooks";
    source: "global" | "project";
    declaredIn: string;
  }>;
}
```

内置 Extension 的有效配置通过 factory closure 传递：

```ts
const extensionFactories: InlineExtension[] = [
  createMmpMcpExtension(mcpConfigSource), // 现状见 §13 -- Pi 原生 createMcpExtension，不再是 createMcpAdapter
];
```

首版不生成 `~/.mmp/runtime/<run-id>`：

- Rules 直接作为内存字符串交给 Pi；
- Task/MCP/Hooks 配置直接进入对应 factory closure；
- provenance 由 `ResolvedAssembly` 保留；
- secret 不落临时磁盘；
- Pi Session 退出后没有 runtime snapshot 目录需要清理。

如果将来出现必须跨进程传递的大配置，只为具体 child 写权限受控的 capsule；不能恢复成所有组件共享的通用临时配置目录。

## 11. `--dry-run` 契约

`--dry-run` 不调用 `piMain()`，不安装 package，不触碰 auth/session，不启动任何 Extension，只输出有效装配结果：

```json
{
  "mmpVersion": "0.1.4",
  "piVersion": "<installed Pi version, see package.json>",
  "sdkEntry": "@earendil-works/pi-coding-agent/main",
  "agentDir": "/Users/byron/.mmp/pi",
  "globalManifest": "/Users/byron/.mmp/mmp.json",
  "projectManifest": {
    "path": "/repo/.mmp/mmp.json",
    "trusted": false,
    "loaded": false
  },
  "rules": [
    {
      "value": "/Users/byron/.mmp/RULES.md",
      "source": "global"
    }
  ],
  "skills": [
    {
      "value": "/Users/byron/.mmp/skills",
      "source": "global"
    }
  ],
  "inlineExtensions": [
    { "name": "mmp:task", "source": "global", "declaredIn": "/Users/byron/.mmp/mmp.json" },
    { "name": "mmp:mcp", "source": "default" }
  ],
  "disabledExtensions": [
    { "name": "mmp:hooks", "source": "project", "declaredIn": "/repo/.mmp/mmp.json" }
  ],
  "externalExtensions": []
}
```

`inlineExtensions` 是本次开启的内置能力，`disabledExtensions` 是被关掉的和关掉它的文件。运行时清单（`/mmp` 与提示词里的 `declaredResources`）同样有这两项，但 `disabledExtensions` 为空时省略，这样什么都没关时模型看到的清单和 K4 之前一样。

`skills[]` 的每一项在自动发现（7.1 节）时还会带一个 `discovered: "agents" | "mmp" | "project"` 字段；Manifest 声明的 Skill 没有这个字段。

它必须能回答：

- 实际链接的是哪个 Pi package 和版本；
- MMP 是否会调用 SDK 而不是全局 binary；
- 加载哪些 Rules、Skills 和 Extensions，其中哪些 Skill 是自动发现的、来自哪个固定目录；
- 每项来自 global 还是 project；
- 项目配置是否被信任和读取；
- 哪些 Extension 是 inline factory，哪些交给 Pi package resolver；
- 哪些内置能力开启（声明的还是默认的），哪些被关掉、由哪个文件关掉；
- 哪个配置错误阻止启动。

禁止输出：

- Rules 文件全文；
- MCP Authorization header；
- API token；
- Hook secret；
- Task capsule 的私密内容。

## 12. Task Extension

不直接采用完整 `pi-subagents`。当前实现包含 chains、profiles、fleet、intercom、background orchestration、agent memory、workflows 和 RPC，超出 MMP 边界。

可以参考 Pi 官方最小 Subagent 示例，但只保留已确定的能力。

### 12.1 工具面

```text
task
task_status
task_wait
task_cancel
todo
```

### 12.2 状态

```ts
interface TaskJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  process?: ChildProcess;
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}
```

Job Registry 必须属于当前 Pi Session，不允许 process-global singleton。

### 12.3 Child 约束

- 每个 Child 是独立 Node.js process；
- Child 启动包内 `dist/worker.js`，不能查找或启动 PATH 中的 `pi`；
- Worker 使用锁定的 Pi SDK 创建独立 in-memory AgentSession，并输出稳定 JSON events；
- 只接收 task capsule、cwd、agent prompt 和明确工具列表；
- 不加载 `mmp:task`，因此不能递归产生 Child；
- 不自动继承 Parent 的所有 Extensions；
- MCP 只有 agent manifest 明确允许时才加载；
- 不共享 Parent MCP connection；
- Parent Session shutdown 时取消并回收所有 Child；
- stdout/stderr 和最终结果有明确上限，超出后写 artifact；
- 一个 Job 失败不破坏其他独立 Job；
- capsule 文件权限仅当前用户可读写，Child 退出后删除。

### 12.4 Agent 资源

```text
~/.mmp/agents/<name>.md
<repo>/.mmp/agents/<name>.md
```

最小 frontmatter：

```yaml
---
name: reviewer
description: Reviews a bounded code change
model: optional/provider-model
tools: read,grep,bash
timeoutSeconds: 600
---
```

Project agent 仅在项目 trust 生效后可见。

## 13. MCP Extension

Pi 0.99 起原生支持 MCP（`createMcpExtension`），MMP 不再自带 MCP 客户端（`pi-mcp-adapter` 已移除）。设计见 [docs/mcp-design.md](mcp-design.md)（决策 MCP1、MCP2）。

`mmp:mcp` 只负责决定**读哪些配置文件、用谁的信任判断**，其余（连接、OAuth、工具注册、`/mcp` 面板）全部是 Pi 的代码：

```text
~/.mmp/mcp.json ─────────────┐
<项目>/.mmp/mcp.json ─(仅信任)┤→ loadNativeMcpConfig ─→ createMcpExtension({ loadConfig, logPath })
                             │                            │  （Pi 代码：连接、OAuth、注册 mcp__<server>__<tool>、/mcp）
Pi 自己的 ~/.mmp/pi/mcp.json ✗                            ├─ createCodemodeExtension()
项目 .pi/mcp.json            ✗                            └─ createToolSearchExtension()
```

实现轮廓（`src/extensions/mcp.ts`、`src/extensions/index.ts` 的 `case "mmp:mcp"`）：

```ts
import { createMcpExtension, createCodemodeExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";

// config.js 不在包的 exports 里，按文件路径引用（docs/pi-internals.md "mcp-native-config-loader"）
const { loadMcpConfig: piLoadMcpConfig } = await import(/* extensions/mcp/config.js 的绝对路径 */);

function loadNativeMcpConfig(source, cwd) {
  const assembly = source.resolveAssembly();
  const global = piLoadMcpConfig({ agentDir: source.mmpHome, cwd, projectTrusted: false });
  if (assembly.projectManifest?.loaded !== true) return global;
  const project = piLoadMcpConfig({ agentDir: join(assembly.projectManifest.root, ".mmp"), cwd, projectTrusted: false });
  // 合并：project 的条目 scope 改成 "project"，同名覆盖 global
}

export function createMmpMcpExtension(source) {
  const loadConfig = (ctx) => loadNativeMcpConfig(source, ctx.cwd);
  const piFactory = createMcpExtension({ loadConfig, logPath: join(source.mmpHome, "pi", "mcp.log") });
  return {
    name: "mmp:mcp",
    factory: async (pi) => {
      // 包一层 Proxy，只拦截 registerCommand("mcp", ...)：零服务时显示 MMP 自己的提示
      await piFactory(wrappedPi);
      // session_start 里查 pi.getCommands()，发现别的扩展也注册了 /mcp 就可见地失败
    },
  };
}
```

要点（都已用真实源码核实，不是照抄设计稿）：

- `loadMcpConfig` 的 `projectTrusted` 参数只控制它自己是否**额外**读 `<cwd>/.pi/mcp.json`；MMP 永远传 `false`，改用两次调用（`agentDir` 分别是 `~/.mmp` 和 `<项目>/.mmp`）来精确控制读哪两份文件，`.pi/mcp.json` 永远不会被这条路径读到。
- `McpServerEntry.source` 就是传给 `loadMcpConfig` 的那个 `agentDir` 拼出来的路径；`/mcp` 面板的写回（启用/停用/改曝光方式）默认调 `updateMcpServerConfig(entry.source, ...)`——只要不传自定义 `updateConfig`，写回自然落在 MMP 自己的文件上，不用额外代码。
- `credentials` 没有显式传：它的类型是 `McpOAuthCredentialStore` 实例（不是路径），Pi 的默认值走 `getAgentDir()`，MMP 早就把它重定向到 `<MMP_HOME>/pi` 了，结果和显式传一样，省了引入 `oauth.js` 的代价。
- 一份坏的 `mcp.json`（`loadNativeMcpConfig` 的 `errors` 非空）在 `src/extensions/index.ts` 里同步抛 `MmpConfigError`，不等 Pi 自己那句软提示（`ctx.ui.notify(..., "warning")`，在 `-p` 模式下是空操作）。
- `mmp:mcp` 开着（默认开）而 Manifest 声明的别的扩展也注册 `/mcp` 时，Pi 自己的处理是把两边都改名成 `/mcp:1`/`/mcp:2`（不报错）；`mmp:mcp` 在 `session_start` 里查这个改名信号，throw 一个错误，告诉用户要留另一个就加 `"disable": ["mmp:mcp"]`，否则删掉另一个——在 print 模式下这条错误经由 Pi 的 `onError` 打到 stderr，在 TUI 里经由 `onError` 落一条常驻提示（`ctx.shutdown()` 在 print 模式是空操作，在 TUI 里会立刻退出，可能和提示渲染赛跑，所以不调用它）。

`mmp mcp add|remove|list|login|logout`（`src/commands/mcp-cli.ts`，docs/mcp-design.md §6）复用同一批 Pi 代码（`config.js` 的 `addMcpServerConfig`/`removeMcpServerConfig`/`getMcpToolExposure`、`core/mcp-servers.js` 的 `validateMcpServerConfig`、`runtime.js` 的 `McpServerConnection`/`McpOAuthCredentialStore`/`signInMcpServer`，全部登记进 [docs/pi-internals.md](pi-internals.md)），但参数解析和信任判断是 MMP 自己的——Pi 的 `runMcpCommand` 写死 `.pi/mcp.json` 和 Pi 自己的项目信任存储，不能直接用。

MMP 不拥有 transport、OAuth、connection lifecycle、tool discovery/call、renderer 和 metadata cache——这些全部是 Pi 的代码，跟着 Pi 升级自动走。

## 14. Hooks Extension

`mmp:hooks` 已实现为 Pi `InlineExtension`。它默认装配，Manifest 的 `"disable": ["mmp:hooks"]` 关掉它（决策 H3/K4，§3.4）；没有 `hooks.json` 时什么都不做：

```text
~/.mmp/hooks.json
+ <trusted-repo>/.mmp/hooks.json
-> strict schema + env expansion
-> global-first ordered matcher/handlers
-> Pi Extension Event result
```

Project `hooks.json` 只在统一 Project Trust 通过后读取。配置 schema：

```json
{
  "version": 1,
  "hooks": [
    {
      "event": "tool_call",
      "match": {
        "toolName": "bash"
      },
      "handlers": [
        {
          "type": "command",
          "command": "./hooks/check-command.mjs",
          "args": [],
          "env": {
            "POLICY_TOKEN": "${POLICY_TOKEN}"
          },
          "timeoutMs": 10000
        }
      ]
    }
  ]
}
```

### 14.1 事件与决策

首批事件：

```text
session_start
session_shutdown
user_prompt
tool_call
tool_result
before_compact
task_start
task_stop
```

`task_start` / `task_stop` 通过 Pi Extension shared `EventBus` 由 `mmp:task` 发出，不建立 process-global bus 或第二套生命周期。

Handler 必须只返回一个严格 JSON decision：

```json
{"action":"continue"}
{"action":"block","reason":"policy denied"}
{"action":"cancel","reason":"optional reason"}
{"action":"transform","text":"new prompt"}
{"action":"replace","text":"new result","isError":false}
```

合法映射：

| Decision | Event |
|---|---|
| `continue` | 全部 |
| `block` / `cancel` | `tool_call`、`user_prompt`、`task_start`、`before_compact` |
| `transform` | `user_prompt` |
| `replace` | `tool_result` |

### 14.2 Matcher 与 Handler

- `match` key 是 event payload 的安全 dot-path，value 做 scalar 精确匹配；数组表示任一候选值；
- Global hooks 先于 Project hooks，所有 handlers 按声明顺序串行；
- 第一个 `block` / `cancel` 立即停止；
- command：argv 直启且 `shell:false`，stdin 为事件 JSON，stdout 为 decision JSON；
- HTTP：固定 method/URL/headers/body，非 GET 默认发送完整事件，2xx body 为 decision JSON；
- prompt：使用当前模型或显式 `provider/model`，通过 Pi `ModelRuntime.completeSimple()` 返回 decision；
- agent：使用已声明的 MMP Agent profile 和受限 Task worker；未知 agent 在 Pi 启动前失败，Child 不加载 `mmp:task`；
- HTTP body 支持 `{{event}}`、`{{event.<path>}}` 和 `{{cwd}}`；command env 与 HTTP URL/headers/body 支持 `${ENV_NAME}`；
- `timeoutMs` 默认 `10000`，最大 `300000`；payload/output 各限制 `64 KiB`；
- timeout、非零 exit、非 2xx、malformed JSON、非法 decision 与超限 output 都视为失败；
- tool call、user prompt 与 before compact 映射 fail-closed；
- Session shutdown 先取消在途 handler，再执行 shutdown hooks，最后回收 command/agent Child。

失败必须可见（不静默 fallback）。`tool_call`/`tool_result` 失败通过它们本来就有的 tool result 渠道显示，任何模式下都可见。`session_start`/`user_prompt`/`session_before_compact`/`session_shutdown` 没有 tool result 可用，只能靠 Pi UI 通知（`context.ui.notify`）——但 Pi 的 `print`/`json` 模式用的是 `noOpUIContext`（`core/extensions/runner.js`），`notify` 是空实现；这两种模式下 `notifyFailure`（`src/extensions/hooks.ts`）额外把同一条消息写到 stderr（`context.mode !== "tui"` 时才写，MMP 自己的 TUI 和 Pi 的 `rpc` 模式已经有可用的 notify，不重复）。`HooksRuntime.run()`（`src/hooks-runtime.ts`）把每个 handler 的失败包一层 `${event} hook (${declaredIn}, ${handlerLabel}) failed: ...`，命令 spawn 失败会带上 Node 的原始错误（如 `spawn ./x.mjs ENOENT`），非零退出会带上一段 stderr 尾部（`MAX_HOOK_ERROR_TAIL_BYTES = 4KiB`）。

`user_prompt` 的 `block` / `cancel` 同理：Pi 的 `input` 结果 `handled` 没有 reason 字段，Pi 要扩展自己提示（Pi 的 `examples/extensions/input-transform.ts`），所以 `mmp:hooks` 用同一个渠道提示 `Prompt blocked by user_prompt hook: <reason>`（warning 级；`print`/`json` 模式也写 stderr）；`cancel` 没给原因时只提示 `Prompt cancelled by user_prompt hook`。提示在包住钩子运行的 `try` 外面发，notify 自己出错不会再被当成钩子失败多报一次（D46）。notify 出错时仍然返回 `handled`（Pi 的 `emitInput` 把出错的 `input` 处理器当作 `continue`，被拦下的提示词会发给模型），notify 的错误在 stderr 报一次。钩子原因和失败信息里的 stderr 尾部来自用户配置的程序，显示前去掉 ANSI 转义和其他控制字符、多行用 ` | ` 连成一行，文本自己的空格不动（`displayLine`，D46）。不提示的话提示词从编辑器消失、界面上什么都没有（D26）。`-p` 被拦下时退出码仍是 0，和 Pi 对 `handled` 的处理一致。

完整用户配置说明与可复制示例位于根目录 `README.md`。

### 14.3 验证

自动化契约：

```bash
node --test test/hooks.test.mjs
```

覆盖配置合并、严格 schema、环境变量、matcher、handler 顺序、command/HTTP/prompt/agent decision、Pi event 映射、timeout、malformed output、unknown agent、shutdown cancellation，以及 spawn 失败在 `print`/`json`/`tui` 三种 mode 下的可见性（stderr fallback 只在非 tui 触发）和非零退出的 stderr 尾部。

真实 Pi 路径已验证：

- command Hook 阻断 `bash` 后目标文件不存在；
- timeout Hook 在约 `3s` 的完整模型回合内 fail-closed，且无残留 handler process；
- prompt Hook 将输入改写为 `PROMPT_HANDLER_OK`；
- agent Hook 将输入改写为 `AGENT_HANDLER_OK`；
- lifecycle recorder 观察到 `session_start -> user_prompt -> tool_call -> tool_result -> session_shutdown`；
- Task recorder 观察到 `task_start -> task_stop(completed)`。

## 15. 分层验证

### 阶段 A：SDK Host 冒烟

动作：

- 建立 npm package 和 TypeScript build；
- exact pin `@earendil-works/pi-coding-agent`（见 `package.json`）；
- 设置 Node.js `>=22.19.0`；
- 实现 MMP 参数分流和保留 resource flags；
- 设置独立 `PI_CODING_AGENT_DIR`；
- 通过 `piMain(args, { extensionFactories })` 同进程启动 Pi；
- 强制 `--no-*`，包括 `--no-context-files`。

验证：

```bash
mmp --version
mmp --dry-run
mmp --print "Reply exactly: MMP_OK"
```

真实模型输出必须为：

```text
MMP_OK
```

另外必须证明：

- 临时移除 PATH 中的全局 `pi` 后，`mmp --print` 仍成功；
- `mmp --version` 同时输出 MMP 版本和 `package.json` 锁定的 Pi 版本；
- 进程树中没有第二个 Pi 主进程。

### 阶段 B：Manifest 与 Project Trust

动作：

- 实现 global/project Manifest resolver；
- 实现相对路径、去重和 provenance；
- 使用 `ProjectTrustStore` 公共 API；
- 实现 `--approve`、`--no-approve` 和 `--no-project`；
- 实现 reserved Pi resource flags fail-fast；
- 实现无副作用 `--dry-run`。

验证：

```bash
mmp --no-approve --dry-run
mmp --approve --dry-run
mmp --no-project --dry-run
```

三次输出的 project resources 必须分别为：

```text
ignored
loaded
not discovered
```

并验证 trust 前不会打开项目 `.mmp` 文件。

### 阶段 C：Rules、Skills、MCP

动作：

- 按 provenance 顺序合并 Rules 内容；
- 将 Skill absolute paths 显式传给 Pi；
- 用 Pi 原生 `createMcpExtension({ loadConfig })` 接入 MCP；
- 校验配置来源、codemode/direct/deferred 曝光和 `/mcp` 管理面板。

验证：

- Agent 实际遵循一条 MMP Rule；
- Agent 能读取 Manifest 中声明的 Skill；
- Pi 的 skill 根、项目 `.agents/skills` 和未声明 Context Files 不可见；全局 `~/.agents/skills` 按 §7.1 发现；
- 本地 stdio MCP fixture 完成真实 `search -> describe -> call`；
- Session 退出后 MCP 子进程消失。

### 阶段 D：Task 与 Hooks

动作：

- 实现 bounded SDK worker process；
- 实现 Job Registry 和 status/wait/cancel；
- 实现 Todo；
- 实现 Hooks 到 Pi Event 的映射。

验证：

- foreground Task 完成；
- background status/wait/cancel 完成；
- Child 不加载 `mmp:task`；
- Parent 退出后 Child 被回收；
- Hook 能阻止一个明确的工具调用；
- Hook timeout 不悬挂 Session。

### 阶段 E：端到端验收

必须跑通：

```text
MMP SDK Host 启动
-> 使用 Manifest 显式装配
-> 加载 RULES
-> 读取 Skill
-> 启动隔离 Subagent Worker
-> 调用 MCP
-> Hook 拦截一次工具调用
-> 触发 Pi Auto Compact
-> Session 退出
-> 回收所有 Child 和 MCP 子进程
```

## 16. 发布前验收标准

### 配置与资源

- 空 Manifest 不加载可选 Task/MCP/Hooks；`mmp:runtime` 始终存在；
- Pi ambient 资源发现关闭；MMP 自己的三个固定 Skill 根按 §7.1 工作；
- 删除一个 Extension 声明后，它的 tool、handler、状态和子进程全部消失；
- 错误本地路径和错误 schema 在 Pi Session 创建前失败；
- global/project provenance 可从 `--dry-run` 复核；
- 未授权项目配置不会被打开；
- Pi resource flags 不能绕过 Manifest；
- `--dry-run` 不安装 npm/git Extension source。

### 安全

- Pi 主 runtime 在当前进程通过 SDK 启动；
- 所有 Child 和 command handler 使用 argv 数组；
- 不使用隐式 shell 插值；
- capsule 文件权限正确并按生命周期清理；
- dry-run 和错误日志不泄漏 secret；
- project Extension 只能在统一 trust 决策后加载；
- Session shutdown 取消 Task、Hook 和 MCP 在途工作。

### 生命周期

- 不存在 process-global Job/MCP/Hook Registry；
- Session 切换不会遗留旧 handler；
- Child 不能在 Parent 退出后继续存活；
- MCP stdio server 必须被回收；
- 失败的独立 Job 不影响其他 Job；
- 主进程退出不遗留 MMP 临时配置目录。

### 兼容性

- exact pin Pi（见 `package.json`）；
- Node.js 低于 `22.19.0` 时启动前 fail-fast；
- `mmp --version` 同时显示 MMP 和 Pi 版本；
- MMP 不依赖全局 `pi`；
- 启动时检测 package 实际版本与期望版本不一致并 fail-fast；
- 契约测试覆盖 `main(args, { extensionFactories })`、`InlineExtension`、`ProjectTrustStore`、`--no-context-files` 和 MCP factory；
- Pi 升级只通过显式依赖更新和完整阶段 E 验收完成。

## 17. 当前非目标

以下不在当前实现范围；长期 Harness 方向按决策 H1 单独评估：

- Pi fork；
- OMP 配置兼容；
- Claude/Codex/Cursor 配置自动导入；
- 自动发现任意 Harness 资源；
- GUI 配置中心；
- Extension marketplace；
- 第二套 project trust database；
- Agent Teams、共享黑板或 IRC；
- Workflow/Chain DSL；
- Autonomous Memory/Autolearn；
- 自定义 Agent Loop；
- 替换 pi-tui 底层渲染器（MMP 自有交互应用已实现）；
- 自定义 Compact；
- 自定义 MCP Runtime；
- 审批分级（H3/K6：和 Pi 一样默认不审批，分级以后再定）；
- 通过 shell 或全局 `pi` binary 启动主 runtime；
- 100% 复刻 Pi CLI 的 resource override 行为。

## 18. 开发与合并门禁

从仓库根目录执行：

```bash
npm ci --ignore-scripts
npm run build
git diff --exit-code -- dist
npm test
```

开发流程与独立审查要求见 [dev-workflow.md](dev-workflow.md)。`dist/` 必须在同一提交中更新。CI 的颜色断言应使用主题的语义颜色 API，不写死当前终端的真彩色字节。手工 TUI 验收见 [e2e-acceptance.md](e2e-acceptance.md)；没有真实终端或 provider 的环境应明确记录未验证项。

自开发配置模板见 [examples/development](../examples/development/README.md)，按需复制到本地 `.mmp/`，不提交活动配置。

## 19. 参考资料

版本固定资料：

以下链接里的版本号换成 `package.json` 里当前锁定的 `@earendil-works/pi-coding-agent` 版本：

- Pi package：<https://unpkg.com/@earendil-works/pi-coding-agent@VERSION/package.json>
- Pi SDK：<https://unpkg.com/@earendil-works/pi-coding-agent@VERSION/docs/sdk.md>
- Pi Extension API：<https://unpkg.com/@earendil-works/pi-coding-agent@VERSION/docs/extensions.md>
- Pi CLI 与 Project Trust：<https://unpkg.com/@earendil-works/pi-coding-agent@VERSION/README.md>
- Pi ResourceLoader types：<https://unpkg.com/@earendil-works/pi-coding-agent@VERSION/dist/core/resource-loader.d.ts>
- Pi ProjectTrustStore types：<https://unpkg.com/@earendil-works/pi-coding-agent@VERSION/dist/core/trust-manager.d.ts>
- Pi 最小 Subagent 示例：<https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent>
- OMP：<https://github.com/can1357/oh-my-pi>，仅用于比较已有能力和避免重复设计

`main` 分支文档只能用于发现变化，设计与实现必须以锁定版本 package 内容为准。

## 20. Benchmark 运行契约

Benchmark orchestration、任务数据、grader 和统计不进入 MMP Core。MMP 只提供稳定、可复现、机器可读的 Harness 接口；Harbor、Terminal-Bench 或其他 runner 通过外部 adapter 调用它。

### 20.1 标准机器入口

```bash
mmp \
  --mode json \
  --no-session \
  --no-approve \
  --print "<task prompt>"
```

契约：

- stdout 只包含 Pi JSONL event，不混入 banner、诊断或进度文本；
- MMP 启动诊断、配置错误和资源 provenance 写入 stderr；
- benchmark 默认使用 `--no-session`，不同 trial 不共享 Session；
- benchmark 默认使用 `--no-approve`，项目夹内临时文件不能改变 Harness 装配；
- SIGINT、SIGTERM 和 runner timeout 必须终止当前 Agent run，并回收 Task、Hook 和 MCP 子进程；
- exit code 必须稳定区分成功、MMP preflight 失败和 Pi Agent run 失败；
- measured run 期间禁止安装或更新 npm/git Extension。

### 20.2 可复现元数据

每个 trial 由外部 runner 保存：

```text
MMP version
Pi package + exact version
Node.js version
ResolvedAssembly digest
Manifest / Rules / Skills / Extension provenance
model + provider + thinking level
enabled tools
cwd + trust mode
start time + duration + exit status
Pi JSONL raw events
token usage / cost（Pi event 可用时）
```

`mmp --dry-run` 是装配快照来源。它应输出 canonical JSON；相同配置和相同可信边界必须产生相同 digest。Rules 全文、secret 和 credential 不进入快照。

### 20.3 公平对照

至少保留四个可比较 variant：

```text
pi-baseline
mmp-core-empty
mmp-rules-skills
mmp-full
```

- `pi-baseline`：同一 Pi package，不加载 MMP；
- `mmp-core-empty`：只测 SDK Host 是否引入额外行为或失败；
- `mmp-rules-skills`：测提示与知识装配的净增益；
- `mmp-full`：测 Task、MCP、Hooks 的最终效果与成本。

所有 variant 必须固定：

- model/provider/thinking；
- tool allowlist；
- context 和输出限制；
- task timeout；
- container image 和依赖；
- 输入资产；
- trial 数量与随机策略。

不能只比较最终分数；同时记录 success rate、pass@k、wall time、token/cost、timeout、tool error 和 orphan-process 数量。

### 20.4 基础设施要求

- MMP、Pi 和系统依赖预装进 benchmark image，避免把 CDN/npm 冷安装失败算成 Harness 失败；
- measured run 默认离线，除任务和模型 API 明确需要的网络外不访问外部依赖源；
- 每个 trial 使用干净 workspace 和独立 `MMP_HOME`；
- trial 结束后检查 Session、child process、MCP stdio server 和临时 capsule 是否泄漏；
- adapter 只负责调用和采集，不修改 MMP Manifest；
- 原始 JSONL、stderr、dry-run snapshot 和 grader 输出全部保留。

### 20.5 主评测矩阵

首批 benchmark 主线是 `DeepSeek-V4-Flash-0731` 对照表中的九项 Agent benchmark，不是 Harbor 4-task：

| Benchmark | 图中参考分数 |
| --- | ---: |
| Terminal Bench 2.1 | 82.7 |
| NL2Repo | 54.2 |
| Cybergym | 76.7 |
| DeepSWE | 54.4 |
| Toolathlon-Verified | 70.3 |
| Agents' Last Exam | 25.2 |
| AutomationBench Public | 25.1 |
| DSBench-FullStack | 68.7 |
| DSBench-Hard | 59.6 |

这些分数只用于标识用户指定的原始对照，不是 MMP 的验收目标，也不能当成 MMP 已复现结果。各 benchmark 的 dataset、grader、runner 和计分口径由外部 adapter 固定并记录；MMP Core 不实现任何 benchmark-specific 逻辑。

外部 runner 必须记录 provider-qualified resolved model ID；MMP 只透传模型参数，不把模型写入 Manifest。每项先跑 `pi-baseline` 与 `mmp-core-empty`，证明 SDK Host 本身没有回归，再逐层启用 Rules、Skills、Task、MCP 和 Hooks。

### 20.6 Benchmark-ready 验收

在正式跑分前必须验证：

1. stdout 可被 JSONL parser 从头到尾解析；
2. 同一 bundle 连续两次 `--dry-run` digest 相同；
3. 不同 trial 不共享 Session、trust 或 Extension state；
4. runner timeout 后没有残留进程；
5. PATH 中没有全局 `pi` 时 MMP adapter 仍工作；
6. baseline 与 MMP variant 使用同一个 Pi（`package.json` 锁定的版本）和同一模型参数；
7. benchmark adapter 的失败能区分 infra、Harness、model 和 grader 四类。

Benchmark 不是阶段 A/B 的实现内容，但阶段 A 的 JSON mode、stdout/stderr、exit code 和 signal contract 必须从第一天保持兼容，避免 Harness 完成后再为跑分重写入口。

### 20.7 已实现的外部 adapter

仓库提供 `scripts/benchmark-adapter.mjs`，通过 `npm run benchmark -- ...` 调用。它不进入 MMP Core，也不包含 dataset 或 benchmark-specific grader 逻辑。

职责：

- 支持 `pi-baseline`、`mmp-core-empty`、`mmp-rules-skills`、`mmp-full` 四个 variant；
- 直接启动固定依赖中的 Pi/MMP Node.js 入口，不依赖 PATH 的全局 `pi`；
- 从只读 bundle 模板创建 trial 专属 `MMP_HOME`，排除 auth、trust、sessions、`.env*`、旧 capsule 和 artifacts；
- measured run 固定注入 JSON mode、`--no-session`、`--no-approve`、`--offline`、provider-qualified model、thinking、tool allowlist 和 timeout；
- 连续执行两次 MMP dry-run 并比较原始输出；装配 digest 同时覆盖规范化 dry-run snapshot 和 bundle 文件 SHA-256；
- 原样保留 request、assembly、fingerprint、Pi JSONL、stderr、可选 grader 输出及 metadata；
- metadata 汇总 resolved model、token/cost、tool 调用/错误、compaction、Session/trust/capsule 和 orphan-process 检查；
- 退出码稳定区分 success `0`、Harness `2`、infra `3`、model `4`、grader `5`；所有 child/grader 均使用 argv 数组，不经过 shell。

机器契约由 `test/benchmark-adapter.test.mjs` 覆盖，包括：相同 bundle 跨独立 trial digest 一致、敏感状态不复制、PATH 无全局 `pi`、严格 JSONL、timeout 终止和四类失败映射。

本机真实 smoke 产物（`reports/` 已被 Git 忽略）：

- `reports/benchmark-adapter/mmp-full-smoke-2026-08-02/metadata.json`；
- `reports/benchmark-adapter/pi-baseline-smoke-2026-08-02/metadata.json`。

两者均使用依赖中的 Pi `0.83.0` 和 resolved model `openrouter/openai/gpt-4o-mini`，分别返回 `BENCHMARK_ADAPTER_OK` 与 `BASELINE_ADAPTER_OK`。升级到 Pi `0.87.1` 后 system prompt 的格式变了（改为 `<tools>`、`<rules>`、`<docs>`、`<cwd>` 分段），这两个冒烟和基线都要重跑；重跑会调用真实模型、产生费用，还没做。

## 21. 当前验证与遗留项

已完成：

- 固定 `@earendil-works/pi-coding-agent`（版本见 `package.json`），并在启动时核验实际 package 版本；
- SDK Host、Manifest、Project Trust、固定根 Skill 发现、Task/Hooks、原生 MCP、自有 TUI 与 Pi Session/Auto Compact 已实现；
- 离线契约测试覆盖上述路径；历史真实模型 smoke、Task/MCP/Hook E2E 与自动压缩记录只证明其当时版本，不能替代当前版本实测；
- 外部 benchmark adapter、四 variant 入口、可复现 metadata/digest、隔离/泄漏检查和四类失败映射；
- 真实 `mmp-full` 与 `pi-0.83-baseline` adapter smoke（Pi 0.83.0 时完成；升到 0.87.1 后变体名一度改为 `pi-0.87-baseline`，这次 Pi 升级自动化改造后统一去掉版本号，改为 `pi-baseline`，还没重跑）。

尚未完成：

- 非交互启动读取项目 `.pi/settings.json` 的隔离缺口（§8.1）；
- 其他未关闭问题以 [dogfood-issues.md](dogfood-issues.md) 为准；
- 尚未接入九项 benchmark 各自的 dataset、workspace image、provider-qualified `DeepSeek-V4-Flash-0731` 模型标识和官方 grader；
- 尚未产出任何正式 benchmark 分数。

下一入口：为九项 benchmark 分别固定外部 runner/grader 与可用的 provider-qualified model ID；先跑 `pi-baseline` 和 `mmp-core-empty`，再跑后两层 variant。
