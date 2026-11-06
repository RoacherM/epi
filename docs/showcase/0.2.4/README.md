# 0.2.4 特性展示

[← 特性展示](../README.md)

0.2.4 聚焦内置 `magpie` provider 的跨渠道与旧配置兼容（Issue #11，见 [magpie-design.md](../../magpie-design.md)）。

本版本**没有新增界面元素**，所以没有录屏：改动全部位于 `magpie` 请求链路与启动目录解析层。

## 解决的三类问题

1. **Antigravity 与 `auto/*` 跨渠道切换不再 400**：
   - 在 `stream` / `streamSimple` 进入 `pi-ai` 转换前，先剥离 `context.messages` 中工具调用与结果 ID（含 `callId|itemId` 双段）末尾的 `__ts(?:r|k\d+)?__[A-Za-z0-9_-]+$` 后缀，并在四协议 `onPayload` 中继续兜底剥离。
   - 清理四种协议下不兼容的异源思维块与签名：Messages 将非空 `thinking` 块转为普通 `text` 块并移除 `redacted_thinking`；Chat Completions 移除 `thought_signature`、`reasoning_opaque`、`reasoning_details` 与 `extra_content.google.thought_signature`；Responses 移除 `reasoning` 项；Gemini 移除非 `functionCall` part 的 `thoughtSignature` 并过滤残留空 part。
   - 在发往 `antigravity/*` 与 `auto/*` 的系统提示词、会话历史与工具输出中，对 harness 标识词及压缩摘要模板句做首字符后插入 `U+200B` 的幂等脱敏，与网关 `@magpie-community/middleware-antigravity-cloak` 对齐。
2. **Gemini (`/v1beta`) 跨模型历史 `functionCall` 签名兜底**：
   - `pi-ai` 在历史工具调用来自其他模型时不写 `thoughtSignature`，而 Gemini 3/4 要求历史 `functionCall` 必须带签名或 `"skip_thought_signature_validator"`。`withGatewayFixes` 自动补齐该占位符，消除跨模型工具续轮 400。
3. **旧 `models.json` 静态 `providers.magpie` 不再覆盖协议端点与目录元数据**：
   - 若 `<EPI_HOME>/pi/models.json` 残留早期静态 `providers.magpie`（如顶层 `"baseUrl": "http://127.0.0.1:3425/v1"`、`"api": "openai-completions"` 或缺失 `reasoning` 的模型项），`createMagpieProvider` 与 `settleRegisteredProviders` 会按实时目录还原每个模型的 `api`、`baseUrl` 与完整目录元数据（`reasoning`、`thinkingLevelMap`、`compat`、`input`、`promptCache`、`cost`）。
