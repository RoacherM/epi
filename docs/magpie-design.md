# 内置 Magpie provider

来源：用户要求 MMP 自带 Magpie、自动发现模型，且不同模型可以使用不同协议；用户提供的 CONNECT 截图和本地 `/`、`/v1/models` 查询确认网关支持 Messages、Responses、Chat Completions 和 Gemini。2026-10-03 用户决定配置只保留 API key，放在 API key 登录项中（决策 MG1）。

## 接入

- provider ID 为 `magpie`，随 MMP 加载，不需要 Manifest 中声明扩展，也不新增 `mmp:magpie` 或修改 Manifest schema。
- 使用 Pi 的公开 native `Provider` 和 `registerProvider(provider)`，协议实现使用 pi-ai 公开的 lazy API。注册适用于 TUI、print/json/rpc、模型列表和隔离 Task worker。
- 网关地址固定为 `http://127.0.0.1:3425`。唯一配置是 API key：`/login` → API key → Magpie，存在 `<MMP_HOME>/pi/auth.json`；`--api-key` 只在选中 Magpie 时用于 Magpie。没有 key 时用 `magpie`（loopback 网关接受任意 key）。没有配置文件，不读项目配置、Pi 配置或其他工具配置。
- 测试替换点：`MMP_TEST_MAGPIE_URL` 把地址换成本地假服务（我定的，参照 `MMP_TEST_CLIPBOARD_FILE`）。
- 不启动任何后台进程、定时器或 socket。

## 什么时候查询目录

| 运行 | 启动时查询 | 失败时 |
|---|---|---|
| 选中 Magpie：`--provider magpie`、`--model magpie/…`；没有模型参数时 settings 的默认 provider 是 magpie；Task worker 的模型是 `magpie/…`（或没有模型且默认 provider 是 magpie） | 是，超时 2 秒 | 警告 |
| `--list-models` | 是 | 连接被拒绝（本机没装 Magpie）不提示，其他错误警告 |
| 其他运行 | 否，用保存的列表 | — |
| `/model`、`/scoped-models`、rpc 的后台刷新 | Pi 的联网刷新 | Pi 报告 |
| `--offline`、任意值的 `MMP_OFFLINE`、`--help`、`--dry-run` | 否 | — |

理由（我定的）：用其他 provider 时不该为 Magpie 多等；离线判断和 Pi 的 `ModelRuntime` 一致（`PI_OFFLINE` 有值即离线）。

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

列表保存在 Pi 的 `<MMP_HOME>/pi/models-store.json`（`magpie` 一项），用网关地址做标记，换地址不用旧列表。不自建第二套缓存。

写入规则（实测得出，见 [pi-internals.md](pi-internals.md) `models-store-file`）：

- 启动时查到的列表由 MMP 的扩展 factory 自己写入并等待写完，写完再读一次；列表和已保存的一样就不写。
- Pi 加载时触发的只读缓存刷新从不写入。原因：Pi 会用新的刷新取代旧的，被取代的刷新里的写入在后台继续；`-p`、`--list-models` 这类短进程退出时，如果 Pi 正在加锁，`models-store.json.lock` 会留下，下一个 mmp 要等最多 30 秒（CPU 负载下稳定复现）。写入后 Pi 的读缓存丢掉文件版本，下一次读又要加锁，所以写完立刻读一次。
- 联网刷新（`/model` 等）由 Pi 发布并写入，列表没变时同样不写。

刷新失败保留已有列表，同时由 SDK 或启动警告报告错误。key、HTTP body、带密钥的 URL 不出现在错误消息里。factory 每次加载创建独立 provider 状态；在线刷新通过 SDK 的 generation-checked publication 防止过期响应覆盖新目录；中止不发布目录。

## 验证

使用临时 HOME/MMP_HOME 和本地假服务（`MMP_TEST_MAGPIE_URL`），覆盖混合协议、真实 SDK 流式转换与工具调用、启动模型解析（参数和 settings 默认值）、目录新增/删除、保存与恢复、地址隔离、列表未变时不写、超时/中止/错误响应、offline（各种 `MMP_OFFLINE` 值）/help/dry-run、网关不存在时的提示规则、`/login` key 与 `--api-key`、Task worker。CPU 负载下重复跑测试，确认不留锁文件。
