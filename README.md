# Make My Pi

> Compose Pi your way.

MMP (Make My Pi) 是基于固定版本 Pi SDK 的显式、确定性 Harness。它复用 Pi 的 Agent Loop、模型、认证、Session、TUI 组件、基础工具和 Auto Compact；交互界面是 MMP 自己写的第 4 层（`src/tui/`），`mmp` 是唯一的启动入口。MMP 只负责配置装配、项目信任、Task、MCP 与 Hooks。

当前固定版本：

- Node.js `>=22.19.0`
- `@earendil-works/pi-coding-agent`：见 `package.json`（MCP 用它 0.99 起的原生支持，不再有独立的 adapter 依赖，见 [docs/mcp-design.md](docs/mcp-design.md)）

MMP 不调用 PATH 中的 `pi`，使用独立的 `~/.mmp/pi` 运行目录，不继承 `~/.pi/agent` 的配置。Rules 与 Extensions 由 MMP Manifest 显式声明；Skills 还会从三个固定目录自动发现（见下文）。MMP 不自动加载项目 `.agents/`、`AGENTS.md` 或 `CLAUDE.md`。

已知隔离限制：交互模式不读取项目 `.pi/settings.json`；仍经过 Pi CLI 的非交互模式在启动查找会话时会读取该文件，可能影响会话目录。这是尚未消除的上游启动行为，见 [决策 D3](docs/decisions.md)，不要依赖项目 `.pi/` 配置 MMP。

开发入口：[产品与架构](docs/development.md) · [开发流程](docs/dev-workflow.md) · [设计决策](docs/decisions.md)。根目录 [AGENTS.md](AGENTS.md) 是给开发代理的简短入口，不是自动生效的 MMP 运行配置。

## 安装

要求 Node.js `>=22.19.0`。推荐使用版本固定的安装器：

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://github.com/RoacherM/mmp/releases/latest/download/install.sh | sh
```

安装器检查 Node.js/npm，验证发行包的 SHA-256 后再执行全局安装，不会自动使用 `sudo`。不希望把脚本直接交给 shell 时，可以先下载并审阅 `install.sh`。

### 交互界面

```bash
mmp
```

`mmp` 唯一的交互入口是它自己按 grok-build 设计写的第 4 层界面（设计见 [docs/tui-design.md](docs/tui-design.md)），不再启动 Pi 自带的经典交互界面。全屏布局、MMP 启动页、`/login`、`/logout`、`/model`、`/new`、`/resume`、`/compact`、`/reload`、`/trust`、对话和流式输出、工具调用、`!` bash、`--verbose` 启动提示、`@file` 首条消息、Esc 中止、Ctrl+C / Ctrl+D 退出、扩展的对话框和面板（`select`、`custom` 等）均已支持；未接线的内置命令在补全里标 `(not yet)`，输入后会提示尚未支持。`--help` 和 `--list-models` 也由 MMP 自己实现；`--print`、`--mode json/rpc`、`--export` 和其余非 TTY 运行仍使用内部 Pi CLI；`mmp update/install/remove/uninstall/list/config/auth` 是 MMP 自己的子命令（见下）。

### 升级

```bash
mmp update
```

`mmp update` 查询 GitHub 上最新的 Release；有新版就下载该版本的 `install.sh` 并运行，安装器同样会校验 SHA-256。交互模式每天最多检查一次新版本（后台进行，超时 3 秒），有新版时在底栏显示 `Update available! … Run: mmp update`。检查结果缓存在 `~/.mmp/update-check.json`，检查失败时错误也记在这里。非交互模式、`--offline`、`PI_OFFLINE`、`CI` 环境下不检查；设置 `MMP_DISABLE_UPDATE_CHECK=1` 可以完全关闭。MMP 会关掉 Pi 自带的更新提示，因为它提示的 `pi update` 不会更新 MMP 锁定的 Pi。MMP 不做后台自动安装。安装器不会自动使用 `sudo`：如果当初是装在需要 root 权限的全局目录里，`mmp update` 会失败退出，需要按当初的方式手动重装。

也可以直接通过 npm 安装同一个 GitHub Release；`<version>` 换成 [Releases 页面](https://github.com/RoacherM/mmp/releases)上的最新版本号（tgz 的文件名带版本号，没有 `latest` 别名）：

```bash
npm install --global \
  https://github.com/RoacherM/mmp/releases/download/v<version>/mmp-<version>.tgz
