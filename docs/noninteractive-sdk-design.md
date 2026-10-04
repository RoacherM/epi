# 非交互模式改走 SDK（设计）

状态：**用户已确认**（2026-10-04："我觉得2更好"、"当然用层次2的方式"、"当然是A"），决策 N1、MG2（[decisions.md](decisions.md)）。实现中；本文随实现更新。

每条结论后面标了来源：**源码** = 读 Pi 或 MMP 的代码得到；**实测** = 跑出来的；**主控定** = 我自己定的做法，你可以改。

## 1. 术语

| 术语 | 意思 |
|---|---|
| 非交互模式 | `mmp -p`（print，打印回答后退出）、`--mode json`（每个事件一行 JSON）、`--mode rpc`（从 stdin 读命令、往 stdout 写事件，给别的程序调用）。benchmark 用的就是这些模式 |
| `piMain` | Pi 包导出的 `main()` 函数（`dist/main.js`），就是 `pi` 命令行本身。MMP 把参数交给它，之后发生什么 MMP 都插不进去 |
| SDK 路径 | MMP 自己调用 Pi 导出的函数搭出会话：`createAgentSessionServices` → `createAgentSessionFromServices` → `createAgentSessionRuntime`。交互界面已经这样做（`src/tui/services.ts` 的 `createMmpRuntime`） |
| runtime | `createAgentSessionRuntime` 的返回值，包着一个会话，能换会话（`/new`、`switch_session`） |
| 模式运行器 | Pi 导出的 `runPrintMode(runtime, 选项)` 和 `runRpcMode(runtime)`：拿到 runtime 以后负责 print/json/rpc 的全部输入输出 |

## 2. 现状和问题

```
mmp <参数>
  ├─ 子命令、--help、--version、--list-models、--dry-run   → MMP 自己实现
  ├─ 交互（终端里直接运行）                                → SDK 路径：createMmpRuntime → MMP 的界面
  └─ -p / --mode json / --mode rpc / --export             → piMain(参数)        ← 本文要改的
```

非交互模式走 `piMain`，带来两个改不掉的问题（都是**源码** + **实测**）：

| 问题 | 原因 | 为什么在 `piMain` 里修不了 |
|---|---|---|
| D80：机器忙时 `mmp -p` 偶尔报 "No API key found for the selected model" | Pi 注册 provider 后启动一次不等待的刷新，选初始模型时这次刷新可能还没跑完 | 要在"注册 provider"和"选模型"之间多等一次刷新，这两步都在 `piMain` 内部。交互路径已经加了这次等待（`src/tui/services.ts:456`） |
| D62：非交互启动仍读项目的 `.pi/settings.json`，项目的 `sessionDir` 能重定向会话 | `main.js` 创建 `startupSettingsManager` 时不传信任选项，默认当作可信 | 违反硬规则"不读项目 `.pi/`"。这个 SettingsManager 在 `piMain` 内部创建 |

另外，MMP 为了管住 `piMain` 已经加了三处绕行：改写 stdout/stderr 的文字（`rewritePiOutput`）、启动前单独查一次跨项目会话（`refusePiMainCrossProjectSession`）、`piMain` 返回后强制退出（D50）。每多一个 `piMain` 的问题就要多一处这样的绕行。

## 3. 方案

非交互模式改用和交互界面同一个 `createMmpRuntime`，再把 runtime 交给 Pi 导出的模式运行器。

```
mmp -p / --mode json / --mode rpc
  1. 解析参数、检查参数组合                （MMP，已有：createMmpRuntime 里）
  2. 接管 stdout                           （Pi 的 output-guard，按文件路径引用）
  3. createMmpRuntime                      （MMP，已有；内部多等一次刷新 → 修 D80；
                                            SettingsManager 一律 projectTrusted:false → 修 D62）
  4. 读 stdin 里的内容、拼第一条消息        （MMP：照 Pi 的 readPipedStdin / prepareInitialMessage）
  5. 打印启动诊断；有错误或没有模型就退出 1 （MMP：照 main.js 的格式）
  6. runPrintMode(runtime, …) 或 runRpcMode(runtime)   （Pi 导出，原样使用）
  7. 写完 stdout/stderr 后退出              （MMP，已有：D50 的做法）
```

第 1、3 步是现成的；第 6 步是 Pi 导出的函数；真正新写的是第 2、4、5 步，都是照 `main.js` 对应段落写的小段代码。

