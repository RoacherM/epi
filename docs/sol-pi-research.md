# SoL-Pi 调研与 MMP 借鉴方案

日期：2026-09-14。调研对象：NVlabs/SoL-Pi，commit d7ecfc0（2026-09-11）。
下文引用的源码路径都相对于 SoL-Pi 仓库根目录；Pi 源码路径相对于 npm 包 `@earendil-works/pi-coding-agent` 解包后的目录。

## 1. SoL-Pi 是什么

SoL-Pi 是 NVIDIA 发布的一个独立 Pi 扩展（MIT 协议），不修改 Pi 本体，通过 Pi 的扩展 API 挂进去。
它把四个机制打包在一个扩展里，四个机制默认全部关闭，靠一个配置文件 `sol-pi.json` 逐个开启。
来源：README.md；docs/configuration.md；src/sol-pi/config.ts（`DEFAULT_CONFIG` 四项全 false）。

配置文件查找顺序：先看 `<cwd>/<CONFIG_DIR_NAME>/sol-pi.json`（仅在 `ctx.isProjectTrusted()` 为真时），再看 `<getAgentDir()>/sol-pi.json`。
项目文件整体替换全局文件，不做合并。未知字段直接报错。
来源：src/sol-pi/config.ts。

SoL-Pi 声明的兼容版本是 Pi 0.84.2（devDependencies 固定），并宣称对 0.81.1 做过类型检查。
来源：package.json；docs/compatibility.md。

作者称四个机制是从 152 个候选想法里筛出的 4 个幸存者，用了 535 个训练环境做筛选。
基准数据：EdgeBench 上少用 45% 到 49% 的 token，成本降约 33%，得分保住约 94%；只开 ObservationPack 时成本降 23.6%；Terminal-Bench 4 上 SoL-Pi 15/63 花 211 美元，原版 Pi 18/63 花 286 美元。
来源：https://nvlabs.github.io/SoL-Pi/ ；https://alphasignal.ai/news/nvidia-s-sol-pi-slashes-coding-agent-token-use-by-49 （二手报道，数字与官方页一致）。
注意：Terminal-Bench 上 SoL-Pi 分数是下降的，省钱不是白来的。

## 2. 四个机制分别做什么

### 2.1 Online Context Compact（在线上下文压缩，下称 OCC）

OCC 注册一个 `update_plan` 工具，要求模型每次调用都传完整计划。
每个步骤是 `{id, goal, status}`，status 取 pending、in_progress、completed 之一，可附带 progress（files_changed、verification、decisions）。
来源：src/sol-pi/extensions/online-context-compact/tools.ts；plan.ts。

流程如下：

```
模型调用 update_plan，某步骤第一次变成 completed
        │  记为一个"边界"
        ▼
turn_end 事件 → decideCompaction() 算经济性
        │
        ├─ 不划算 → 记 deferred_economic，继续跑
        │
        └─ 划算或触及窗口保护线
                ▼
           context.abort() 中断当前轮
                ▼
           等 agent_settled
                ▼
           context.compact({customInstructions})   ← 调的是 Pi 原生压缩
                ▼
           pi.sendMessage(隐藏提醒, {triggerTurn:true}) → 模型重建计划、继续干活
```

来源：src/sol-pi/extensions/online-context-compact/extension.ts；economics.ts。

一个常见误解要更正：OCC 并不是"每标记完一个节点就压缩"。
它在每个边界上做一次收支计算，只有预计能回本才压。
计算方式（economics.ts）：
写入代价 writeTokens 等于当前上下文大小；可归档量 archiveTokens 等于上下文减去系统提示词再减去保留的最近 20,000 token；压缩后备忘录按 1,000 token 计；节省量等于归档量减备忘录。
回本请求数 breakeven 等于 writeTokens 乘 (cacheWriteReadRatio 减 1) 再除以节省量。
预期剩余请求数 horizon 等于历史上每个边界的平均请求数乘剩余边界数。
第一次压缩允许 horizon 放大 2 倍；之后的压缩要求 1.5 倍余量，并且要先还清前一次压缩欠下的"债"。
另外有窗口保护：上下文到达 窗口减 16,384 时直接压，不再算账。
还会先调 Pi 的 `findCutPoint` 确认原生压缩真的能切。
cacheWriteReadRatio 默认 12.5，对应 Anthropic 缓存写 1.25 倍、读 0.1 倍的价格比。
来源：economics.ts；config.ts。

