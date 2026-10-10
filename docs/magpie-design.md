# 内置 Magpie provider

来源：用户要求 Epi 自带 Magpie、自动发现模型，且不同模型可以使用不同协议；用户提供的 CONNECT 截图和本地 `/`、`/v1/models` 查询确认网关支持 Messages、Responses、Chat Completions 和 Gemini。2026-10-03 用户决定配置只保留 API key，放在 API key 登录项中（决策 MG1）。

## 接入

- provider ID 为 `magpie`，随 Epi 加载，不需要 Manifest 中声明扩展，也不新增 `epi:magpie` 或修改 Manifest schema。
- 使用 Pi 的公开 native `Provider` 和 `registerProvider(provider)`，协议实现使用 pi-ai 公开的 lazy API。注册适用于 TUI、print/json/rpc、模型列表和隔离 Task worker。
- 网关地址固定为 `http://127.0.0.1:3425`。唯一配置是 API key：`/login` → API key → Magpie，存在 `<EPI_HOME>/pi/auth.json`；`--api-key` 和其他 provider 一样，是选中模型的请求 key，不用于查询目录（查目录发生在选模型之前，用保存的 key）。没有 key 时用 `magpie`（loopback 网关接受任意 key）。没有配置文件，不读项目配置、Pi 配置或其他工具配置。
- 测试替换点：`EPI_TEST_MAGPIE_URL` 把地址换成本地假服务（我定的，参照 `EPI_TEST_CLIPBOARD_FILE`）。
- 不启动任何后台进程、定时器或 socket。

## 什么时候查询目录

2026-10-04 起按决策 MG2：Magpie 是普通的 provider 扩展，扩展里只有注册，没有任何"这次运行是否选了 Magpie"的判断。目录由 Pi 自己的刷新带进来。所有会选模型或列模型的启动路径（TUI、print/json/rpc、Task worker、`--list-models`）在选模型前调用同一个函数 `settleRegisteredProviders`（`src/provider-startup.ts`），它对**所有由扩展注册的 provider** 做两件事：

1. 等一次只读缓存的刷新，让 Pi 的认证状态和已保存的列表就位（dogfood D80）。
2. 不离线时再等一次允许联网的刷新，超时 5 秒（我定的）。Magpie 自己的目录请求超时仍是 2 秒。

| 情况 | 行为 |
|---|---|
| 网关在运行 | 每次启动请求一次目录，不管这次选的是哪个 provider |
| 网关没运行或没安装（连接被拒绝） | 不提示，用保存的列表。模型选择出现错误、会话没有模型、诊断明确提到该 provider，或未由 CLI/作用域选出模型且保存的默认 provider 是 magpie 时，加一行 `Warning: Model list refresh failed for magpie: Magpie is not running at …`，否则用户只会看到 `Unknown provider "magpie"`（硬规则：一个失败不能表现成另一个）。无关的模型警告不触发这条提示；CLI/作用域已经选出模型时不再看保存的默认 provider（D81）。这一条对所有扩展 provider 一样，按"连接被拒绝"判断，不按名字 |
| 其他失败（超时、HTTP 错误、目录格式不对） | 每次都警告：`Warning: Model list refresh failed for magpie: …; using its last saved model list, if any.`，继续用保存的列表 |
| 用保存的列表选中了 Magpie 的模型，但网关没运行 | 请求本身失败，报连接错误 |
| `--offline`、任意值的 `EPI_OFFLINE` | 不联网，只用保存的列表 |
| `--help`、`--dry-run` | 不选模型，不刷新 |
| `/model`、`/scoped-models`、rpc 和 TUI 启动后的后台刷新 | Pi 的联网刷新，会再请求一次目录 |

和 MG1 时期相比的变化（都是 MG2 的直接结果）：用其他 provider 时也会请求一次 Magpie 目录；网关挂起不回应时，每次启动多等 2 秒并警告；`--api-key` 不再用于查目录；启动后 10 秒内不重复查询的窗口删掉了。

`/login` 里 Magpie 的状态写明用的是哪个 key：没存 key 时是 "default key for the local gateway"，存了是 "Magpie API key"。

## 模型目录与协议

请求 `/v1/models`，保持 upstream 模型 ID（含 provider 前缀）不变。转换名称、上下文、输出上限、输入能力、reasoning 档位；无费用信息时填全零，明确这是未知价格而不是免费。

