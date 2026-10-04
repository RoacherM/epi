# Magpie 内置 provider

[← 文档索引](README.md)

MMP 自带 `magpie` provider，不需要创建扩展、安装包，或在 Manifest 中声明 `mmp:magpie`。它不是第四个 Manifest 内建能力；`mmp.json` 的 schema 和三个 `disable` 名称不变。

## 直接使用

启动本机 Magpie 网关后：

```bash
mmp --list-models magpie
mmp --provider magpie --model 'claude/claude-opus-5-5'
```

也可以在 `/model` 中搜索 `magpie`。模型 ID 保留 Magpie 返回的 provider 前缀：MMP 的完整模型名是 `magpie/claude/claude-opus-5-5`，发给 Magpie 的仍是 `claude/claude-opus-5-5`。

MMP 固定连接本机网关 `http://127.0.0.1:3425`。从源码验证未发布的改动时，将上述 `mmp` 换成 `node dist/cli.js`；全局安装的旧版本不会因工作区构建自动更新。

## 配置：只有 API key

Magpie 唯一的配置是 API key，和其他 provider 的 API key 放在同一处：

1. 在 MMP 里输入 `/login`；
2. 选 **Sign in with an API key**，再选 **Magpie**；
3. 输入 key。

key 保存在 MMP 独立的 `~/.mmp/pi/auth.json`。也可以单次运行时用 `--api-key <key>` 传入（只在选中 Magpie 时用于 Magpie，其他 provider 的 key 不会发给 Magpie）。用 `/logout` 删除。

没有保存 key 时使用默认值 `magpie`，`/login` 里显示为 "default key for the local gateway"；本机 loopback 网关接受任意 key，所以本机使用通常不需要 `/login`。

没有别的配置文件：地址、超时和协议都不可配置，也不读取项目、Pi 或其他工具的配置。

## 自动发现与协议

MMP 通过 `/v1/models` 获取模型列表，不会后台轮询、启动 Magpie 或自动下载模型。查询目录的时机：

| 时机 | 是否等待目录 |
|---|---|
| 选中 Magpie 启动（`--provider magpie`（大小写不限）、`--model magpie/…`、`--models` 或 settings `enabledModels` 里有 `magpie/…`，或没有模型参数时 settings 默认 provider 是 magpie；Task worker 的模型是 `magpie/…`） | 等待，最多 2 秒；失败时警告 |
| `--model` 以 `claude/`、`codex/`、`antigravity/`、`group/` 开头、不带 `magpie/`，且还没保存过 Magpie 列表 | 等待；本机没有网关时不提示 |
| `mmp --list-models` | 等待；本机没有网关（连接被拒绝）时不提示 |
| 用其他 provider 启动 | 不查询，用上次保存的列表 |
| 打开 `/model`、`/scoped-models` | 刷新（启动时刚查过的 10 秒内不重复查）。从没用过 Magpie 且本机没有网关时不报错 |

Magpie 新增或删除模型后，下一次查询同步列表。

命令行指定 Magpie 模型最好带 `magpie/` 前缀或 `--provider magpie`。只写 `--model claude/claude-opus-5-5` 也能用：第一次运行会查询目录并保存，之后从保存的列表里匹配。

协议选择顺序：

1. 模型目录 `native_endpoints` 中首个支持的端点；
2. Magpie 分发的默认策略：Claude → Anthropic，Gemini → Gemini，Codex/GPT → Responses，其余 → Chat Completions。

| 协议 | Pi API | 请求端点 |
|---|---|---|
| Anthropic | `anthropic-messages` | `/v1/messages` |
| Responses | `openai-responses` | `/v1/responses` |
| Chat Completions | `openai-completions` | `/v1/chat/completions` |
| Gemini | `google-generative-ai` | `/v1beta/models/<模型 ID>:streamGenerateContent` |

名称、输入能力、reasoning 档位和 token 上限来自模型目录。目录缺少 token 上限时使用保守值（200000 上下文、8192 最大输出），不是模型真实规格。目录没有价格时费用字段为零，表示不估算费用，不代表免费。可用 MMP 独立的 `~/.mmp/pi/models.json` 中 `providers.magpie.modelOverrides` 补充价格或其他模型元数据。

这里只用聊天接口；Magpie 单独的图片生成、视频和分类端点不在范围内。

## 保存的列表与错误

模型列表保存在 **`<MMP_HOME>/pi/models-store.json`**，按网关地址区分。列表没变时不重写这个文件。

- `--offline` 或设置了任意值的 `MMP_OFFLINE`（和 Pi 一样）不查询目录，只用保存的列表。offline 禁止目录更新，不禁止已选择模型的推理请求。
- `--help`、`--dry-run` 不查询目录。
- 目录查询失败时保留上次保存的列表并打印警告，不发布部分分页数据。key、HTTP 响应内容不会出现在错误里。
- 运行中插话（Alt+Enter，rpc 的 `steer`）在 `claude/…` 模型上也能被模型看到：网关会丢掉跟在工具结果后面的用户文字，MMP 在这类请求里改写工具 ID 绕开它（见设计文档 D74 一节）。
- Task worker 同样支持内置 provider，但不继承父会话的第三方扩展。

如果以前安装了用户自己的 Magpie provider 扩展，先从 `~/.mmp/mmp.json` 的 `extensions` 中移除旧声明并重启，否则旧 provider 配置可能继续覆盖内置目录。不要直接覆盖或删除原来的凭证配置。