状态用 `pi.appendEntry("sol-pi-online-context-state-v1", ...)` 存进会话文件，重开会话能恢复。
用户用 steer 插话，或消息以 `CORRECTION:` 开头，会重置状态。
压缩进行中会取消 `session_before_tree` 事件。
来源：state.ts；extension.ts。

用户体验里那个"高侵入性"提示来自 `showSolPiSavings`：只在 `ctx.mode === "tui"` 时调 `ctx.ui.notify` 加 `ctx.ui.setStatus("sol-pi-savings", ...)` 显示 4 秒；工具卡片上加一行 "⚡ SoL-Pi · <机制> / Money saved · <金额>"。
来源：src/sol-pi/tui.ts。

### 2.2 Action Fusion（动作融合）

用 Pi 导出的 `createEditToolDefinition` 和 `createWriteToolDefinition` 重新注册内置 edit 和 write 工具，加一个可选参数 `then_run {command, timeout}`。
写完文件后，先按文件路径排队，再用 sha256 确认文件在写入后没被别人改过，然后用 `createBashToolDefinition` 跑命令，把结果并进同一条工具结果里。
结果带 `[then_run:succeeded|failed|skipped]` 标记。
省下的是"写文件、再单独发一轮 bash"这一整个来回。
来源：src/sol-pi/extensions/action-fusion/index.ts；then-run.ts。

### 2.3 ObservationPack（观测打包）

只在 `context` 事件里改"发给模型的那份投影"，会话历史文件一个字不动。
命中条件：纯文本工具结果大于 10 KiB。
前 2 次模型请求原样发送（FULL_SENDS），之后替换成一个占位符，带 512 字节头加 512 字节尾的摘录。
原文归档到 `<sessionDir>/sol-pi/<sessionId>/observation-pack/objects/obs_<24hex>.txt`，按内容寻址，用 O_EXCL 加 O_NOFOLLOW 创建，权限 0600。
另注册 `obs_recall {id, offset}` 工具，每页最多 16 KiB 或 400 行。
任何一步失败都放行原文（fail-open）。
来源：src/sol-pi/extensions/observation-pack/index.ts；observation.ts；src/sol-pi/runtime-paths.ts。

### 2.4 Luna Delegating，即 Evidence-Preserving Reducer（证据保全归约器，下称 EPR）

"Luna Delegating" 只是 TUI 上显示的名字，代码里叫 evidencePreservingReducer。
默认归约模型走 provider `openai-codex`、model `gpt-5.6-luna`，名字由此而来。
来源：src/sol-pi/tui.ts；src/sol-pi/extensions/evidence-preserving-reducer/config.ts。

它挂在 `tool_result` 事件上，只处理 bash 输出或 Action Fusion 的 then_run 输出。
命令必须匹配 DIAGNOSTIC_COMMAND 正则（pytest、cargo、make、npm test、go test、lean 等），正文在 4,096 字节到 60 万字符之间，疑似含密钥的跳过。
先把原文归档，再调一个便宜模型生成"收据"：一段 JSON，最多 12 条引用，每条不超过 600 字符。
校验很严：每条引用必须能在归档里逐字节找到，源文件 sha256 和状态要对上，收据必须比原文短，否则原结果原样放行。
来源：candidate.ts；receipt.ts；index.ts。

调用归约模型的路径：优先用 `context.modelRegistry.complete()`；当这个方法不存在时，退回 `getApiKeyAndHeaders()` 拿鉴权再直接调 pi-ai 的 complete。
来源：provider.ts 第 115 到 145 行。

## 3. 与 MMP 固定的 Pi 0.83.0 兼容性验证

MMP 固定依赖 `@earendil-works/pi-coding-agent@0.83.0`（package.json）。
我在临时目录里把 SoL-Pi 的开发依赖换成 0.83.0 后做了两件事。

类型检查 `npx tsc --noEmit`：通过。
SoL-Pi 导入的所有 Pi 符号在 0.83.0 的 d.ts 里都存在（`appendEntry` 在 dist/core/extensions/types.d.ts 第 923 行，`agent_settled` 在第 874 行）。

测试 `npx vitest run`：18 个文件里 17 个通过，139 个用例里 137 个通过。
失败的两个都在 tests/online-context-compact-agent-session.test.ts，是 OCC 的真实 AgentSession 端到端用例。
断言 `faux.state.callCount` 期望 3 实得 4，期望 5 实得 6。
含义：在 0.83.0 上，每次 OCC 压缩后的"自动继续"多出一次模型调用。
其余断言（压缩次数、隐藏提醒条数、最终回复、settled 次数）没有报错，说明功能是通的，只是多烧一次请求。
Pi 0.84.2 的 CHANGELOG 提到调整了大工具结果与自动压缩的先后顺序，很可能与此有关，但我没有逐行定位根因。
来源：本机测试输出；pi0842/package/CHANGELOG.md 0.84.2 条目。