### 3.1 `piMain` 做了什么，新路径谁来做

逐项对照 `main.js` 的 `main()`（**源码**）。"已有"表示交互路径现在就在做。

| `piMain` 里的步骤 | 新路径 | 说明 |
|---|---|---|
| `--offline` → `PI_OFFLINE=1` | 已有 | `createMmpRuntime` |
| 应用 `httpProxy`、配置 HTTP | 已有 | `configureHttpAtStartup` |
| 参数诊断，错误退出 1 | 已有，要改输出格式 | 交互路径抛 `MmpArgumentError`；非交互要保持 Pi 的 `Error: …` 行 |
| `takeOverStdout()`：把 stdout 留给模式运行器，其他输出转到 stderr | **新增** | `core/output-guard.js` 没有导出，按文件路径引用，登记进 `pi-internals.md`（已有一行 `output-guard-stdout-write`，扩展它） |
| rpc 模式拒绝 `@file` 参数 | **新增** | 一行检查 |
| `--fork`、`--session-id` 的参数组合检查 | 已有 | `validateSessionFlagCombinations` |
| `runMigrations` | 不做 | 交互路径也不做（MMP 的 `~/.mmp/pi` 没有要迁移的旧数据）。**主控定** |
| 选会话（`--session`、`-c`、`--fork`、`--no-session`、`--session-dir`） | 已有 | `buildSessionManager`，已经含跨项目检查，所以 `refusePiMainCrossProjectSession` 可以删 |
| 会话的 cwd 不存在：非交互直接报错退出 | 已有，要核对文案 | |
| `--name` | 已有 | |
| 建 services、选模型、`--api-key`、建会话 | 已有 | `createMmpRuntime` 的 `createRuntime` |
| 读 stdin（非 TTY 时读到结束） | **新增** | 照 `readPipedStdin`，约 15 行 |
| 拼第一条消息（stdin 内容 + `@file` + 位置参数） | 已有一半 | `file-arguments.ts` 的 `buildTuiInitialMessages` 已处理 `@file`；要加 stdin 内容 |
| `initTheme` | **新增** | Pi 导出；非交互模式下只影响扩展拿到的主题对象 |
| 打印启动诊断；有错误退出 1，并附扩展加载失败的提示 | **新增** | 用 MMP 的 `extensionLoadFailureHint`，不再靠改写 stderr |
| 没有模型时退出 1 | **新增** | 用 MMP 的文案（`PROVIDER_LOGIN_HELP`） |
| rpc：后台刷新一次模型目录 | **新增** | 照 `main.js`，约 6 行 |
| `runRpcMode` / `runPrintMode` | Pi 导出 | 原样调用 |
| print/json 结束后 `restoreStdout`、设置退出码 | **新增** | 之后接 D50 的强制退出 |

### 3.2 哪些东西会删掉或变简单

| 现在 | 之后 |
|---|---|
| `refusePiMainCrossProjectSession`（启动前单独查一次） | 删。`createMmpRuntime` 自己查 |
| `rewritePiOutput` 里"抓 stderr 上的加载错误行、替换 Pi 的提示" | 删。启动诊断由 MMP 自己打印 |
| `rewritePiOutput` 里"替换 Pi 的登录指引文字" | **保留**。模式运行器在运行中仍会打印 Pi 的文字（例如中途的 "No API key found"） |
| `guardClosedStdout`（D54） | 保留，安装时机不变（接管 stdout 之前） |
| `piMain` 这个依赖 | 只剩 `--export` 还用（见 5.4） |
| `createMmpRuntime` 放在 `src/tui/` | 不挪（见第 6 节 T1） |

### 3.3 状态清单

新路径不引入跨会话的新状态。要核对的是 `createMmpRuntime` 里原来只为交互界面考虑的地方：

| 状态或行为 | 交互界面的做法 | 非交互要怎样 |
|---|---|---|
| 启动错误 | 抛一个带多行文字的 `Error`，界面外打印 | 逐行打印 `Error: …` / `Warning: …`，和现在的 `-p` 输出一致 |
| 警告和提示类诊断 | 进会话后显示在对话区 | 打印到 stderr（Pi 在非交互模式下的做法） |
| rpc 的 `switch_session`、`new_session` | `/resume`、`/new` 走同一个 `createRuntime` | 相同。替换会话时的错误保持为诊断，不退出（D51 的做法已在 `createRuntime` 里） |
| 模型回退提示（`modelFallbackMessage`） | 对话区提示 | 核对 `piMain` 在非交互模式下是否打印，保持一致 |

