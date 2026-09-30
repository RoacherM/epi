# Make My Pi 开发文档

- 项目：MMP（Make My Pi）
- 状态：阶段 A-E、Benchmark adapter 与 benchmark-ready 契约测试已完成
- 目标目录：`~/Desktop/Projects/Devs/mmp`
- 目标依赖：`@earendil-works/pi-coding-agent`（见 `package.json`）；Node.js `>=22.19.0`
- 当前验证环境：`package.json` 锁定的 Pi 版本已通过全部契约测试、ambient 隔离测试和离线 MCP 验收；真实模型冒烟和 benchmark adapter 冒烟是 Pi `0.83.0` 时做的，升级后还没重做，之后每次升级也要看是否需要重跑（见 `docs/pi-upgrade-design.md` 第 3 节"模型可见内容快照"）。OMP `17.1.3` 仅作能力边界参考，不是运行依赖
- Pi 升级：设计见 `docs/pi-upgrade-design.md`（版本锁死、升级自动化，已定，见 `docs/decisions.md`）
- 交互界面：设计见 `docs/tui-design.md`，代码在 `src/tui/`，是 `mmp` 唯一的交互入口（不再启动 Pi 经典交互界面），进度见设计文档第 15 节
- 最后更新：2026-09-29

## 1. 产品定义

MMP 是一个基于 Pi SDK（当前锁定版本见 `package.json`）的确定性 Agent Harness。它不是 Pi fork，也不是通过 shell 启动全局 `pi` 二进制的薄包装器。

> MMP 读取 `~/.mmp/mmp.json`，在可信边界内显式选择 Rules、Skills 和 Extensions，然后在当前 Node.js 进程中调用锁定版本的 Pi SDK。

所有权分为三层：

```text
Pi Core    owns agent runtime primitives
MMP        owns harness policy and composition
Extension  owns capability
```

- Pi Core 负责 Agent Loop、ModelRuntime、认证、Session 格式与管理、TUI 实现、Print/RPC 模式、基础工具和 Auto Compact。
- MMP 负责自己的 CLI、Pi 版本锁定、运行时身份、Manifest、Project Trust、资源选择、provenance、首批能力装配和启动失败语义。
- 独立 Extension 负责 Task、MCP、Hooks 等具体能力。

MMP v0 使用 Pi 公开的：

```ts
main(args, { extensionFactories })
```

作为最小 SDK Host 缝。这样保留 Pi 原生 CLI、TUI、Session 和模式语义，同时不依赖机器上另行安装的 `pi` 命令。

如果未来需要自定义 UI 或直接访问 Agent 状态，再下沉到：

```ts
createAgentSessionRuntime()
InteractiveMode
runPrintMode()
runRpcMode()
```

首版不为“看起来更像自己的 Harness”而提前复制这些实现。

MMP 始终注入内置 `mmp:runtime` Extension。它用 `ctx.ui.setHeader()` 在 TUI 启动页展示身份、Manifest 状态与核心配置入口；在每轮 `before_agent_start` 中结合 `ResolvedAssembly` 与 Pi 的 `systemPromptOptions.skills` 生成权威 runtime inventory，明确区分“MMP 已加载资源”和“宿主机上存在的文件”。`/mmp` 向用户显示同一份清单。Print、JSON/RPC、dry-run 和 benchmark 不渲染启动页。

## 2. 核心架构

```text
mmp CLI
  |
  +-- 解析 MMP 自有参数
  +-- 读取 ~/.mmp/mmp.json
  +-- 依据 Pi ProjectTrustStore 决定是否读取 <repo>/.mmp/mmp.json
  +-- 解析并校验 Rules / Skills / Extensions
  +-- 生成 ResolvedAssembly 与 provenance
  +-- 创建固定 mmp:runtime 与 Manifest 声明的 Task / MCP / Hooks factories
  +-- 生成受控的 Pi argv
  +-- await piMain(piArgs, { extensionFactories })
         |
         +-- Pi ModelRuntime / SettingsManager / ResourceLoader
         +-- Pi AgentSessionRuntime
         +-- Pi InteractiveMode / PrintMode / RpcMode
         +-- Pi Session / Compact / built-in tools
         +-- MMP 与显式第三方 Extensions
```

入口代码形态：

```ts
import { main as piMain } from "@earendil-works/pi-coding-agent";

await piMain(piArgs, { extensionFactories });
```

禁止：

