# Hooks

[← 文档索引](README.md)

`epi:hooks` 默认开启（`"disable": ["epi:hooks"]` 可关掉，关掉后不读 `hooks.json`），创建 `~/.epi/hooks.json` 即可：

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

支持事件：

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

Global hooks 先执行，可信 Project hooks 后执行；每个 Hook 的 handlers 按声明顺序串行执行。`match` 是 event payload 的 dot-path 精确匹配；数组值表示任一值匹配。例如 `{"toolName":["bash","write"]}`。

所有 Handler 从 stdin/HTTP/model/agent 接收事件 JSON，并必须返回且只返回一个决策 JSON：

```json
{"action":"continue"}
{"action":"block","reason":"policy denied"}
{"action":"cancel","reason":"optional reason"}
{"action":"transform","text":"new user prompt"}
{"action":"replace","text":"new tool result","isError":false}
```

合法决策按事件限制：

| 决策 | 合法事件 |
|---|---|
| `continue` | 全部 |
| `block` / `cancel` | `tool_call`、`user_prompt`、`task_start`、`before_compact` |
| `transform` | `user_prompt` |
| `replace` | `tool_result` |

Handler 类型：

- `command`：字段为 `command`、可选 `args`/`cwd`/`env`/`timeoutMs`。stdin 是事件 JSON，stdout 是决策 JSON；`shell:false`，不会做隐式 shell 插值。带 `/` 的相对 command 与相对 cwd 都相对 `hooks.json` 解析。
- `http`：字段为 `url`、可选 `method`/`headers`/`body`/`timeoutMs`。非 GET 默认发送完整事件；2xx response body 必须是决策 JSON。
- `prompt`：字段为 `prompt`、可选 `model`/`timeoutMs`。缺省 model 使用当前 Parent 模型。
- `agent`：字段为 `agent`、`prompt`、可选 `timeoutMs`。`agent` 必须引用已加载的 Task Agent profile；未知名称在 Pi 启动前失败。Agent Child 同样不能递归派生 Task。

`timeoutMs` 默认 `10000`，最大 `300000`。超时、非零 command exit（错误信息包含退出码和一段 stderr 尾部）、spawn 失败（如 command 找不到）、非 2xx HTTP、超限输出、malformed JSON 和非法决策都视为 Hook 失败，错误信息会指出具体是哪个 Hook（event + 声明它的文件）和哪个 handler。阻断型 Pi 事件会 fail-closed；Session shutdown 会取消仍在运行的 handlers 并回收进程。`tool_call`/`tool_result` 失败通过对应 tool result 显示；没有 tool result 可用的事件（`session_start`、`user_prompt`、`session_before_compact`、`session_shutdown`）失败时会调用 Pi UI 通知，在 Epi 自己的界面和 Pi 的 `rpc` 模式下可见；Pi 的 `print`/`json` 模式没有可用 UI（Pi 的 `noOpUIContext`），这两种模式下同一条消息还会写到 stderr，确保失败不会安静地留下一个空回复。

HTTP `body`、`url`、`headers` 与 command `env` 支持 `${ENV_NAME}`。HTTP body 还支持事件模板：

```json
{
  "tool": "{{event.toolName}}",
  "cwd": "{{cwd}}",
  "event": "{{event}}"
}
```

完整占位符保留原 JSON 类型；嵌入字符串中的对象值会 JSON 序列化。