协议优先级：`native_endpoints` 中首个已支持端点 > Claude 用 Messages、Codex/GPT 用 Responses、Gemini 用 Gemini > 其他模型用网关的 Chat Completions。后两项是针对 Magpie 分发接口的默认策略，不是对任意代理的通用猜测。

| 协议 | Pi API | baseUrl |
|---|---|---|
| anthropic | anthropic-messages | root |
| responses | openai-responses | root/v1 |
| openai | openai-completions | root/v1 |
| gemini | google-generative-ai | root/v1beta |

允许目录分页；重复 ID、错误 schema、未识别的目录响应和循环分页要报错，不发布部分列表。合理缺省值用于未提供的 token 上限。

## 保存的列表

列表保存在 Pi 的 `<EPI_HOME>/pi/models-store.json`（`magpie` 一项），用网关地址做标记，换地址不用旧列表。不自建第二套缓存。

写入规则：

- 列表由 Pi 发布并写入（provider 的 `refreshModels` 调 `context.publish`），Epi 不自己写这个文件，也不再引用 Pi 没导出的 `FileModelsStore`。列表没变时不写。
- 只读缓存的刷新从不写入。
- 启动时的联网刷新是等待完成的，所以 `-p`、`--list-models` 这类短进程退出时写入已经结束。写入后 Pi 的读缓存丢掉文件版本，下一次读又要加锁，所以紧接着再等一次只读刷新，把这次读也放在启动里做完。否则 rpc 的后台刷新会去做这次读，客户端马上关闭 stdin 时进程在读的中途退出，留下 `models-store.json.lock`，下一个 epi 要等最多 30 秒（Fable 第二轮审查复现，见 [noninteractive-sdk-design.md](noninteractive-sdk-design.md) 8.3 节）。
- 启动之后的联网刷新（`/model`、rpc 的后台刷新）的写入登记在 provider 的 write tracker 里。扩展的 `session_shutdown` 处理等这些写入完成；关闭开始后才查到的列表不再写入。Pi 的 rpc 和 print 模式在 `process.exit` 前会先 dispose 运行时、等 `session_shutdown`，所以 rpc 客户端在后台刷新时关闭 stdin 也不会留下锁文件（Fable 审查 F5）。

刷新失败保留已有列表，同时由 SDK 或启动警告报告错误（网关没运行的情况见上表）。key、HTTP body、带密钥的 URL 不出现在错误消息里。factory 每次加载创建独立 provider 状态；在线刷新通过 SDK 的 generation-checked publication 防止过期响应覆盖新目录；中止不发布目录。

## 网关的会话续接（D74）

Magpie 的 `claude/` 路由在请求里带着它自己发过的 `tool_use` ID 时，会接着自己上游的会话走，只转发 tool result，同一轮里其他的用户文字被丢掉。所以 Alt+Enter 插话（steer）发到了网关，模型却看不到。用记录请求的代理实测：Epi 发出的请求里有这条消息；把 ID 换成网关不认识的，同样的请求就能被看到。Responses、Gemini 和 `antigravity/claude-*`（同样走 Messages）没有这个问题。

处理（我定的）：Messages 协议的请求里，如果最后一个带工具调用的助手消息之后有用户文字，provider 通过 pi-ai 公开的 `onPayload` 给这一次请求的工具 ID 加 `epi_` 前缀，网关就会处理整个请求。其他请求原样发出；调用方自己的 `onPayload` 仍然执行，看到的是改过的请求。改名后的 ID 不超过 Anthropic 的 64 字符上限：加前缀会超长时（例如从 Responses 模型切过来的长 ID），改用 ID 的 sha256 前 40 位。只有图片的插话也算插话。

代价（Fable 审查 F2）：插话的那次请求和下一次请求的前缀都和缓存对不上，每次插话多两次完整的 prompt cache 未命中。插话不常用，可以接受。网关修好后可以删掉这段。

## 验证

使用临时 HOME/EPI_HOME 和本地假服务（`EPI_TEST_MAGPIE_URL`），覆盖混合协议、真实 SDK 流式转换与工具调用、启动模型解析（参数和 settings 默认值）、目录新增/删除、保存与恢复、地址隔离、列表未变时不写、超时/中止/错误响应、offline（各种 `EPI_OFFLINE` 值）/help/dry-run、网关没运行时的提示规则、`/login` key 与 `--api-key`、用其他 provider 时也刷新、Task worker。CPU 负载下重复跑，确认不留锁文件。
