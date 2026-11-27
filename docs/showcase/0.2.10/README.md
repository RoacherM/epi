# 0.2.10 特性展示

[← 特性展示](../README.md)

0.2.10 基于真实历史 trace 与死循环复盘收敛 `dispatch` 运行时契约（决策 DP2），消除运行期工具抖动对 KV Cache 前缀的破坏、收紧死循环与等待预算护栏、统一无头 `monitor` 收尾排空，并为 Magpie 开启会话亲和头与前向兼容能力。

本版本没有改变主界面布局，不附新录屏。

## 1. 异步调度路由、KV-Cache 稳定化与子代理精简（DP2）

- **`bash` 参数收口为 `mode` 三态契约**：删除旧 `waitMsBeforeAsync` 与 `isDaemon` 参数并启用 `additionalProperties: false`，统一为 `mode?: "auto" | "background" | "daemon"`；同步等待窗口收归宿主适配器 `syncWindowMs` 控制，减少模型参数误用与长耗时阻塞。
- **首轮静态工具集，消除 KV-Cache 前缀失效**：删去运行时动态 `activateTools()` 与一切中途 `setActiveTools` 调用；根会话首轮即静态固定注册 `board_post` 与 `board_read`（去掉极少使用的 `board_wait`），外部收件箱工具按启动配置静态挂载，确保多轮对话中工具 schema 前缀零抖动。
- **`task` 角色分离与子代理能力裁剪**：新增 `role?: "worker" | "peer"`（`name` 仅作句柄，`role: "peer"` 才加入共享看板并默认后台运转，普通具名 `worker` 不再被误拉看板）；子代理预设作用域（`AgentScope` / `TaskAssemblyScope`）默认关闭 `epi:web` 联网检索以节省前缀（需要在预设中配置 `web: true` 按需开启），`epi:runtime` 系统提示词按 `interactive-root`、`headless-root` 与 `subagent` 三路受众分别裁剪。

## 2. 死循环护栏、`task_wait` 预算钳制与无头 `Monitor` 排空统一

- **定点死循环护栏（`FixedPointGuard`）**：在 `src/repeat-guard.ts` 对连续逐字节相同的 `(toolName, canonicalInput)` + `(isError, rawResult)` 往返检测重复，在 `tool_result` 中自动追加退出提醒（非阻塞不误杀合理翻页与轮询，显式用户输入、切分支与压缩时重置）。
- **TUI `task_wait` 受前台预算约束**：交互式 TUI 下 `task_wait` 同样受 `foregroundBudgetSeconds`（默认 `300s`，`waitEnd: "budget"`）上限约束，避免长期阻塞对话线程，超时转入后台并发回完成通知。
- **统一 `SettleSource` 排空屏障**：`DrainBarrier` 聚合多路 `SettleSource`（含新增 `TaskMonitorBridge.settleSources()`），并通过 `NotificationLedger.holdFlush()` / `flushFromDrain()` 消除无头 `print`/`json` 模式下非持久 `monitor`（`coalesceMs: 0`）收尾排空时的重复唤醒与乱序通知，同时移除旧 `task-notify.ts`。

## 3. Magpie 会话亲和头与前向兼容、评测与工作流文档

- **Magpie 亲和头与前向兼容**：`catalogCompat()` 与持久化模型解析对 OpenAI/Anthropic 协议自动开启 `sendSessionAffinityHeaders: true` 以提升网关缓存命中与黏性，并将 `magpie_compat.thinking_format` 放宽至 `pi-ai` 全量 11 种已知格式，保留前向兼容能力。
- **文档同步**：`README.md` 补充 FrontierHarness Eval v1.1 四模型评测对比表与帕累托前沿图，开发与端到端验收流程全面迁移至 Herdr 分屏协同工作流。