## 4. 怎么验证

用户可见的输出不能变（benchmark 依赖 `-p` 和 json 的输出）。所以这是一次"不改行为的重构 + 两处有意的行为变化"。

| 检查 | 做法 | 通过标准 |
|---|---|---|
| 输出不变 | 改动前后各跑一遍同一批命令，用假模型（`test/fixtures/faux-*.mjs`），比 stdout、stderr、退出码。批次覆盖：`-p`、json、rpc 各一组正常对话；带 `@file`；stdin 管道输入；`-c`、`--session`、`--fork`、`--no-session`；`--model` 不存在；没有模型；扩展加载失败；参数错误；rpc 的 `switch_session`、`new_session` | 逐字节一致。不一致的每一处都要列出来并说明理由 |
| 有意变化 1（D80） | 加 CPU 负载反复跑默认模型是 Magpie 的 `mmp -p`（复现脚本已有） | 改动前会失败，改动后 100 次里 0 次失败 |
| 有意变化 2（D62） | 项目里放 `.pi/settings.json` 写 `sessionDir`，跑 `mmp -p` | 改动前会话写到那个目录，改动后不会 |
| 模型可见内容 | `node scripts/model-snapshot.mjs --diff test/snapshots/model-visible.json` | 无变化 |
| 现有测试 | 完整 `npm test` | 全过 |
| 真实模型 | Herdr 里用真实模型跑 `mmp -p`、json 各一次；benchmark adapter 跑一次冒烟 | 有回答，退出码 0 |
| Pi 内部接口 | `output-guard.js` 的引用登记进 `pi-internals.md` 并有测试 | 升级门禁能发现它被改 |

## 5. Magpie 改成普通的 provider 扩展（层次 2，用户 2026-10-04 定）

用户的要求：统一处理，不为这个 provider 加 fallback 或额外规则。

### 5.1 现在专门为 Magpie 写的东西

Magpie 本身是通过 Pi 公开的 `pi.registerProvider` 注册的内置扩展（**源码**），不挡升级。但有三处专门逻辑：

| 位置 | 做什么 | 之后 |
|---|---|---|
| `src/host.ts`、`src/worker.ts` 的 `selectsMagpie`、`mayNameMagpieModel` | 判断这次运行是否选了 Magpie，决定启动时要不要等它的目录。是照 Pi 的选模型规则重写的一份 | 删 |
| `magpie-extension.ts` 的启动查询和 `saveCatalog` | 抢在 Pi 前面查目录、自己写 `models-store.json`；用了没导出的 `FileModelsStore`（`pi-internals.md` 的 `models-store-file`） | 删，连同这个内部接口 |
| `magpie.ts` 的 `initialModels`、`pending`、`STARTUP_FRESH_MS`、`startupKey` | 把启动时查到的目录交给 provider，并避免 10 秒内重复查 | 删。provider 只剩 `getModels` / `refreshModels` / `stream` |

### 5.2 统一的做法

所有模式（交互、print、json、rpc、task 子进程）在选模型之前做同一件事：

```
建 services（扩展在这里注册 provider）
  → await modelRuntime.refresh({ allowNetwork: 不是离线, providers: <见 5.3>, signal: 超时 })
  → 选模型、建会话
```

**实测**（临时副本里的原型，`spike-layer2.mjs`）：Magpie 不做任何启动查询，只注册，然后等这一次刷新。加 CPU 负载跑 40 次：

| 检查 | 结果 |
|---|---|
| 刷新后默认模型能选到，`hasConfiguredAuth` 为真 | 40/40（其中 5 次刷新前是 D80 的状态：`hasConfiguredAuth=false`） |
| 目录请求次数 | 每次运行 1 次 |
| 目录存进 `models-store.json` | 是，由 Pi 自己写 |
| 进程立刻退出后留下 `.lock` 文件 | 没有 |

所以现有专门逻辑要解决的三个问题（首次运行能选到模型、目录能存下、短命进程不留锁），等一次刷新都能解决。

### 5.3 启动时刷新哪些 provider（用户定：A）

刷新所有由扩展注册的 provider，不判断"这次选了谁"。这改掉决策 MG1 里的一条：以前只有选中 Magpie 时启动才查它的目录，现在每次启动都查一次（离线时不查）。本机没装 Magpie 时是一次立刻被拒绝的本地连接，不报警告（`refreshModels` 里已有这个处理）。

