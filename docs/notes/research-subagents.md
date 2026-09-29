# Pi coding agent 的子代理 / 多代理扩展调研

调研对象是 "Pi" 这个命令行编程代理（coding agent）。它的 npm 包名是 `@earendil-works/pi-coding-agent`。它原来的仓库是 `badlogic/pi-mono`，现在改名迁移到了 `earendil-works/pi`（旧地址会自动跳转到新地址，我用 GitHub API 验证过跳转）。https://github.com/earendil-works/pi

仓库当前有 104,771 个星标、13,150 次 fork，最近一次推送在 2026-09-13。这个数字远超一般小众工具，说明它在最近一年内迅速走红。https://api.github.com/repos/earendil-works/pi

Pi 支持"扩展"（extension），也就是用 TypeScript 写的插件，可以注册新工具、加斜杠命令、拦截事件。子代理（subagent）功能都是以扩展的形式实现的，不是 Pi 内核自带的。

## 一、官方自带示例：subagent 扩展

Pi 仓库自己在 `packages/coding-agent/examples/extensions/subagent/` 下带了一个示例扩展，专门做子代理委派。 https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts

- 代理定义：代理（agent）是一段配置，包含名字、来源（用户级或项目级）、系统提示词、可选的 model、可选的 tools 列表。不写 model/tools 就继承父代理的设置。
- 代理存放位置：用户级放在 `~/.pi/agent/agents`，项目级放在项目内的配置目录下的 `agents`。默认只加载用户级代理，要加载项目级代理需要显式传 `agentScope: "both"`（或 `"project"`），而且只应对可信仓库这样做。
- 执行模型：不是在同一个进程里跑一个 AgentSession（AgentSession 是 Pi 内部管理一次对话状态的对象），而是每次调用都新开一个独立的 `pi` 命令行子进程，用 `--mode json` 参数让子进程以结构化 JSON 输出，这样能拿到逐条事件。
- 三种执行方式：单个（`agent` + `task`）、并行（`tasks` 数组，最多 8 个任务，同时并发数上限 4）、链式（`chain` 数组，用 `{previous}` 占位符把上一步的输出接到下一步的任务描述里）。
- 结果返回：子进程按行输出 JSON 事件，父进程逐行解析，把 `message_end` 事件里的消息、token 用量、花费、退出码、stderr 汇总起来返回给父代理。
- 已知限制：并行最多 8 个任务；单个任务在并行模式下的输出会被截断到大约 50KB；项目级代理默认需要在界面上确认，除非项目已被标记为可信。

## 二、社区扩展

以下都是第三方作者发布的独立 npm/git 包，不是官方仓库自带的。

### tintinweb/pi-subagents（目前找到的最完整、星标最高的社区实现）

仓库 https://github.com/tintinweb/pi-subagents ，1146 个星标，最近推送 2026-09-03。描述里直接写"Claude Code like Sub-Agents"，也就是说作者本身就是照着 Claude Code 的 Agent 工具做的。

