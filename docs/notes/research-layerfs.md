# LayerFS × Epi：工作区隔离、检查点与审查的接入调研

状态：**源码调研与建议，未拍板、未实现产品集成、未做 LayerFS 运行时验证**。已补 Pi 扩展接口的离线探针，见 §9；探针不使用真实 LayerFS。

调研基线：

- LayerFS：[`792715f00a2dbfcf0cb8435ae84862cce972dc90`](https://github.com/Ephemeral-AI-Lab/layerfs/tree/792715f00a2dbfcf0cb8435ae84862cce972dc90)，查询时远端 HEAD。以下外部链接固定到这一提交，除明确标成历史材料的链接。
- Epi：`e6e4de8f29d8a66a095e89d3048218d8b98b949a`；实际依赖以 [package.json](../../package.json) 为准。
- 方法：读官方 README、JS SDK、DSH 集成和关键 Rust/JS 源码，对照 Epi Task、worker、Review、Trace 与锁定 Pi 的导出声明。不把官方 benchmark 当成本机测量。
- 未安装 LayerFS、未构建 native addon/daemon、未启动 Docker、未调用真实模型。源码取样保存在临时目录，不是新增运行依赖。

## 1. 结论

**值得融合，优先作为 Task 的可选工作区后端，而不是替换 Epi 的本机文件系统、Git 或 Pi 内核。**

最有价值的组合是：每个写任务有独立 Branch 和 Workspace；操作后保存检查点；任务交回固定版本的变更集；人在现有 `/review` 审查；确认后才合入或导出。`/trace` 关联“哪次工具调用产生了哪个 Commit”。

推荐顺序：

1. 临时项目做不调用模型的技术探针，首先验证取消、清理和文件语义。
2. 显式启用的 LayerFS Task；主会话仍操作本机仓库，默认行为不变。
3. `/review` 增加 LayerFS 来源，`/trace` 增加调用到检查点的关联。
4. 再评估会话级隔离、文件状态回退、从历史检查点尝试另一种方案。

不建议现在做：整个 Epi 迁入容器、全局替换所有文件工具、将真实项目唯一副本放进 LayerFS、自动 publish、自动覆盖本机仓库，或实现通用多后端工作台框架。

这是对 Epi [内核不动、投入扩展和 TUI](../architecture.md) 原则的延伸，不是新的已定产品方向。

## 2. LayerFS 是什么

可以理解为：**面向 agent 的、能分支和保存历史的完整工作目录**。不是普通 Git 包装，也不是一个单纯的容器调度器。[L1][L2]

| 概念 | 实际含义 | 对 Epi 的意义 |
|---|---|---|
| Store | SQLite 中的历史及内容寻址对象；内容复用和去重 | 多个任务不必各复制完整依赖目录 |
| Branch | 一条可写的 Commit 历史 | 每个任务的独立工作线，不等同于 Git branch |
| Commit | 保存的不可变文件系统状态 | 可审查、可比较、可据此 fork |
| Layer / main | 将 Branch 的一个 Commit 发布成主线快照 | 项目内发布点，不是 Git commit 或 git push |
| Workspace | 绑定某一 Branch 快照的临时可写视图，拥有独立 overlay | 命令真正读写的位置 |
| Sandbox | 运行 daemon、承载 Workspace 的容器 | Linux 执行环境；不是“一个任务一个容器” |

两条数据路径：[L2]

- `fs.read/write/edit/apply/...`：SDK 在 Linux 进程内访问 Store；状态变化可直接形成 Commit，不需要挂载 Workspace。
- `workspace.mount/exec/commit/unmount`：挂载 FUSE 视图后运行普通程序，显式 commit，再显式 unmount。

重要区别：**`exec` 不自动 commit；`unmount` 不自动保存。**“每次工具调用一个 checkpoint”是 harness 应实现的策略，不是调用 `exec` 就天然得到的效果。只读调用或没有状态变化的操作也不应被伪造成新 Commit。[L2][L6]

### 2.1 与 Git worktree 的区别

Git worktree 适合并行开发已跟踪源码，继续保留 Git 的审查、提交、发布流程。LayerFS 的额外价值是保存整个工作树，包括依赖和产物，且 fork 复用内容根；首次导入仍须读取源目录，后续挂载按需读取，并非“所有 I/O 都零成本”。[L2][L7][L8]

对 Epi，LayerFS 应先定位成 **Git 之外的任务执行历史**：

- Git：人认可的源码历史与对外交付。
- LayerFS：任务执行期间的完整文件状态与实验分支。
- Pi Session：对话、工具调用和上下文历史。

三者关联，但不能互相冒充。尤其 Pi 的会话 fork 不会自动 fork 文件状态，文件回退也不会撤销网络请求、外部数据库写入或已经发生的对话。

## 3. 已核实的接入限制

### 3.1 macOS 不是原生 Store 路径

当前 SDK 的 Store 操作要求 Linux，且 Store 位于 daemon 共享的本地文件系统，例如 ext4/xfs/btrfs。没有 `storePath` 报 `InvalidInput`，不支持的平台报 `Unsupported`。不能在 macOS 的 Epi Node 进程里简单 import 后直接打开 APFS 上的 Store。[L2]

官方 DSH 集成在 macOS 上增加了一个长期运行的 Linux Store container，Mac 通过本机回环端口上的认证协议调用它；Workspace 则放在另外的 Sandbox 容器中。源码包仍需构建 Linux native addon、daemon 和 runtime image。[L3][L4]

README 的多机器协作愿景也不能理解为当前 SDK 已提供通用远程共享 Store 服务：当前文档要求各调用者直接访问共享的本地 Linux 文件系统。跨主机部署、存储复制和容错不在本次已核实能力之内。[L1][L2]

对 Epi 的建议：

- TUI、Pi Agent Loop、模型认证与会话记录保留在宿主机。
- 只有 LayerFS 数据访问与目标命令执行进入 Linux 环境。
- 把 native、daemon、镜像和 Store 格式作为一组锁定、预检，而非启动时隐式安装。
- 不修改 Manifest v1 来塞运行参数；实验先以 Manifest 声明的外部扩展启用。以后是否新增内置扩展名称，单独设计。

### 3.2 历史保留不等于 crash durability

README 明示只有 Disposable profile，无崩溃/断电持久性保证；SDK 文档为 WAL / `synchronous=OFF`。Init 实现也拒绝非 Disposable 配置。[L1][L2][L7]

所以“Durable Shared History”不能被 Epi 转述成“安全备份”。建议：保留原始 Git 仓库及独立交付物；重要结果及时导出；Store 故障应显式失败，不能退回本机偷偷继续写。

### 3.3 merge 与 publish 完全不同

源码确认：[L8]

- `branch.merge(a, b, name)` 生成新的结果 Branch，不改两个输入；非快进的干净合并可产生双亲 Commit；冲突不创建结果 Branch/Commit。
- `branch.publish(branch, commit?)` 是 **overwrite-only** 地发布成下一层 main，报告被覆盖的历史，不会替调用方自动 merge 最新 main。
- 发布内部有并发校验，但公开参数没有“我审查时的 main 是 X”这一项；不能用它代替 Epi 自己的审查版本约束。

推荐由一个受控发布者完成：固定输入版本、与当前 main 合并、测试并审查结果、确认 main 未变化，再发布。第一阶段不开放自动 publish；更不要把它叫作“应用到本地”。

README 用“同一文件被修改就冲突”解释产品，但实现中存在三方文本行合并，不能把这句简写当完整规则。同文件、不同修改块以及相同修改的行为需要实际探针验证。[L9]

`.lww` 和 merge units 允许特定内容取较新的版本，是策略性舍弃另一方变更，不是普遍正确的自动解冲突。源码使用左侧的 `.lww`；不要默认给源码、锁文件或整个项目加 last-write-wins。[L8][L9]

### 3.4 Pi 工具不是一对一映射

Pi 提供公开的 `ReadOperations`、`WriteOperations`、`EditOperations`、`BashOperations` 等接入点，官方 SSH 示例通过扩展注册同名工具，复用 Pi 工具实现。这说明**不 fork Pi 就有接入路径**。[P1][P2]

但不能直接把方法名连起来：

| Pi 的要求 | LayerFS 当前接口 | 缺口 |
|---|---|---|
| `ReadOperations.readFile` 返回完整 `Buffer`，支持图片等 | `fs.read` 是分页文本，最多 2000 行/48 KiB，巨长行没有行内续读 | 不能拼几个 page 冒充任意文件字节；要有独立二进制读取路径 |
| `edit` 完整 read-modify-write 与批量编辑语义 | `fs.edit` 是单个精确匹配；`fs.apply` 可原子发布一批操作 | 要保留 Pi 的契约，避免 mkdir/write 子步骤变成多次中间提交 |
| `bash` 支持 `onData`、AbortSignal、timeout、env | `workspace.exec` 等命令结束返回，公开参数没有 signal/timeout/env | 实时输出、取消、超时和环境传递需要 executor 方案 |
| 本机绝对路径、`@file`、工具输出 artifact | LayerFS 视图路径和 Sandbox 内路径 | 必须明确路径空间，不能字符串替换后假装本机文件 |

`workspace.exec` 的 Writable sinks 用于有界地读取输出 spool，源码先 await 完整执行结果，再写给 sink；**不是实时 stdout streaming**。[L5][L6]

内部 operator 有 `process.start/list/cancel`，但这是另一套接口；取消实现发 TERM 后有限等待，可能返回 `stopping`。不能宣称使用它就已经等价于 Epi 的 TERM→KILL 回收，也不能以杀掉本机 worker 代替终止 Docker 内命令。[L6]

### 3.5 完整快照有成本和安全风险

Init 不遵循 `.gitignore`，导入完整受支持目录；这对依赖复用有利，也会包含 `.env`、项目配置、缓存和不应长期留存的内容。[L7]

建议：

- 导入前明确源范围并检查敏感文件；第一版仅支持临时、无密钥项目。
- 宿主机 `~/.epi/pi` 的认证与 session、Task capsule、bridge 密钥、trace/artifact 不进入项目快照。
- 不把宿主机 `node_modules` 当跨平台依赖：darwin native addon 不能直接在 Linux 运行。应在目标 Linux 镜像中安装一次依赖，再保存基线。
- Git worktree 的 `.git` 可能只是指向宿主机目录的文本文件；软链接、pnpm store、绝对路径也可能出视图。需要单独验证，不能默认完整复制就可运行。
- 当前公共接口没有通用 project/branch 删除或 GC；Store 正常操作只增长。配额、保留期和整个实验项目的清理必须另定。[L2][L10]

### 3.6 文件隔离不等于不可信代码安全隔离

当前调度会把同一项目、同一镜像的 Workspace 放进已有 Sandbox，最多 16 个；多个任务可能共享一个容器。[L2][L6]

DSH 的 macOS Store bridge 还挂载 Docker socket 和 Docker volumes 目录，是高权限控制路径。其“每个连接携带密钥”不等于完整的多租户授权。[L4]

因此首版只承诺“合作式任务文件状态隔离”，不承诺对恶意任务的沙箱隔离。项目信任、文件版本隔离、容器/网络权限是三件事；Epi 的 `.epi` trust gating 不应被 LayerFS 的存在取代。

## 4. 与当前 Epi 的具体结合点

### 4.1 Task：最自然的第一处 seam

[src/task-runtime.ts](../../src/task-runtime.ts) 的 `TaskRuntime.start()` 校验并保存 cwd，`run()` 使用它启动独立 Node worker；它不创建 Git worktree、容器或独立文件系统。两个 worker 使用同一 cwd 时仍会改同一批文件。

[src/worker.ts](../../src/worker.ts) 创建独立 in-memory Pi Session；capsule 只有任务、cwd、模型、工具等信息；扩展也只装配限定的工厂，不自动继承父会话扩展。

因此不能只在父会话安装 LayerFS 扩展便声称 Task 获得隔离。需要显式传递、验证和装配任务的工作区绑定。

建议先以一个具体的任务工作区模块承接差异，而非通用虚拟文件系统框架：

- 输入：已授权项目、固定基线引用、job id、目标镜像。
- 输出：任务专属 Branch、Workspace 句柄、工具执行入口、最终变更集引用。
- 内部负责：准备、检查点、失败保留、命令停止、卸载、清理与结构化错误。
- 两个实际 adapter：当前 local 行为与可选 LayerFS 行为；仅在第二条路径确实落地时提取 interface。

“逻辑项目路径”和“宿主机真实 cwd”分开；`/workspaces/1` 是容器路径，不能直接塞给现有宿主机 `spawn({ cwd })`。

任务结果建议关联 `projectId / branch / baseRef / headRef / imageDigest / changeSet`。具体字段、状态与 capsule 版本是后续设计，不是现有 schema。

### 4.2 第一版保持一个 Task 一个 Workspace

建议首版所有项目文件工具与 shell 都访问同一个挂载视图，在成功的写/edit/bash 操作后显式 checkpoint；操作序列按 Workspace 串行化。

理由：挂载固定了某个快照。若一边直接 `fs.write(branch)` 推进 head，一边继续让旧挂载运行命令，容易出现“刚写了文件，bash 却看不到”的状态分裂。直接 Store 路径虽更高效，但需要 remount/刷新与失败恢复协议，晚一点做。[L2][L6]

只读的历史审查可以按固定 Commit 从 Store 读取，与执行视图区分。

策略须提前定清：非零退出可能已经修改文件；取消可能留下半完成产物。不能把“进程失败”当作“没有文件变更”。建议失败保留到未接受的任务分支或标为 pending 的 overlay，绝不自动合入；遇到 Unknown 先核实结果，不自动重放变更。

### 4.3 `/review`：增加来源，不重造审查界面

[src/extensions/preview/ledger.ts](../../src/extensions/preview/ledger.ts) 目前只观察 `edit` 和 `write`，在内存里保留变更前文本；不会完整归因 bash、worker 或外部程序的改动。

[src/extensions/preview/source.ts](../../src/extensions/preview/source.ts) 已区分三个来源：会话变更账、Index→Working Tree、HEAD→Index，并产出 `ReviewFile`。

接入建议：新增明确的 LayerFS 比较来源，输入固定的 `baseRef/headRef`，分页加载 `diff_commits` 和必要内容，复用多文件 diff、批注与草稿回传。不能将远端变更伪装成宿主机 working tree；现有同步磁盘加载也要改成适合异步分页的加载流程。

批注除路径、old/new hash 外，还绑定 project 与固定 ref。用户审查后 head 变化，就要求刷新/重审，不能将“同一路径”当成“同一版本”。

二进制和超限文本如无可靠读取路径应显示“暂不支持/未完整加载”，不能显示为空文件。

### 4.4 `/trace`：保存调用与 Commit 的关联

[src/extensions/trace/record.ts](../../src/extensions/trace/record.ts) 记录当前 session 的工具执行观测，历史展示由 [project.ts](../../src/extensions/trace/project.ts) 投影会话记录。它现在不是 LayerFS 历史浏览器。

可通过 Pi `appendEntry()` 保存扩展自有记录，不改 Session JSONL 格式。[P3] 建议记录：session/job/toolCallId、project/branch、基线与结果 Commit、操作结果、exec/commit 各自耗时。

LayerFS trace 能提供 SDK 调用时间和 Commit id，DSH 就在 harness 侧将其关联到 agent/call。agent 归因不属于 Store 的公共写接口。[L2][L3]

注意 SDK trace 写失败会被丢弃，因此它只能做诊断来源，不能成为 Epi 接受变更、恢复任务的唯一账本。关键状态由工具执行结果与 Epi 自己的任务记录保存。[L2]

### 4.5 会话生命周期：晚于 Task

`/new`、`/resume`、fork、`/reload` 和退出都涉及资源重建。[src/tui/services.ts](../../src/tui/services.ts) 与 [development.md](../development.md) 已有统一启动和资源隔离约束。

后续会话级集成至少要定义：

- 保存的 binding 属于哪个会话分支，而不是整个 session 文件内所有 entry。
- 恢复会话时只重新验证 binding；不重新 Init、覆盖 Store。
- 会话 fork 默认继续同一文件分支还是从某个检查点新 fork，必须显式。
- shutdown 先停止命令，再 checkpoint/保留失败状态，最后卸载；Busy/Dirty 不能被吞掉。
- Store 或 daemon 丢失时显示原始失败，不伪造恢复成功、不退回宿主机执行。

## 5. 官方 DSH 集成：借鉴机制，不直接搬产品

DSH 的做法并不是透明替换所有文件工具。它的 minimalist preset **只有 bash 等能力，没有 read/write/edit**；agent 通过短 Node 脚本调用 SDK，Host 注入部署信息并收集 trace，再绘制 Work/History。[L3]

可借鉴：

1. Linux 数据访问和 macOS 控制界面分开。
2. SDK 操作与 agent/tool call 的关联放在 harness。
3. 查看历史时直接读 Store，不为读一页文件启动执行 Sandbox。
4. 项目绑定和首次导入显式化。

不宜照搬：

- DSH/Cordis preset、Web UI 与环境变量体系。
- 让用户为了试 LayerFS 放弃 Epi 熟悉的文件工具。
- simulator 的成功作为真实 FUSE/native 的正确性证据。
- 高权限 Docker bridge 的原样复制。
- 文档中的 Busy 重试规则推广成对任何失败自动重试。

一个独立、显式的 SDK 脚本实验可以快速验证概念，但它只能叫“LayerFS 实验工具”，不能叫“Epi 文件操作已全面隔离”。

## 6. 分阶段验证建议

以下是建议，尚未获得实现授权。

### P0：不调用模型的技术探针

使用临时源项目、临时 HOME/EPI_HOME、独立 LayerFS home/volume，不碰真实仓库和凭证。

必须验证：

1. Init → fork 两个 Branch → 各自写入 → mount → 执行测试 → commit → unmount；原目录不变。
2. 不同文件合并、同文件不同修改块、同一修改块冲突；publish 不等于 merge。
3. 脏目录卸载拒绝、冲突 overlay 保留、Busy 不能靠 discard 绕过。
4. `sleep`、子进程、后台进程、忽略 TERM 的程序：取消后执行确实停止，不能只让 Promise 结束。
5. stdout/stderr 大输出、有界 artifact、实时输出可行性、timeout/env/退出码。
6. 二进制读取、图片、巨长行、CRLF、多段 edit、symlink/hardlink、删除和重命名。
7. SDK 写入与挂载视图的一致性，checkpoint 后的可见性。
8. 停掉 daemon/Store container、中断客户端；错误可见、无自动重放、能确认残留资源。

**停止条件：**如果无法满足 Epi 对取消和回收的承诺，先保留为外部实验，不接入正式 `task_cancel`。

### P1：可选 Task 后端

- 主会话保持本机，选定写任务进入 LayerFS。
- 一个任务一个 Branch/Workspace；worker 明确装配相应工具，不自动继承父扩展。
- 任务完成只交回固定 change set，不 publish、不覆盖用户工作区。
- 实验依赖缺失时启动/任务准备显式报错；不静默降级。
- 复用 Pi 工具 factories 的前提是 operations 契约完整；不完整时保留独立命名工具并说明差异。

范围外路径如 Skills、`@file`、bash artifact 的读取，以及 `!cmd`、MCP、hooks、第三方扩展的文件副作用，都要列入允许/阻止/未覆盖矩阵。仅覆盖四个工具不等于覆盖所有文件访问。

### P2：审查与安全导出

- `/review` 添加 LayerFS 变更来源；`/trace` 关联检查点。
- 导出与 LayerFS publish 分开。先只支持“导出到新的临时目录/交付物”，再设计应用到原仓库。
- 应用时比较三份状态：导入基线、任务结果、当前本机文件；本机存在变化就拒绝覆盖或显式三方处理。
- 必须处理 binary、权限位、symlink、删除、重命名及路径越界；只做文本补丁时应明确限制。
- 不导出 `.git` 元数据、密钥、控制配置和 Linux `node_modules` 覆盖宿主机。源码交付与执行环境快照采用不同范围。

### P3：会话级检查点与实验分支

P1/P2 稳定后再设计“从某步文件状态开新任务”“接受/拒绝一组变更”。明确这是文件状态操作，不是整个世界回滚；不改 Pi 的会话格式或 Agent Loop。

### 性能与发布门禁

官方报告既有快于对照的案例，也有顺序写/随机写等慢于对照的案例，而且每项只跑一次，不能推导出 Epi 会整体变快。[L1]

比较相同目标 Linux 环境下的 local/worktree 与 LayerFS，分别记录：首次导入/依赖安装、冷/热挂载、典型读写编辑、测试总时长、checkpoint 延迟、并行任务时长、物理 Store 增量、取消完成时间、残留进程和 Workspace 数。运行 SDK 本身的比较不要混入模型耗时。

Epi 原有离线测试继续不依赖 Docker；真实 LayerFS 验证做显式 opt-in 的独立套件。工具/prompt 发生变化时检查 model-snapshot；具体代码按现有开发流程设计确认、审查后再合入。

## 7. 当前建议用户决定的三个问题

1. **首个目标是否只做“隔离写任务 + 审查交回”？** 推荐是，比全会话回滚小，也最贴合已有 Task/Review。
2. **是否接受实验需要 Docker/Linux，且不能充当唯一数据副本？** 如果不接受，就先只吸收检查点/变更集设计，不引入 LayerFS runtime。
3. **是否保留 Git 为最终交付历史？** 推荐保留；LayerFS 是任务执行历史，不替代 Git。

## 8. 来源

LayerFS：

- [L1：README，平台、状态、实现概览与 benchmark 限定](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/README.md)
- [L2：JS SDK 指南，实际公开方法、平台、分页、部署、trace、格式限制](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/sdk/js/README.md)
- [L3：DSH 集成指南，安装、macOS/Linux 路径、preset、会话归因](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/dsh/README.md)
- [L4：macOS Store container 的 mounts、部署和认证](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/dsh/packages/host/src/box.js)，[worker：连接中断不停止在途调用](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/dsh/packages/host/src/port/worker.mjs)
- [L5：workspace.exec JS，先等待执行结果再读取输出](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/sdk/js/src/workspace/exec.js)
- [L6：native exec 与后台进程取消](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/sdk/js/native/src/exec.rs)，[Workspace 放置、commit、unmount](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/sdk/js/native/src/workspace.rs)
- [L7：Init 导入范围和 Disposable 限制](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/core/crates/layerfs-api/src/project/init.rs)
- [L8：Branch fork/merge/publish 实现](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/core/crates/layerfs-store-service/src/history/branch.rs)
- [L9：三方文本合并](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/core/crates/layerfs-content/src/merge/text.rs)
- [L10：概念文档，append-only 内容模型](https://github.com/Ephemeral-AI-Lab/layerfs/blob/792715f00a2dbfcf0cb8435ae84862cce972dc90/docs/general/concepts.md)

Pi（以本仓库锁定依赖的文件为核验依据；下面相对链接指向本地安装内容）：

- [P1：公开导出](../../node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts)，[ReadOperations](../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.d.ts)，[BashOperations](../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.d.ts)
- [P2：官方 SSH 工具代理示例](../../node_modules/@earendil-works/pi-coding-agent/examples/extensions/ssh.ts)
- [P3：扩展生命周期、事件、appendEntry 与工具契约](../../node_modules/@earendil-works/pi-coding-agent/docs/extensions.md)，[SDK](../../node_modules/@earendil-works/pi-coding-agent/docs/sdk.md)

文档漂移提醒：当前 LayerFS README 宣布首个正式源码发布，但 roadmap 页面仍称没有 release candidate；SDK README 链接的旧 SDK-STANDARD 还保留 `sandbox.*` 旧接口。因此本调研以当前 JS wrapper、native 和当前集成实现为准，历史提案不当作已实现契约。正式接入必须固定一组源码/构建产物，而不是只信“1.0”标签。

## 9. 后续实测：独立 Pi extension 是否可行

用户提出先写 probe。已增加 [探针说明](../../scripts/probes/layerfs-extension/README.md)、[扩展](../../scripts/probes/layerfs-extension/extension.mjs) 和 [运行脚本](../../scripts/probes/layerfs-extension/run.mjs)：

```bash
node scripts/probes/layerfs-extension/run.mjs
```

真实 Pi SDK + 脚本化 faux provider + 内存工作区，12 项断言组通过。证明扩展可覆盖基础工具、保留批量 edit、路由 user_bash、传递取消信号、接收输出更新，并以 custom entry 保存调用与 checkpoint 的关联；不需要改 Pi 内核。没有启动真实模型或 Docker，没有调用 LayerFS。

也实测到三个设计边界：

1. 新建 Session 不继承父 Session 的扩展，Epi Task worker 仍需显式装配；本次并未端到端执行 Epi worker。
2. 会话分支导航不会回退工作区，文件历史必须自行绑定和恢复。
3. checkpoint 失败后文件变化仍在；继续执行后，下一次 checkpoint 会包含前一次未保存改动。简单地只记最后一次 toolCallId 会归因错误。正式扩展需要待恢复状态或 pending 修改来源账，不能照搬最简探针。

建议将单会话工作区能力做成独立 Pi extension；与 Epi Task、Review、Trace 的深度融合另做窄接入点。第一版不新增另一套任务调度器，也不复制 Epi 的审查界面；可先用 `/layerfs` 独立命令展示状态。真实 LayerFS 的取消、输出与二进制访问仍是下一轮 probe 的门槛。