否掉的做法 B：只刷新这次运行选中的 provider。它要一份通用的"这次选了哪个 provider"的判断，仍然是照 Pi 的选模型规则重写一份。

Pi 内置的 provider（Anthropic、OpenAI 等）不在这次刷新里：它们的模型目录随包自带，不需要联网就能选到模型。**源码**。

### 5.4 已定的

| 问题 | 结论 |
|---|---|
| 给 Pi 上游报 issue | 不报（用户定） |
| `--export` | 不动，继续走 `piMain`。`main.js` 在建 services、加载扩展之前就处理完 `--export` 并退出，不注册也不读取任何 provider（**源码**） |
| `src/worker.ts`（task 子进程） | 放进来。它是第三条会加载 provider 的启动路径：自己调 `createAgentSessionServices`、自己注册 Magpie、自己选模型，而且没有那次等待。task 没指定模型时走 `findInitialModel`，和 D80 是同一个竞争（**源码推断，没复现**）。改成和其他模式用同一个启动函数 |

## 6. 任务拆分（确认后再细化成 brief）

| 任务 | 内容 | 依赖 |
|---|---|---|
| ~~T1~~ | ~~把 `createMmpRuntime` 及其辅助函数从 `src/tui/services.ts` 挪到 `src/`~~ 不做（主控定）：纯挪文件，会改一批测试的 import 路径，对行为没有帮助。文件头注释已写明它现在服务所有模式 | — |
| T2 | 新的非交互入口（3 节的第 2、4、5、7 步）+ print/json 接上 `runPrintMode`；输出对比批次 | T1 |
| T3 | rpc 接上 `runRpcMode`；rpc 的对比批次 | T2 |
| T4 | `worker.ts` 改用同一个启动函数 | T1 |
| T5 | Magpie 改成普通 provider 扩展（5 节）：统一的启动刷新，删掉 5.1 列出的专门逻辑和 `models-store-file` 内部接口 | T2、T3、T4（所有路径都走同一个启动函数之后才能删） |
| T6 | 删掉 3.2 节列出的绕行；更新 `development.md` §9、`decisions.md`（D3、MG1）、`pi-internals.md`、`magpie-design.md`、`dogfood-issues.md`（D62、D80） | T5 |

T2 完成、T3 没完成的中间状态下，rpc 仍走 `piMain`，两条路径并存，可以单独合并。T5 之前 D80 已经被"多等一次刷新"修掉，T5 是把专门逻辑换成统一做法。

## 7. 风险

| 风险 | 应对 |
|---|---|
| 输出和 `piMain` 有细微差别，benchmark 结果不可比 | 4 节的逐字节对比；差别必须逐条说明 |
| Pi 升级改了 `runPrintMode` / `runRpcMode` 的签名或 `output-guard.js` | 都是 Pi 包根导出的函数（前两个）或登记过的内部接口（后一个），升级门禁有测试 |
| `main.js` 以后新增的启动步骤 MMP 不会自动跟上 | 这是 SDK 路径本来就有的代价，交互路径已经在承担；升级时对照 `main.js` 的 diff（`pi-upgrade-design.md` 的流程里加一条） |
| `createMmpRuntime` 里有只适合界面的假设 | 3.3 节的清单逐条核对并加测试 |

## 8. 实现记录

### 8.1 第一次合并：print / json / rpc 和 task 子进程（T2–T4）

**实测**（对比脚本跑 50 个场景，改动前后各一遍，路径、ID、时间归一化后逐字段比较，202 个字段）：

| 结果 | 字段数 | 说明 |
|---|---|---|
| 一致 | 197 | 包括 `-p`、json、rpc 的全部正常输出、退出码、会话文件数 |
| 有意变化（D62） | 2 | 项目 `.pi/settings.json` 的 `sessionDir` 不再生效：会话写回 `~/.mmp/pi/sessions` |
| 文案变化 | 3 | `--session`、`--fork` 找不到会话，以及 `--fork --session-id` 撞上已有会话时，Pi 打印不带前缀的 `No session found matching …` / `Session already exists …`；现在和其他参数错误一样带 `Error: ` 前缀。退出码仍是 1。**主控定**：不为这三条单独保留无前缀的写法 |

另外两处没在对比批次里、但行为变了：