- 安装：`pi install npm:@tintinweb/pi-subagents`，要求 Pi 0.84.0 以上。
- 代理定义：Markdown 文件加 YAML frontmatter（文件开头用 `---` 包起来的一段配置）。自带三种内置类型：general-purpose（全部工具，继承父系统提示词）、Explore（只读工具，用来快速探索代码库）、Plan（只读，用来做架构规划）。自定义代理可以放在项目级 `.pi/agents/`、共享工作区 `.agents/agents/`、或全局 `~/.pi/agent/agents/`，项目级优先级最高。每个代理文件可以指定工具、模型、思考强度、最大轮数、系统提示词、记忆范围、隔离模式、要预加载的技能、是否允许嵌套子代理。
- 执行模型：每个子代理跑在独立的 pi 会话（session）里，不是同一进程内的对象。后台模式是默认行为，调用后立刻返回一个 ID，前台模式需要显式传 `run_in_background: false`。后台并发默认上限 10。既支持并行也支持串行，还提供一个叫 `SubagentWorkflow` 的工具，可以写一段确定性的 JavaScript 脚本，用 `agent()`、`parallel()`、`pipeline()`、`phase()` 这些函数编排很多子代理；脚本跑在 `node:vm` 沙箱里，`eval`、`Date.now()`、`Math.random()` 被禁用。
- 支持"中途引导"（mid-run steering）：用 `steer_subagent` 往正在跑的子代理里插消息，等它跑完当前工具调用后就会转向新的指示。
- 结果返回：后台代理跑完后发一条带预览的完成通知，父代理用 `get_subagent_result` 拿完整结果或者阻塞等待。结果会以 JSON Lines 的形式持久化到系统临时目录（权限 0700，只有所有者能读），可以按 session ID 恢复。
- 界面显示：有一个叫 FleetView 的界面，模仿 Claude Code 的风格，在编辑器下方列出正在跑的代理，可以用方向键导航、回车进入某个代理的对话、Esc 退出。编辑器上方还有个常驻小部件显示后台代理状态。也支持用 `@某代理名 消息` 的方式直接给某个代理发消息。
- 支持嵌套子代理，但要在自定义代理配置里显式打开 `allowed_subagents`，且嵌套深度上限是 2。
- 支持"worktree 隔离"（worktree 是 git 的一个功能，可以让同一个仓库同时检出到多个独立目录）：传 `isolation: "worktree"` 后子代理会在独立的 git worktree 里跑，改动提交到一个新分支，跑完自动清理 worktree。
- 已知限制：子代理看不到父代理里还没提交的改动（因为 worktree 只是一个副本）；嵌套的子代理在顶层界面里是隐藏的；一次 workflow 运行最多 1000 个代理，`parallel`/`pipeline` 单次调用最多 4096 项。

HerbertGao 维护的聚合扩展包 `@herbertgao/pi-extensions`（见下文）里打包的子代理能力，就是直接复用这个 tintinweb/pi-subagents 上游包，改名叫 `@herbertgao/pi-subagents`。https://github.com/HerbertGao/pi-extensions

### mjakl/pi-subagent（及其 fork gee666/pi-subagent）

仓库 https://github.com/mjakl/pi-subagent ，77 个星标，最近推送 2026-09-08。gee666/pi-subagent 是它的一个 fork，3 个星标，内容基本相同，未见明显独立改动，视为同一实现的分支版本。

- 安装：三种方式，`pi install npm:@mjakl/pi-subagent`（推荐）、`pi install git:github.com/mjakl/pi-subagent`、或者手动克隆到 `~/.pi/agent/extensions` 再 `npm install`。要求 Pi 0.80.5 以上。
- 代理定义：也是 YAML frontmatter 加 Markdown，放在用户级 `~/.pi/agent/agents/*.md` 或项目级 `.pi/agents/*.md`（项目级优先）。可配置字段包括 name、description（必填）、model、thinking（思考强度）、tools（逗号分隔的工具白名单）、inactivityTimeout（多久没有 RPC 活动就终止）、sessionPreference（`ephemeral` 一次性、`persistent` 持久、`either` 都行）。如果一个代理都没配置，扩展会自动生成一个只读的 `explore` 示例代理。
- 执行模型：每个子代理是独立的 `pi` 进程，用无头 RPC 模式（RPC 是"远程过程调用"，这里指子进程通过标准输入输出接收指令、返回结果，不带交互界面）逐字传递提示词，设置 `PI_OFFLINE=1` 降低延迟，继承父进程的扩展、思考默认值和信任设置。一次工具调用支持 1 到 8 个并发子代理。
- 结果返回：父代理拿到的是"简明文字摘要"，界面上会展示流式进度、可展开的工具调用细节、用量统计、Markdown 渲染的最终输出、完成/失败状态标记。返回给模型的文本上限 50KB 或 2000 行，超出部分写入临时文件但仍在界面里可查看。
- 限制/保护机制：默认最大递归深度 3（防止子代理无限委派子代理）；默认开启循环检测，防止自我递归；持久化的命名会话一次只能跑一个调用（用会话锁）；`inactivityTimeout` 只看 RPC 标准输出，标准错误不会重置计时器。

### harms-haus/pi-subagents

仓库 https://github.com/harms-haus/pi-subagents ，0 个星标，最近推送 2026-07-11，星标数低说明关注度小，功能仍值得记录。

