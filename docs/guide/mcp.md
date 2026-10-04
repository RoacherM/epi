# MCP

[← 文档索引](README.md)

`mmp:mcp` 默认开启（`"disable": ["mmp:mcp"]` 可关掉，关掉后不读 `mcp.json`，`mmp mcp list` 里每个服务显示 `not loaded`），创建 `~/.mmp/mcp.json` 即可接入服务（格式和 Pi 自己的 `mcp.json` 逐字一致，见 Pi 的 `docs/mcp.md`）：

```json
{
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  },
  "autoEnableCodemode": true
}
```

传输只有 stdio（`command`/`args`/`env`/`cwd`）和 streamable HTTP（`url`/`headers`/`oauth`）；不支持 SSE、unix socket。`${ENV_NAME}`/`$ENV_NAME` 在连接前展开，`!command` 执行子进程取值。可信项目的 `<repo>/.mmp/mcp.json` 在全局配置之后合并，同名服务项目覆盖全局。用 `mmp mcp add/remove/list/login/logout` 管理（见 [命令行参考](cli.md#子命令)），或直接编辑文件后 `/reload`（要求当前进程已启用 `mmp:mcp`；修改 Manifest 的扩展选择需重启）。

模型默认通过 `codemode` 工具调用 MCP 服务（写 JS 脚本批量/串联调用，见 Pi 的 `docs/cli.md#how-codemode-works`），配了服务时 Pi 自动启用；某个服务想让模型直接看到，加 `"exposure": "direct"`（也可以用 `toolExposure` 按工具设置）。`/mcp` 打开 Pi 自己的管理面板（登录、重连、启用/停用、改曝光方式）；没有配置任何服务时显示 MMP 自己的提示，不是 Pi 的 `.pi/mcp.json`。

MMP 只决定读哪些配置文件（上面两份，从不读 Pi 自己的 `~/.mmp/pi/mcp.json` 或项目 `.pi/mcp.json`）和项目是否可信；连接、OAuth、工具注册、`/mcp` 面板全部是锁定 Pi SDK 内置的原生 MCP 支持（`createMcpExtension`），MMP 不再自带 MCP 客户端。凭据明文存在 `~/.mmp/pi/mcp-auth.json`（和 Pi 一样，不进系统钥匙串）。
