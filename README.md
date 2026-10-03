# Make My Pi

> Compose Pi your way.

MMP (Make My Pi) 是基于 Pi SDK 的可定制终端编程助手。自有 grok 风格 TUI，组合 Skills、MCP、Hooks 与隔离子任务；Pi 提供模型、Agent Loop 与 Session，MMP 管理界面、配置、信任和能力装配。

![MMP 终端界面：对话、思考、工具调用与 Markdown](docs/assets/mmp-ui.png)

*真实 TUI，离线演示数据。思考、文件修改与命令执行集中呈现。*

<details>
<summary>查看启动页</summary>

![MMP 启动页](docs/assets/mmp-welcome.png)

[截图生成方式](docs/assets/README.md)

</details>

## 要点

- **自有界面**：按 grok-build 设计的全屏终端界面，对话、思考、工具调用和文件修改集中呈现。
- **建在 Pi 上**：模型、Agent Loop、Session 用锁定版本的 Pi SDK，功能和 Pi 对齐。
- **配置只属于 MMP**：独立的 `~/.mmp`，不读 Pi 或其他工具的配置，不认 `PI_*` 环境变量；项目配置要先信任。
- **显式装配**：Rules、Skills、Extensions 由 Manifest 声明；内建 Task（子任务）、MCP、Hooks 默认开启，可以关掉。

## 快速开始

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://github.com/RoacherM/mmp/releases/latest/download/install.sh | sh
mmp
```

要求 Node.js `>=22.19.0`。启动后用 `/login` 登录模型服务。

## 文档

- [使用文档](docs/guide/README.md)：[安装与升级](docs/guide/install.md) · [命令行](docs/guide/cli.md) · [配置](docs/guide/configuration.md) · [Task](docs/guide/task.md) · [MCP](docs/guide/mcp.md) · [Hooks](docs/guide/hooks.md)
- 开发：[产品与架构](docs/development.md) · [开发流程](docs/dev-workflow.md)（[自举流程](docs/dev-workflow-herdr.md)、[通用的工作流图](docs/workflow-graph.md)） · [设计决策](docs/decisions.md)；给开发代理的入口是 [AGENTS.md](AGENTS.md)