Action Fusion、ObservationPack、EPR 的全部用例在 0.83.0 上通过。

两个原本未确认的点现已确认：
第一，Pi 0.83.0 的 `--extension git:<host>/<owner>/<repo>` 会在启动时经 `resourceLoader` 交给 `packageManager.resolveExtensionSources()`，后者能解析 npm: 和 git: 两种来源（dist/core/resource-loader.js 第 276 行；dist/core/package-manager.js 第 1145 到 1165 行）。
所以 MMP Manifest 里声明 git 来源在 0.83 上可用。
第二，`modelRegistry.complete()` 在 0.83.0 的 d.ts 里不存在，只有 `getApiKeyAndHeaders()`（dist/core/model-registry.d.ts 第 29 行）；0.84.2 才加了 `complete()`（第 33 行）。
EPR 对此有回退路径，所以在 0.83.0 上也能跑。

## 4. 对 MMP 的意义

MMP 的定位是"确定性的 Pi 宿主"：一切来自 Manifest，未声明即不存在，Pi 自己拥有 Auto Compact，MMP 不做自定义 Compact 和自定义 TUI renderer（docs/development.md 第 3.1 节、第 3.4 节、非目标列表）。
拿这条边界去对照四个机制：

OCC 没有越界。它不替换 Pi 的压缩算法，只是决定"什么时候"调 `context.compact()`，压缩本身仍是 Pi 原生的。
MMP 的 hooks 事件里已经有 `before_compact`，说明"压缩时机"本来就是 MMP 愿意暴露的面。

ObservationPack 和 Action Fusion 完全是本地逻辑，不多调模型，不碰会话文件，风险最低，收益最直接（ObservationPack 一项就占了三分之二的成本下降）。

EPR 每次要多调一个模型，还依赖特定 provider，和 MMP 已有的 agents/*.md 模型档案是同一类需求。

## 5. 建议的落地路径

第一步，先用而不写：在 `~/.mmp/mmp.json` 的 extensions 里加 `git:github.com/NVlabs/SoL-Pi`，配置放 `~/.mmp/pi/sol-pi.json`（因为 MMP 把 agentDir 设成 `~/.mmp/pi`，SoL-Pi 的 `getAgentDir()` 会读到这里）。
先开 observationPack 和 actionFusion，用真实工作量感受一周。
这一步不改 MMP 一行代码，随时可撤。

第二步，把 ObservationPack 和 Action Fusion 做成 MMP 内建扩展（形如 `mmp:observation-pack`、`mmp:action-fusion`），配置进 Manifest，沿用 MMP 的 fail-fast 校验和 dry-run 溯源输出。
理由：这两个机制不涉及模型调用和压缩策略，最容易照 MMP 的口味重写，也最容易在 `--dry-run` 里说清楚"哪个工具被谁替换了"。

第三步，OCC。两条路选一条：把 Pi 升到 0.84.2 后直接采用 SoL-Pi 的 OCC；或者留在 0.83.0，接受每次压缩多一次请求，先定位那次多余调用的来源。
我倾向前者，0.83.1 到 0.84.2 的 CHANGELOG 没有删除任何 MMP 在用的符号，升级成本可控。
无论哪条路，OCC 的"计划工具"可以和 MMP 的 `mmp:task` 合并：任务节点完成本来就是 MMP 的一等事件，天然就是 OCC 需要的边界。

第四步，EPR 放最后。归约模型通过 MMP 的 agents/*.md 档案声明，而不是像 SoL-Pi 那样写死 provider 和 model，这样更符合"一切来自 Manifest"。

## 6. 来源清单

https://github.com/NVlabs/SoL-Pi （源码，commit d7ecfc0）
https://nvlabs.github.io/SoL-Pi/ （官方博客，含基准数据）
https://alphasignal.ai/news/nvidia-s-sol-pi-slashes-coding-agent-token-use-by-49 （二手报道）
https://github.com/HerbertGao/pi-extensions/pull/164 （社区集成参考）
npm `@earendil-works/pi-coding-agent` 0.83.0 与 0.84.2 解包后的 dist/ 目录（API 与 CHANGELOG 核对）