- `--use-theme`、`--tui-mode` 在非交互模式下以前被 Pi 静默忽略，现在和交互模式一样报"not supported by MMP"。
- 启动诊断在终端上不再带颜色（Pi 用 chalk 上色；输出到管道或文件时本来就没有颜色）。

D80 的验证（加 CPU 负载，默认模型是 Magpie、没有保存 key）：

| 路径 | 改动前 | 改动后 |
|---|---|---|
| `mmp -p hi` | 47/60 通过 | 60/60 |
| task 子进程（`dist/worker.js`） | 55/60 通过 | 60/60 |

我原来认为这个竞争写不出确定性的测试。Fable 审查给出了做法：把 Pi 注册 provider 时启动的那次刷新拖后 60ms、每次可用性检查拖慢 250ms，改动前 `-p`、json、rpc 0/5，改动后 5/5。已做成夹具 `test/fixtures/slow-registration-refresh.mjs` 和 `test/magpie.test.mjs` 里的测试。

审查还发现两个扩展同时注册 provider 时一次等待不够：第二次不等待的刷新可能在等待期间把结果作废，默认的 Magpie 模型被跳过，运行悄悄改用另一个模型。所以 `settleRegisteredProviders` 在刷新之后核对"Pi 的快照说没有认证、provider 自己的检查说有"这种状态，不对就再刷新，最多 3 次（**主控定**）。审查的强制时序复现：修复前 0/4，修复后 4/4。

### 8.1.1 审查后补上的差异清单（第一轮 Fable 审查，P2-1）

除了上面三条 `Error: ` 前缀，非交互模式下还有这些和 `piMain` 不同（都由 MMP 自己的 `buildSessionManager` 决定，和交互模式一致）：

| 情况 | 以前（Pi） | 现在 | 处理 |
|---|---|---|---|
| `--resume` | 打开 Pi 的会话选择器 | 报错退出 1，提示用 `--continue` 或 `--session <id>` | 审查 P1：之前被静默忽略、新建了会话。选择器只有 MMP 的界面有 |
| `--session` 指向别的项目的会话 | `mmp: …` 退出 2（MMP 的预检查） | `Error: …` 退出 1 | 和其他会话错误一致（**主控定**） |
| 会话的 cwd 已不存在 | `Stored session working directory does not exist … Session file: …` | `Error: Session working directory does not exist … Use --fork …` | 用 MMP 交互模式已有的文案 |
| `--session <id 前缀>` 匹配到同项目另一个目录的会话 | 询问 `Fork this session into current directory? [y/N]` | 直接打开那个会话，在它自己的目录运行 | 和交互模式一致；非交互模式本来就不该等输入 |
| 无效的 `--session-id`（如 `../evil`） | `Error: Session id must be …` | 相同（审查发现先打印了"creating a new session"再报错，已改成先校验） | 已修 |
| `--fork <不存在或损坏的文件>` | `Error: Cannot fork …` | 相同（审查发现前缀变成了 `mmp:`，已修） | 已修 |
| 启动失败时的无效 settings 警告 | 打印 | 相同（审查发现失败路径漏了，已修） | 已修 |
| `@file` 图片在提示里的文字 | `<file name="x.png"></file>` | 相同（审查发现 MMP 写的是 `image file`，模型看到的文字不一样；已改成 Pi 的写法，交互模式也一起改了） | 已修 |
| `@file` 是需要转换格式的图片（如 BMP） | 转换说明写在 `<file>` 标签里 | 转换说明在用户消息之后（由会话统一处理） | 留着：图片内容相同，只有说明的位置不同 |

### 8.2 第二次合并：Magpie 作为普通 provider 扩展（T5、T6）

删掉的：`selectsMagpie`、`mayNameMagpieModel`、扩展 factory 里的启动查询和 `saveCatalog`、`FileModelsStore` 这个内部接口（`pi-internals.md` 的 `models-store-file`）、provider 里的 `initialModels` / `pending` / `STARTUP_FRESH_MS` / `startupKey`。`magpie-extension.ts` 从 124 行变成 18 行，只剩注册。另外删掉了 `rewritePiOutput` 里抓加载错误、替换 Pi 提示的那一半，以及对应的内部接口登记 `pi-extension-load-hint`。

统一的启动函数是 `src/provider-startup.ts` 的 `settleRegisteredProviders`，四条路径都调它：`createMmpRuntime`（TUI、print/json/rpc）、`worker.ts`、`list-models.ts`。