- 安装：`pi install git:github.com/harms-haus/pi-subagents`，或者本地开发用 `pi install . -l`。
- 通过一个叫 `delegate_to_subagents` 的工具发起委派，传一个任务数组，每个任务有 name、prompt、可选 profile（配置档）。默认最多同时跑 4 个子代理。
- 执行模型：每个子代理也是独立的 `pi` 进程，用 JSON 模式输出，父进程按行解析 JSONL 事件实时更新界面。界面上是"滚动窗口"，每个子代理默认显示最近 15 行输出，可以按 Ctrl+O 展开看全部。
- 结果返回：`delegate_to_subagents` 先返回 session ID，之后用 `get_subagent_output(sessionId)` 拿"最后一条助手文本输出"，或者用 `get_subagent_session(sessionId)` 拿完整对话记录用于调试。会话记录会立刻写入父代理的日志，重启后也能看到。
- 限制：并发上限 4；只有跑完或报错的会话才能被恢复；循环检测只看最近 N 次连续工具调用（默认 5 次）。

### KristjanPikhof/Pi-Agents-Team

仓库 https://github.com/KristjanPikhof/Pi-Agents-Team ，15 个星标，最近推送 2026-08-05。

- 安装：`pi install npm:pi-agents-team`，要求 Pi >= 0.80.6、Node >= 22.19.0、Git。开发模式可以 `pi -e ./extensions/index.ts` 本地加载。
- 代理定义：配置写在 `~/.pi/agent/agents-team.json`（全局）或项目内对应文件里。自带七种内置角色：explorer（探索者）、fixer（修复者）、reviewer（审阅者）、librarian（资料员）、observer（观察者）、oracle（问答顾问）、designer（设计者）。每个角色可配置提示词（文件路径或直接写文字）和 thinkingLevel（思考强度：low/medium/high/max）。可以用 `/team-init` 命令生成新角色的脚手架。
- 执行模型：委派时会启动独立的后台 RPC 工作进程，命令是 `pi --mode rpc --no-session`，把角色提示词和任务要求一起喂给这个工作进程，多个工作进程并行跑。主控代理用一个不消耗 token 的 `wait_for_agents` 调用来等结果，据称这个等待可以在子代理提出问题时提前被唤醒。
- 结果返回：工作进程把最终交付内容包在 `<final_answer>…</final_answer>` 标签里，主控代理只收到"简明摘要加一个 final_answer 块"，不会拿到完整对话记录。有专门的 `agent_result` 工具来取这个权威结果。
- 界面显示：`/team` 命令打开一个仪表盘，有 Workers（工作进程）、Inspect（检查）、Console（控制台）、Cost（花费）几个标签页，可以看成本、token、活跃工作进程数量。Console 里用类似 `╭─ tool bash [ok]` 的彩色分块展示活动，Raw 模式展示未格式化的原始事件方便调试。
- 限制：会话文件是只追加写入的，到 1 万条记录或 64MiB 就会提示用户开新会话；项目级配置需要项目先被标记为可信才能生效；如果父代理上下文使用率超过 80% 或剩余 token 少于等于 32768，就不能复用已有的工作进程。

### nicobailon/pi-messenger（不完全是"子代理委派"，而是多代理协作）

仓库 https://github.com/nicobailon/pi-messenger ，708 个星标，最近推送 2026-08-27。这个星标数说明它在社区里有一定影响力，但它的模型跟前面几个不太一样，值得单独说明。

- 它解决的问题：让开着多个终端窗口、各自运行独立 Pi 会话的多个代理，通过一个共享文件夹协调工作，不需要中心服务器或后台常驻进程。
- 主要能力：代理之间互相能看到对方在线状态（带主题名字和状态指示）；文件预定机制防止两个代理同时改同一个文件；活动信息流记录编辑、提交、测试等事件；一个叫 "Crew" 的任务编排系统，把需求拆成依赖关系图，按"波次"并行执行；还有一层团队功能负责角色分工、审批关卡和长期记忆。
- 安装：`pi install npm:pi-messenger`。卸载用 `npx pi-messenger --remove`。
- 执行模型：与前面几个不同，它不是"父代理直接管理子代理"的层级模型，而是把工作组织成任务依赖图——一个规划者把需求拆成任务，审阅者验证实现，多个并行工作进程认领已就绪的任务。代理之间的状态存在共享文件系统里（用户级在 `~/.pi/agent/messenger/`，项目级在 `.pi/messenger/`）。工作进程本身也是独立的 `pi --mode json` 子进程，各自有自己的 LLM 会话，从而实现真正的并行。Crew 的进度通过 JSONL 流式写入，驱动一个实时的可视化叠加层。
- 代理间通信：直接消息会通过 `pi.sendMessage()` 立刻唤醒目标代理；也支持广播给多个代理；文件预定在工具层面强制生效，阻止冲突操作。有一个 `/messenger` 叠加界面，可以用 `@名字` 直接发消息，用 `@all` 广播。
- 限制：Crew 并行工作进程多了会很快消耗 token，文档建议先用便宜的模型试；依赖共享文件系统，团队分布在不同机器且没有共享存储的话用不了；没有服务器模式，不适合纯云端部署；Crew 并发上限 10 个工作进程。