```ts
spawn("pi", args);
exec(`pi ${args.join(" ")}`);
```

原因：

- 不能依赖用户 PATH 中另一个版本的 Pi；
- 不能让全局 Pi 升级绕过 MMP lockfile；
- 不需要为同进程 SDK 调用复制 Pi 的 TUI、Session 或 Agent Loop；
- 首批内置 Extension 可以通过 closure 接收已解析配置，不需要环境变量或临时 JSON 桥接。

Pi 从 0.83 起支持完整关闭 ambient resources（由 `test/ambient-isolation.test.mjs` 验证，包括 0.84 新增的 `AGENTS.override.md`）：

```text
--no-extensions
--no-skills
--no-prompt-templates
--no-themes
--no-context-files
--system-prompt ""
--append-system-prompt ""
```

后两个参数 2026-09-29 补上：五个 `--no-*` 参数都管不到 `SYSTEM.md` / `APPEND_SYSTEM.md` 的自动发现（Pi 0.46 起就有），之前 `~/.mmp/pi/SYSTEM.md` 会进入 system prompt，`mmp --approve` 时项目 `.pi/SYSTEM.md` 也会。传空值会跳过自动发现，Pi 仍用默认 prompt（实测前后 system prompt 逐字一致）。

显式资源仍可通过 `--extension`、`--skill` 和 `extensionFactories` 加载。因此最小运行缝是：

```text
manifest + trust
-> resolved assembly
-> Pi argv + inline factories
-> Pi SDK main
```

不实现 `mmp-bootstrap` Extension。资源选择在 Pi Session 创建前完成，Bootstrap Extension 会把启动策略错误地下沉到能力层。

## 3. 不可违反的边界

### 3.1 Pi Core 拥有这些能力

MMP 不重新实现：

- Agent Loop；
- Model/provider runtime；
- Authentication；
- Session JSONL 格式、tree、resume、fork 和 compact；
- TUI renderer、editor 和内置命令；
- Interactive、Print、JSON 和 RPC 运行模式；
- Auto Compact；
- Pi 基础工具实现；
- MCP 协议栈；
- 通用 Extension 生命周期。

MMP 可以构造和启动这些公开 runtime primitive，但不能 fork 或复制其内部实现。

### 3.2 MMP 必须拥有这些能力

- 锁定并直接依赖唯一 Pi 版本；
- `~/.mmp` 和项目 `.mmp` 配置根；
- Manifest schema、相对路径解析和 fail-fast 校验；
- `.mmp` 项目资源的 trust gating；
- Rules、Skills、Extensions 的确定性选择和 provenance；
- 首批内置 Extension factory 的装配；
- `--dry-run`、版本输出和启动前错误；
- 子进程能力的回收边界。

### 3.3 MMP 不复制这些 OMP 结构

- Capability Registry；
- 多 Harness Discovery Provider；
- Profile 系统；
- 通用 Settings Registry；
- Vibe/Goal/Plan 等运行模式；
- Agent Hub、IRC、Collaboration Runtime；
- Advisor、Autolearn、Prewalk；
- Marketplace、Updater、Gallery、Bench、Stats；
- 多套 Memory Backend；
- 全局进程 Registry。

### 3.4 未声明即不存在

```text
未声明
= 不发现
= 不导入
= 不注册工具
= 不注入 Prompt
= 不读取项目 Context Files
= 不创建状态
= 不需要清理
```

空 Manifest 仍可启动 Pi，但只包含 Pi Core 和 MMP 明确允许的基础运行语义，不包含任何 MMP Extension。

## 4. 推荐仓库结构

单 npm 包，不建 monorepo：

```text
mmp/
├── package.json
├── package-lock.json
├── tsconfig.json
├── DEVELOPMENT.md
├── src/
│   ├── cli.ts
│   ├── manifest.ts
│   ├── resolve.ts
│   ├── paths.ts
│   ├── trust.ts
│   ├── pi-args.ts
│   ├── worker.ts
│   └── extensions/
│       ├── task.ts
│       ├── mcp.ts
│       └── hooks.ts
└── test/
    ├── manifest.test.ts
    ├── sdk-host.test.ts
    ├── project-trust.test.ts
    ├── pi-args.test.ts
    └── fixtures/
```

构建结果：

```text
dist/
├── cli.js
├── worker.js
└── extensions/
    ├── task.js
    ├── mcp.js
    └── hooks.js
```