mmp --version
```

Release 包含已构建的 `dist/`，安装时只获取运行时依赖；不要求本机预装 TypeScript，也不要求 PATH 中存在全局 `pi`。

本 README 描述当前主分支；安装器和 `mmp update` 获取最新 GitHub Release，发布版可能落后于主分支。合并到 `main` 与发布新版本是两件事：Release workflow 在推送到 `main` 时运行，只有 `package.json` 对应版本尚无标签时才发布。

从主分支源码开发或修改 MMP：

```bash
git clone --branch main https://github.com/RoacherM/mmp.git
cd mmp
npm ci
npm run build
npm test
npm link
```

需要让 MMP 加载本仓库开发规则时，可将 [开发配置模板](examples/development/mmp.json) 复制到本地 `.mmp/mmp.json` 后显式信任项目；已有配置请手动合并，勿覆盖。模板路径以目标 `.mmp/` 为基准，只引用 `AGENTS.md` 与当前开发流程；运行时 `.mmp/` 不提交。

版本检查应输出两行：`mmp <当前 MMP 版本>` 和 `pi <当前锁定的 Pi 版本>`（具体版本号见 `package.json`，不在这里写死，避免每次发布都要改文档）。

首次安装不要求创建 Manifest；`mmp --no-project --dry-run` 可以空配置启动。MMP 使用独立 Pi 运行目录 `~/.mmp/pi`。认证可通过 Pi 支持的 provider 环境变量提供；也可以启动 `mmp` 后使用 Pi 的 `/login`。认证、settings、sessions 与 project trust 都不会从 `~/.pi/agent` 自动继承。

交互启动时，MMP 启动页会直接显示 `MMP on Pi` 身份、Manifest 状态、核心 JSON 配置方法和 `/mmp`、`/login` 等入口。每次 Agent 运行还会把同一份 runtime identity 注入模型上下文：当前 `MMP_HOME`/`agentDir`、Manifest 来源以及实际加载的 Rules、Skills 和 Extensions 都可核验；上游 Pi 文档中的 ambient 资源目录不会被误认为当前能力。

## 最小使用

```bash
# 查看 MMP 与固定 Pi 的完整参数
mmp --help

# 只解析并校验配置，不启动 Pi
mmp --dry-run

# 非交互运行
mmp --model openai/gpt-4o-mini --no-session --print "Reply exactly: MMP_OK"

