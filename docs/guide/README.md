# MMP 使用文档

[← README](../../README.md)

| 文档 | 内容 |
|---|---|
| [安装与升级](install.md) | 要求、一键安装、首次运行与认证、`mmp update`、npm 安装、从源码构建 |
| [命令行参考](cli.md) | 交互界面、参数、`MMP_*` 环境变量、子命令（`install`/`remove`/`list`/`config`/`auth`/`mcp`/`update`） |
| [配置](configuration.md) | 和 Pi 的隔离、配置布局、项目信任、Manifest、Skill 自动发现、`/reload`、故障定位 |
| [Task](task.md) | `mmp:task`：隔离子进程里的子任务与 Agent profile |
| [MCP](mcp.md) | `mmp:mcp`：`mcp.json`、codemode、`mmp mcp` |
| [Hooks](hooks.md) | `mmp:hooks`：事件、决策、handler 类型 |
| [Benchmark adapter](benchmark.md) | 外部评测用的 trial adapter |

## 内建能力一览

| 能力 | 作用 | 文档 |
|---|---|---|
| `mmp:task` | `task`、`task_status`、`task_wait`、`task_cancel`、`todo`：在隔离的子进程里跑子任务，Agent profile 放在 `agents/*.md` | [Task](task.md) |
| `mmp:mcp` | 读 `mcp.json` 接入 MCP 服务，使用锁定 Pi 的原生 MCP 支持；`mmp mcp` 管理 | [MCP](mcp.md) |
| `mmp:hooks` | 读 `hooks.json`，在会话、提示、工具调用等事件上运行 command/http/prompt/agent handler | [Hooks](hooks.md) |