`package.json` 对外只暴露一个 CLI：

```json
{
  "name": "mmp",
  "type": "module",
  "engines": {
    "node": ">=22.19.0"
  },
  "bin": {
    "mmp": "./dist/cli.js"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "<exact version, see package.json>"
  }
}
```

要求：

- Pi 使用 exact version，不使用 `^` 或 `~`；
- 使用固定 lockfile；
- TypeScript + ESM；
- 不引入 DI、通用插件框架或通用配置框架；
- `worker.js` 只供 Task Extension 内部启动，不暴露第二个用户 CLI。

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
  "extensions": [
    "mmp:task",
    "mmp:mcp",
    "mmp:hooks"
  ]
}
```

类型边界：

```ts
interface MmpManifestV1 {
  version: 1;
  rules?: string[];
  skills?: string[];
  extensions?: string[];
}
```

Extension source scheme：

```text
mmp:task               -> 包内 createTaskExtension(config)
mmp:mcp                -> 包内 createMcpAdapter({ config })
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
```

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

Extension 自己负责其配置文件的 schema 和 global/project 合并语义。Harness 只向已启用的内置 Extension 传递可信配置根；未启用的 Extension 不读取对应配置文件。

### 7.1 Skill 自动发现（docs/decisions.md S1）

除 Manifest 声明的 skill 路径外，`resolveAssembly`（`src/assembly.ts` 调用 `src/skill-discovery.ts` 的 `discoverSkillRoots`）还固定发现三个目录，缺失时跳过：

- 全局 `~/.agents/skills`（`HOME` 通过与其它地方一致的方式解析——`environment.HOME`，缺省时才用真实 `os.homedir()`；测试通过 `environment.HOME`/进程 `HOME` 注入临时目录，绝不触碰真实 home）；
- MMP 自己的全局 `<mmpHome>/skills`；
- 被信任项目的 `<project.root>/.mmp/skills`——`trustedProjectRoot` 只在 `project.discovery === "loaded"` 时给出，即项目必须先有 `.mmp/mmp.json` 才算 MMP 项目；只有 `.mmp/skills`、没有 `.mmp/mmp.json` 的目录不会被当成项目，其 skills 也不会被发现。

永远不读取 Pi 自己的 skill 位置（`~/.pi/agent/skills`、MMP 的 Pi 数据目录 `<mmpHome>/pi/skills`、项目 `.pi/skills`），也不读取项目 `.agents/skills`（不是用户为 MMP 选定的目录，`test/ambient-isolation.test.mjs`/`test/tui-services.test.mjs` 持续验证这四处保持不可见）。

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

**已知问题（2026-09-29 实测，0.83.0 和 0.87.1 都有）**：Pi 启动查找会话时会读取项目的 `.pi/settings.json`，不经过 trust 判断（0.87.1 `main.js` 的 `SettingsManager.create(cwd, agentDir)`），`--no-approve` 也挡不住。这违反了 MMP 不读 `.pi/` 的承诺，见 `docs/tui-design.md` 3.3 节。

**已修复（2026-09-29）**：以前 MMP 会把自己的 `--approve` 原样转给 Pi，`mmp --approve` 时项目 `.pi/settings.json` 会在运行阶段整份生效（实测：项目设置指定的模型被选中）。现在 MMP 不再转发，并固定给 Pi 传 `--no-approve`，由 `test/ambient-isolation.test.mjs` 覆盖。

MMP 使用 Pi 导出的 `ProjectTrustStore` API，不直接解析 `trust.json`，也不创建第二套 trust database。

### 8.2 MMP v0 决策

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

### 9.1 参数所有权（2026-09-29 起：见 [cli-design.md](docs/cli-design.md)）

`src/args.ts` 的 `MMP_FLAG_TABLE` 是唯一一张参数表，同时驱动解析、校验和 `mmp --help`。清单外的参数（`--xxx`/`-x` 形状但不在表里）一律 `Unknown option: ...` 报错退出，不再像早期版本那样把无法识别的 `--flag` 静默塞进 Pi 的 `unknownFlags`（extension 注册的自定义 CLI flag 因此不再能用；这是明确的取舍，不是遗漏）。

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

子命令 `update`/`install`/`remove`/`uninstall`/`list`/`config`/`auth` 只在 `argv[0]` 位置被识别，由 `host.ts` 的 `runMmp` 在参数表解析之前整体接管（`src/commands/manifest-cli.ts`、`src/commands/auth-cli.ts`、`src/update.ts`），从不进入上面的参数表，也从不转发给底层的 CLI 子命令处理逻辑——它们读写的是 MMP 自己的 Manifest 和 `~/.mmp/pi`，不是底层的 `settings.json`。

`--verbose`：非交互路径原样转发；交互界面里由 `src/extensions/runtime.ts` 的 `mmp:runtime` 扩展在 `session_start`（`reason: "startup"`、`mode: "tui"`）时把启动信息（已加载 Rules/Skills/Extensions 数量、当前模型、当前 Session）显示成对话区提示，不产生底层的 verbose 输出格式。

其他参数示例：

```bash
mmp --model anthropic/claude-sonnet-4 --thinking high --print "fix this"
```

### 9.2 核心流程

```ts
import {
  main as piMain,
  ProjectTrustStore,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

async function main(argv: string[]) {
  const options = parseMmpArgs(argv);
  const globalRoot = resolveMmpHome();
  const agentDir = `${globalRoot}/pi`;
  const projectRoot = options.noProject
    ? undefined
    : findNearestProjectMmp(process.cwd());

  const projectTrusted = resolveProjectTrust({
    projectRoot,
    override: options.projectTrustOverride,
    trustStore: new ProjectTrustStore(agentDir),
  });

  const resolved = resolveAssembly({
    globalRoot,
    projectRoot: projectTrusted ? projectRoot : undefined,
  });

  const extensionFactories = buildInlineExtensions(resolved);
  const piArgs = buildPiArgs(resolved, options.passthrough);

  if (options.dryRun) {
    printDryRun(redactResolvedAssembly(resolved));
    return;
  }

  process.env.PI_CODING_AGENT_DIR = agentDir;
  await piMain(piArgs, { extensionFactories });
}
```

### 9.3 Pi argv

```ts
function buildPiArgs(
  resolved: ResolvedAssembly,
  passthrough: string[],
): string[] {
  return [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    ...resolved.externalExtensions.flatMap(resource => [
      "--extension",
      resource.value,
    ]),
    ...passthrough,
  ];
}
```

Rules 与 Skills 不冻结在 Pi argv 中。`mmp:runtime` 在 `before_agent_start` 注入当前 Rules，并通过 `resources_discover` 返回当前 Skill roots；Pi 的 `/reload` 重建 Extension 后，MMP 会先重新解析 Manifest，再让 Pi 扫描更新后的 Skills。解析失败时保留上一份有效装配并显示错误。Extension factory、外部 Extension 以及 MCP/Hooks/Task 配置仍是启动期能力，修改后必须重启 MMP。

### 9.4 运行约束

```text
PI_CODING_AGENT_DIR=~/.mmp/pi
```

- 不查找全局 `pi`；
- 不启动 shell；
- 不 spawn Pi 主进程；
- 不通过环境变量传递配置 JSON 或 secret；
- `await piMain()` 返回后才允许 MMP CLI 退出；
- Pi SDK 初始化失败直接以非零状态失败，禁止 fallback 到全局 Pi。

## 10. Effective Assembly

MMP 在内存中构造本次运行的有效装配：

```ts
interface ResolvedAssembly {
  piVersion: string; // installed Pi's VERSION export; see package.json for the pin
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
    source: "global" | "project";
    declaredIn: string;
  }>;
}
```

内置 Extension 的有效配置通过 factory closure 传递：

```ts
const extensionFactories: InlineExtension[] = [
  {
    name: "mmp:mcp",
    factory: createMcpAdapter({ config: effectiveMcpConfig }),
  },
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
    {
      "name": "mmp:task",
      "source": "global"
    }
  ],
  "externalExtensions": []
}
```

它必须能回答：

- 实际链接的是哪个 Pi package 和版本；
- MMP 是否会调用 SDK 而不是全局 binary；
- 加载哪些 Rules、Skills 和 Extensions；
- 每项来自 global 还是 project；
- 项目配置是否被信任和读取；
- 哪些 Extension 是 inline factory，哪些交给 Pi package resolver；
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

MMP 不实现 MCP 协议栈。`mmp:mcp` 只负责：

```text
global mcp.json
+ trusted project mcp.json
-> validate and build effective MCP config
-> createMcpAdapter({ config })
-> InlineExtension factory
```

实现轮廓：

```ts
import { createMcpAdapter } from "pi-mcp-adapter";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export function createMmpMcpExtension(config: McpConfig): InlineExtension {
  return {
    name: "mmp:mcp",
    factory: createMcpAdapter({ config }),
  };
}
```

已核实 `pi-mcp-adapter`（见 `package.json`）提供 programmatic factory：

```ts
createMcpAdapter({
  config?: McpConfig;
  configPath?: string;
})
```

`pi-mcp-adapter` 已 exact pin（见 `package.json`）。2.17.0 在 Pi 0.87 下无法加载（`pi-ai` 不再导出 `complete`），升级 Pi 时一起换成 2.x 最后一版。它在当前锁定的 Pi 版本上通过离线验收：`test/mcp.test.mjs` 用 faux provider 按剧本驱动真实 stdio MCP `search -> call`，同时覆盖环境变量展开与 Session 退出回收。（2.17.0 当初在 Pi `0.83.0` 上是用真实模型验收的。）

MMP 不拥有 transport、OAuth、connection lifecycle、tool discovery/call、renderer 和 metadata cache。

## 14. Hooks Extension

`mmp:hooks` 已实现为 Pi `InlineExtension`。它只在 Manifest 显式声明 `"mmp:hooks"` 时装配：

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

## 15. 实现阶段与验证

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
- 用 inline `createMcpAdapter({ config })` 接入 MCP；
- 锁定通过契约测试的 `pi-mcp-adapter` 版本。

验证：

- Agent 实际遵循一条 MMP Rule；
- Agent 能读取 Manifest 中声明的 Skill；
- 未声明的 `.pi/skills`、`.agents/skills` 和项目 Context Files 不可见；
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

- 空 Manifest 不加载任何 MMP Extension；
- ambient Extensions、Skills、Prompt Templates、Themes 和 Context Files 全部关闭；
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

## 17. 明确非目标

首版不实现：

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
- 自定义 TUI renderer；
- 自定义 Compact；
- 自定义 MCP Runtime；
- 通过 shell 或全局 `pi` binary 启动主 runtime；
- 100% 复刻 Pi CLI 的 resource override 行为。

## 18. 开工后的第一步

切换到项目目录后，先只实现阶段 A 和阶段 B，不先写 Task、MCP 或 Hooks：

```bash
cd ~/Desktop/Projects/Devs/mmp
```

第一批代码的完成标准：

```text
1. mmp CLI 通过 package dependency 启动固定版本的 Pi（见 package.json）；
2. 不依赖 PATH 中的全局 pi；
3. Pi model/session/tool 参数无损交给 piMain；
4. Pi resource flags 被 MMP 保留并 fail-fast；
5. mmp.json 能解析、校验和解析相对路径；
6. --approve / --no-approve / --no-project 行为可复核；
7. --dry-run 输出完整 provenance；
8. 真实 mmp --print 冒烟成功。
```

只有该 SDK Host 装配缝真实跑通后，才继续实现三个能力 Extension。

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
- pi-mcp-adapter：<https://github.com/nicobailon/pi-mcp-adapter>
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

## 21. 当前交接状态

已完成：

- 固定 `@earendil-works/pi-coding-agent`（版本见 `package.json`），并在启动时核验实际 package 版本；
- SDK Host、Manifest、Project Trust、Rules、Skills、Task、MCP、Hooks、Pi CLI/TUI/Session/Auto Compact 全链路实现；
- 阶段 A-E 的契约测试、真实模型 smoke、完整 Task/MCP/Hook E2E 与自动压缩验证；
- 外部 benchmark adapter、四 variant 入口、可复现 metadata/digest、隔离/泄漏检查和四类失败映射；
- 真实 `mmp-full` 与 `pi-0.83-baseline` adapter smoke（Pi 0.83.0 时完成；升到 0.87.1 后变体名一度改为 `pi-0.87-baseline`，这次 Pi 升级自动化改造后统一去掉版本号，改为 `pi-baseline`，还没重跑）。

尚未完成：

- 尚未接入九项 benchmark 各自的 dataset、workspace image、provider-qualified `DeepSeek-V4-Flash-0731` 模型标识和官方 grader；
- 尚未产出任何正式 benchmark 分数。

下一入口：为九项 benchmark 分别固定外部 runner/grader 与可用的 provider-qualified model ID；先跑 `pi-baseline` 和 `mmp-core-empty`，再跑后两层 variant。