# 启动 MMP 自己的交互界面
mmp --model openai/gpt-4o-mini
```

`mmp --help` 打印 MMP 自己维护的完整参数表（`src/args.ts` 的 `MMP_FLAG_TABLE`，同一张表驱动解析、校验和帮助文本），不附带任何其他命令行的帮助。已声明 Extension 通过 `pi.registerFlag` 注册的长参数也受支持，并列在帮助的 `Extension options` 中；无人注册的长参数在扩展加载后报错，未知短参数直接报错。资源加载参数仍受下面的 Manifest 限制。

MMP 自有、和 Pi 行为不同的参数：

| 参数 | 行为 |
|---|---|
| `--dry-run` | 校验完整装配并输出无 secret 的 JSON；不启动 |
| `--no-project` | 完全禁用项目 `.mmp` 发现 |
| `-a, --approve` | 本次运行信任最近的项目 `.mmp/mmp.json`。只作用于 MMP；不授予 Pi 项目配置权限；非交互启动的已知限制见上文 |
| `-na, --no-approve` | 本次运行忽略项目配置 |
| `-v, --version` | 输出 MMP 与固定内核版本 |
| `-h, --help` | 只打印 MMP 自己的帮助 |

其余模型、Session、工具、输出参数（`--provider`、`--model`、`--thinking`、`-c/--continue`、`--session*`、`-p/--print`、`--mode`、`--list-models`、`--export`、`--offline`、`--verbose` 等）和 Pi 对齐，参数名和取值语义不变。`--verbose` 在交互界面里把启动信息（已加载的 Rules/Skills/Extensions 数量、当前模型、当前 Session）显示成对话区提示；非交互模式行为和 Pi 一致。`@file` 参数：文本文件原文内联进第一条消息，图片文件会读取为图片附件并附在首条消息中（同时保留路径提示），文件不存在会报错退出。`--session-dir` 没给时依次看 `MMP_SESSION_DIR` 环境变量、`~/.mmp/pi/settings.json` 里的 `sessionDir`（和 Pi 的 `--session-dir`/`PI_CODING_AGENT_SESSION_DIR`/`sessionDir` 顺序一致，只是变量名换成 MMP 自己的——Pi 装置里设置的 `PI_CODING_AGENT_SESSION_DIR` 不会被读取，不会跟 MMP 共享）。

以下参数**不提供**：`--use-theme`、`--tui-mode`（界面已经是 grok 风格的单一全屏主题，由 MMP 管理）；`--extension`/`-e`、`--skill`、`--prompt-template`、`--theme`、`--system-prompt`、`--append-system-prompt` 及其 `--no-*` 形式（Rules/Extensions 只能通过 Manifest 声明；Skills 除 Manifest 声明外还会从固定目录自动发现，见"Manifest"一节；这些 flag 都不提供，直接传入会报错并提示改用 `mmp install`/编辑 Manifest）。

如需隔离配置，设置绝对路径：

```bash
MMP_HOME=/absolute/path/to/mmp-home mmp --dry-run
```

## 子命令

```bash
mmp update [--self|--extensions|--models|--all] [<source>]      # 更新 mmp 本身/扩展包缓存/模型目录
mmp install <source> [-l] [--approve|--no-approve]              # 把 npm:/git:/本地路径写进 Manifest 的 extensions
mmp remove <source> [-l] [--approve|--no-approve]               # 从 Manifest 删除
mmp uninstall <source> [-l] [--approve|--no-approve]            # remove 的别名
mmp list                                                        # 列出全局与项目 Manifest 里的 Rules/Skills/Extensions
mmp config [-l] [--approve|--no-approve]                        # 用 $VISUAL/$EDITOR 编辑 Manifest，保存后立即校验
mmp auth print-api-key|print-bearer-token|check                # 打印或检查 provider 凭证（读写 ~/.mmp/pi，不读 ~/.pi/agent）
mmp mcp add|remove|list|login|logout                            # 配置、检查 MCP 服务，OAuth 登录/登出
```

`-l` 把 `install`/`remove`/`config` 的目标从全局 `~/.mmp/mmp.json` 换成当前目录的 `.mmp/mmp.json`；目标项目未被信任时三者都会拒绝，报同一句 "not trusted" 提示，除非带 `--approve`（仅本次生效，和 Pi 自己的项目级 package 命令一样，见 `package-manager-cli.js`）。`mmp install` 写入前会校验来源是否真实存在：`npm:` 用 `npm view <spec> version` 确认包（和版本）能解析，`git:` 用 `git ls-remote` 确认仓库可达（10 秒超时；命令缺失或返回非零都会带上原始报错说明原因；`--offline` 和 `PI_OFFLINE` 一样跳过这项检查），本地路径确认文件存在；`git:` 只接受 Pi 自己会接受的形状（host/path、显式协议 URL、scp 语法，可选 `@ref`），校验失败不写入，并说明原因。写入后需要重启 `mmp` 才生效；扩展包本身不会被预先下载进 `.pi/` 或 Pi 的 `settings.json`——它们和其它 Manifest 声明的 Extension 一样，在下次 `mmp` 启动时按 `--extension npm:x`/`git:x` 的方式加载，缓存在 `~/.mmp/pi/tmp/extensions` 下；`mmp update --extensions` 清空这份缓存，让声明的来源在下次启动时重新拉取。`mmp config` 的编辑结果如果校验失败，会保留编辑前的文件内容并报错。

## 配置布局

全局配置默认位于：

```text
~/.mmp/
├── mmp.json             # 全局 Manifest
├── RULES.md             # 示例 Rule，由 Manifest 显式声明
├── skills/              # 自动发现（也可额外被 Manifest 显式声明）
├── agents/*.md          # mmp:task 与 agent Hook 使用的 Agent profile
├── mcp.json             # mmp:mcp 配置
├── hooks.json           # mmp:hooks 配置
└── pi/                  # MMP 独立的 Pi auth/settings/sessions/trust
```

项目配置使用最近的祖先目录：

```text
<repo>/.mmp/
├── mmp.json
├── skills/              # 自动发现，仅在项目可信时读取
├── agents/*.md
├── mcp.json
└── hooks.json
```

项目文件只有在统一 Project Trust 决策为可信后才会读取。`--approve` 与 `--no-approve` 是本次运行覆盖。交互模式下第一次进入带 `.mmp/mmp.json` 且还没决定过的项目会弹出选择（信任 / 信任父目录 / 仅本次信任 / 不信任 / 仅本次不信任）；随时也可以在 `mmp` 里用 `/trust` 改。两者都保存到同一个信任记录，重启后生效（Extensions 不能热加载）。`--no-project` 连发现都禁用；非交互模式（`-p`、`--mode json/rpc` 等）不会弹这个选择。先执行 `mmp --dry-run` 可核对 `projectDiscovery`、`trusted`、`loaded` 与每项资源的 provenance。

## Manifest

`~/.mmp/mmp.json` 与 `<repo>/.mmp/mmp.json` 使用同一 schema：

```json
{
  "version": 1,
  "rules": ["./RULES.md"],
  "skills": ["./skills"],
  "extensions": [
    "mmp:task",
    "mmp:mcp",
    "mmp:hooks",
    "./extensions/local-extension.ts",
    "npm:some-pi-extension@1.2.3"
  ]
}
```

规则：

- 只允许 `version`、`rules`、`skills`、`extensions`；未知字段直接失败。
- 相对文件路径相对声明它的 Manifest 解析，并转换为 canonical absolute path。
- Global 资源先装配，可信 Project 资源后装配；相同 canonical path 去重。
- 内建 Extension 只有 `mmp:task`、`mmp:mcp`、`mmp:hooks`。
- 未声明内建 Extension 时，其工具、handler、配置和子进程都不存在。
- 外部 Extension 可使用本地路径、`npm:` 或 `git:` source；MMP 仍关闭 Pi 的 ambient discovery。

Rules 按装配顺序拼接到 Pi system prompt。Skills 使用 Pi 的 `SKILL.md` 格式，并通过绝对路径显式加载。

除 Manifest 声明的 Skill 路径外，MMP 还会自动发现三个固定目录（缺失时跳过，不报错）：

- 全局 `~/.agents/skills`（跨 Agent 通用约定目录）；
- MMP 自己的全局 `<MMP_HOME>/skills`（默认 `~/.mmp/skills`，和 `mmp.json` 同级）；
- 被信任项目的 `.mmp/skills`（信任规则与 `.mmp/mmp.json` 一致——项目如果没有 `.mmp/mmp.json`，就不算 MMP 项目，其 `.mmp/skills` 也不会被发现，`--approve` 也不例外）。

永远不会读取 Pi 自己的 Skill 目录（`~/.pi/agent/skills`、项目 `.pi/skills`），也不读取项目的 `.agents/skills`（不是用户为 MMP 选定的目录）。`<MMP_HOME>/pi` 是 MMP 存放 Pi 运行状态（登录凭据、会话、模型目录、设置）的目录，不是 Skill 目录；三个自动发现的目录解析符号链接后，如果落在它或 `~/.pi` 里面、或者是它们的上级目录，本次运行直接报配置错误。自动发现的目录和 Manifest 声明的目录一样，以显式绝对路径传给 Pi；canonical path 与已声明的 Skill 相同时去重，声明的一方保留其 source/declaredIn。`mmp --dry-run`、`/mmp`、启动页和 `mmp list` 都会标注每个自动发现 skill root 的来源（`discovered: agents` / `discovered: mmp` / `discovered: project`）。

Manifest 修改后：

- `/reload` 会重新解析并严格校验 Manifest，然后在当前进程中重新加载 Rules 与 Skills；即使启动时尚未创建 `mmp.json`，创建后执行 `/reload` 也会生效。
- Extension 的选择在进程启动时装配；修改 Manifest 的 `extensions`、Hooks 配置或 Task Agent profile 后必须重启 MMP。
- 已启用 `mmp:mcp` 时，修改 `mcp.json` 后可用 `/reload` 重新读取配置并重建连接；首次添加或移除 `mmp:mcp` 仍需重启。
- `/mmp` 显示当前实际生效的资源清单。Manifest 输入字段只有 `version`、`rules`、`skills`、`extensions`；`skillRoots`、`declaredResources` 等仅为运行时报告字段。

## Task

在 Manifest 声明 `mmp:task` 后，可用工具：

```text
task
task_status
task_wait
task_cancel
todo
```

Agent profile 放在 `~/.mmp/agents/<name>.md`；可信项目可用 `<repo>/.mmp/agents/<name>.md` 按名称覆盖全局 profile：

```markdown
---
name: reviewer
description: Reviews one bounded code change
model: openai/gpt-4o-mini
tools: read,grep
timeoutSeconds: 600
---

Review only the requested change. Return findings with file and line evidence.
```


字段约束：

- `name`：`^[a-z][a-z0-9-]{0,63}$`，目录内唯一。
- `description`：必填非空字符串。
- `model`：可选 `provider/model`；缺省时使用 Parent 当前模型。
- `tools`：可选逗号分隔字符串或字符串数组；未列出的工具不会进入 Child。
- `timeoutSeconds`：可选正整数，默认 `600`。
- frontmatter 后正文是 Child system prompt。

每个 Task Child 都是包内 `dist/worker.js` 启动的独立 Node.js process，使用固定 Pi SDK 和 in-memory Session；不会加载 `mmp:task`，因此不能递归派生 Task。Parent Session 退出时会取消并回收所有 Child。

## MCP

在 Manifest 声明 `mmp:mcp`，然后创建 `~/.mmp/mcp.json`（格式和 Pi 自己的 `mcp.json` 逐字一致，见 Pi 的 `docs/mcp.md`）：

```json
{
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  },
  "autoEnableCodemode": true
}
```

传输只有 stdio（`command`/`args`/`env`/`cwd`）和 streamable HTTP（`url`/`headers`/`oauth`）；不支持 SSE、unix socket。`${ENV_NAME}`/`$ENV_NAME` 在连接前展开，`!command` 执行子进程取值。可信项目的 `<repo>/.mmp/mcp.json` 在全局配置之后合并，同名服务项目覆盖全局。用 `mmp mcp add/remove/list/login/logout` 管理（见上面的子命令一节），或直接编辑文件后 `/reload`（要求当前进程已启用 `mmp:mcp`；修改 Manifest 的扩展选择需重启）。

模型默认通过 `codemode` 工具调用 MCP 服务（写 JS 脚本批量/串联调用，见 Pi 的 `docs/cli.md#how-codemode-works`），配了服务时 Pi 自动启用；某个服务想让模型直接看到，加 `"exposure": "direct"`（也可以用 `toolExposure` 按工具设置）。`/mcp` 打开 Pi 自己的管理面板（登录、重连、启用/停用、改曝光方式）；没有配置任何服务时显示 MMP 自己的提示，不是 Pi 的 `.pi/mcp.json`。

MMP 只决定读哪些配置文件（上面两份，从不读 Pi 自己的 `~/.mmp/pi/mcp.json` 或项目 `.pi/mcp.json`）和项目是否可信；连接、OAuth、工具注册、`/mcp` 面板全部是锁定 Pi SDK 内置的原生 MCP 支持（`createMcpExtension`），MMP 不再自带 MCP 客户端。凭据明文存在 `~/.mmp/pi/mcp-auth.json`（和 Pi 一样，不进系统钥匙串）。

## Hooks

在 Manifest 声明 `mmp:hooks`，然后创建 `~/.mmp/hooks.json`：

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

`timeoutMs` 默认 `10000`，最大 `300000`。超时、非零 command exit（错误信息包含退出码和一段 stderr 尾部）、spawn 失败（如 command 找不到）、非 2xx HTTP、超限输出、malformed JSON 和非法决策都视为 Hook 失败，错误信息会指出具体是哪个 Hook（event + 声明它的文件）和哪个 handler。阻断型 Pi 事件会 fail-closed；Session shutdown 会取消仍在运行的 handlers 并回收进程。`tool_call`/`tool_result` 失败通过对应 tool result 显示；没有 tool result 可用的事件（`session_start`、`user_prompt`、`session_before_compact`、`session_shutdown`）失败时会调用 Pi UI 通知，在 MMP 自己的界面和 Pi 的 `rpc` 模式下可见；Pi 的 `print`/`json` 模式没有可用 UI（Pi 的 `noOpUIContext`），这两种模式下同一条消息还会写到 stderr，确保失败不会安静地留下一个空回复。

HTTP `body`、`url`、`headers` 与 command `env` 支持 `${ENV_NAME}`。HTTP body 还支持事件模板：

```json
{
  "tool": "{{event.toolName}}",
  "cwd": "{{cwd}}",
  "event": "{{event}}"
}
```

完整占位符保留原 JSON 类型；嵌入字符串中的对象值会 JSON 序列化。

## Benchmark adapter

`scripts/benchmark-adapter.mjs` 是 MMP Core 外部的 trial adapter。它直接启动仓库内锁定的 Pi/MMP 入口，不读取 PATH 中的全局 `pi`；dataset、调度、计分规则仍由外部 runner 负责。

```bash
npm run benchmark -- \
  --variant mmp-full \
  --bundle /absolute/path/to/mmp-home-template \
  --output-dir /absolute/path/to/results/trial-001 \
  --cwd /absolute/path/to/clean-workspace \
  --model openai/gpt-4o-mini \
  --thinking off \
  --tools read,bash \
  --prompt-file /absolute/path/to/task.txt \
  --timeout-ms 600000
```

`--variant` 必须是 `pi-baseline`、`mmp-core-empty`、`mmp-rules-skills` 或 `mmp-full`。三个 MMP variant 的能力层级由传入的 bundle 内容决定；`pi-baseline` 直接运行同一依赖中锁定的 Pi（版本见 `package.json`），并关闭所有 ambient resource。

每个 MMP trial 会把 bundle 复制到独立的 `<output-dir>/mmp-home`；Pi baseline 只复制其中的 `pi/` settings/models。复制时排除 `.env*`、Pi auth/trust/session、旧 runtime capsule 和 artifacts；模型凭证必须通过 runner 环境变量注入。adapter 连续执行两次 MMP `--dry-run`，校验输出完全一致，并用规范化装配快照和实际参与 trial 的 bundle 文件 SHA-256 生成 `assemblyDigest`。

输出目录保留：

```text
request.json
assembly.json
assembly-fingerprint.json
preflight.stdout
preflight.stderr
events.jsonl
stderr.log
metadata.json
```

`events.jsonl` 是未改写的 Pi 事件流；`metadata.json` 记录版本、resolved model、时间、token/cost、tool error、压缩次数、进程/Session/capsule 泄漏检查和失败分类。退出码固定为：`0` 成功、`2` Harness/config、`3` infra/timeout、`4` model、`5` grader。可用 `--grader <executable>` 与重复的 `--grader-arg <value>` 直接传 argv；不经过 shell。

## 配置检查与故障定位

```bash
# 查看最终资源来源；不输出 Rule 正文或 secret
mmp --dry-run

# 明确忽略项目配置
mmp --no-project --dry-run

# 仅本次信任最近项目配置
mmp --approve --dry-run

# 仅本次拒绝项目配置
mmp --no-approve --dry-run

# 构建与契约测试
npm test
```

配置错误在 Pi Session 创建前退出，状态码为 `2`。运行时 Task/Hook/MCP 错误通过对应 tool result 或 Pi UI 通知返回；MMP 不做静默 fallback。