做的过程中多定了三件事（**主控定**，都不按 provider 名字区分）：

| 事 | 做法 | 原因 |
|---|---|---|
| 扩展 provider 的服务没运行（连接被拒绝） | 平时不提示；只有这次运行随后因为找不到 provider 或模型而失败时，才把这条刷新失败一起打印 | 每次启动都刷新所有扩展 provider，没装 Magpie 的人不该每次都看到警告；但第一次用 Magpie 而网关没开时，只报 `Unknown provider "magpie"` 会把一个失败表现成另一个（硬规则） |
| 启动刷新的总超时 | 5 秒 | 第三方 provider 的刷新时长不可知，要有上限 |
| `--api-key` | 不再用于 Magpie 的目录查询，只用于请求 | 查目录发生在选模型之前，这时还不知道 key 属于哪个 provider；其他 provider 也是这样。loopback 网关接受任意 key，所以默认 key 能查到目录；网关要求真实 key 时用 `/login` 保存 |

MG2 带来的用户可见变化：

- 用其他 provider 时，每次启动也请求一次 Magpie 目录（网关在运行时）。
- 网关挂起不回应时，每次启动多等 2 秒并打印一条警告。
- 启动后 10 秒内不重复查目录的窗口没有了：rpc 和 TUI 启动后的后台刷新会再请求一次。
- 网关没运行、但有保存的列表、又选了 Magpie 的模型时：以前启动时有一条"检查网关是否在运行"的警告，现在没有，请求本身报 `Connection error.`。

**实测**（加 CPU 负载）：

| 检查 | 结果 |
|---|---|
| 全新目录下首次运行 `-p` 和 `--list-models` 各 30 次：成功、目录已保存、没有留下 `models-store.json.lock` | 60/60 |
| 默认模型是 Magpie 的 `mmp -p hi` | 40/40 |
| task 子进程 | 40/40 |

### 8.3 第二轮审查后的修正（Fable 审查，第二部分的两条 P1）

| 发现 | 原因 | 修法 |
|---|---|---|
| rpc 首次运行、客户端约 0.5 秒内关闭 stdin，会留下 `models-store.json.lock`，下一次运行等 30 秒（基线没有这个问题） | 启动时保存目录后，Pi 的存储丢掉了文件版本号，rpc 的后台刷新要重新加锁读一次，进程在这次读里退出。旧代码在自己写完后专门读了一次；我在 5.2 的原型里只测了 `-p` 那样的短进程，没测 rpc | `settleRegisteredProviders` 在联网刷新之后总是再等一次只读刷新，把这次加锁的读放在启动里做完。审查的复现：修复前 4/4 留锁，修复后 0/4；`test/magpie.test.mjs` 有对应测试，修复前失败 |
| Magpie 是通过设置里的默认模型、`--models` 模式或 worker 的默认模型选中时，网关没运行的原因不显示：悄悄改用别的 provider，或只报 `No API key found` / `No models match pattern` | 我只在"模型参数解析报错"时才打印 | `notRunningWarnings`：模型选择出了任何问题（报错或警告）、会话没有模型、或保存的默认 provider 就是没运行的那个时，都打印 |
| 扩展用 `pi.registerProvider("anthropic", { baseUrl })` 覆盖内置 provider 时，启动刷新会去连 `pi.dev` 取那个内置 provider 的远程目录 | `getRegisteredProviderIds()` 也包含这种配置式覆盖 | 联网刷新只针对以完整 provider 对象注册的（`getRegisteredNativeProvider`） |
| 等 3 次后认证状态仍没稳定时没有任何提示 | — | 打印一条警告 |

8.2 里漏列的用户可见变化：

- 全新目录、网关在运行、没指定任何模型时，现在会直接用上 Magpie 的模型（以前报 `No API key found` 退出 1）。
- 每次换会话（`/new`、`/resume`、rpc 的 `new_session`）都会再请求一次目录；网关挂起时每次多等 2 秒。
- 如果 `127.0.0.1:3425` 上跑的不是 Magpie，每次运行都会有一条警告，而且保存的 Magpie key 会发给它（以前只在选中 Magpie 或 `--list-models` 时才会）。

没做的：等待-核对循环本身没有测试（审查 A-3）。现有的 D80 夹具只强制一次迟到的刷新，触发不了循环；审查用的是进程预加载脚本加 7 个 provider 的时序，没法做成不依赖时间的测试。