### nicobailon/pi-intercom（未深入验证）

仓库 https://github.com/nicobailon/pi-intercom ，511 个星标，最近推送 2026-09-02，描述是"会话间通信扩展"。我只看到了搜索摘要，没有单独抓取它的 README 原文核实细节，具体的代理定义方式和执行模型标记为 未验证。

### baryonlabs/pi-agent-harness（关注度较低）

仓库 https://github.com/baryonlabs/pi-agent-harness ，8 个星标，是一个 fork（不是独立原创仓库），最近推送 2026-07-01。描述称它能把"一句话描述的领域需求"转成一整套专家代理（放在 `.pi/agents`）、配套技能（`.pi/skills`）和编排提示词（`.pi/prompts`），并且内置了一个支持单个/并行/链式三种模式的子代理委派工具，跟官方示例里的三种模式描述一致。由于星标很低、是 fork 而非原创，具体实现细节我没有再深入抓取，只记录仓库描述本身，标记为 未验证（除仓库元数据外的内容）。

## 三、聚合与索引仓库

- HerbertGao/pi-extensions（https://github.com/HerbertGao/pi-extensions ，0 星标，最近推送 2026-09-12）是一个"聚合包"，把多个第三方扩展打包到一起用一次 `pi install npm:@herbertgao/pi-extensions` 安装。其中子代理能力来自上面提到的 `tintinweb/pi-subagents`，改名重新发布为 `@herbertgao/pi-subagents`。仓库里还有个每日运行的"上游监控"工作流，检查上游 npm 发布和源码提交，自动开一个滚动提醒 issue 保持同步。
- 还发现了几个"awesome 列表"（社区整理的资源导航仓库），包括 Traveler0014/awesome-pi-agent、BubblePtr/awesome-pi、qualisero/awesome-pi-agent，这几个我只看到了搜索摘要，没有逐个抓取核实里面收录的具体扩展条目，标记为 未验证，仅记录其存在以便后续深挖。

## 四、总体观察

- 目前找到的所有子代理类扩展，不管是官方示例还是社区实现，执行模型都是"父进程再开一个独立的 `pi` 命令行子进程"，没有找到真正意义上"同进程内 AgentSession 对象直接被复用"的实现。这大概是因为 Pi 本身的 AgentSession 设计就是和一次 CLI 调用绑定的，开子进程是最简单能拿到完全隔离上下文的办法。
- 代理定义方式两大流派：一种是纯 JSON/配置文件（官方示例、KristjanPikhof/Pi-Agents-Team），一种是 Markdown 加 YAML frontmatter（tintinweb/pi-subagents、mjakl/pi-subagent），后者明显是照抄 Claude Code 的 agent 定义习惯。
- tintinweb/pi-subagents 是目前功能最贴近 Claude Code 的 Agent 工具的实现：同名概念很多，比如 FleetView、worktree 隔离、后台/前台执行、嵌套深度限制，用词几乎和 Claude Code 一致，作者应该是直接参照 Claude Code 做的移植。
- 星标数按高低排：earendil-works/pi 本体 104,771，tintinweb/pi-subagents 1146，nicobailon/pi-messenger 708，nicobailon/pi-intercom 511，mjakl/pi-subagent 77，KristjanPikhof/Pi-Agents-Team 15，baryonlabs/pi-agent-harness 8，gee666/pi-subagent（fork）3，harms-haus/pi-subagents 与 HerbertGao/pi-extensions 均为 0。
