# Make My Pi

> Compose Pi your way.

MMP (Make My Pi) 是基于固定版本 Pi SDK 的显式、确定性 Harness。它复用 Pi 的 Agent Loop、模型、认证、Session、TUI、基础工具和 Auto Compact；MMP 只负责配置装配、项目信任、Task、MCP 与 Hooks。

当前固定版本：

- Node.js `>=22.19.0`
- `@earendil-works/pi-coding-agent@0.87.1`
- `pi-mcp-adapter@2.38.0`

MMP 不调用 PATH 中的 `pi`，也不自动读取 `~/.pi/agent`、`.pi/`、`.agents/`、`AGENTS.md` 或 `CLAUDE.md`。所有 Harness 资源必须在 MMP Manifest 中显式声明。

## 安装

要求 Node.js `>=22.19.0`。推荐使用版本固定的安装器：

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://github.com/RoacherM/mmp/releases/download/v0.1.4/install.sh | sh
```

安装器检查 Node.js/npm，验证发行包的 SHA-256 后再执行全局安装，不会自动使用 `sudo`。不希望把脚本直接交给 shell 时，可以先下载并审阅 `install.sh`。

### 试用新界面（开发中）

```bash
MMP_TUI=v2 mmp
```

这是按 grok-build 重写的交互界面，还在开发中，默认仍是经典界面。目前能做的：全屏界面、MMP 启动页、对话和流式输出、工具调用、Esc 中止、Ctrl+C / Ctrl+D 退出、扩展的对话框和面板（`select`、`custom` 等）、`/new`、`/quit`。还不能做的：`/login`、`/model`、`/resume` 等 Pi 内置命令、`!` bash、grok 样式的消息块（目前沿用 Pi 的组件）。第一次使用请先用经典界面 `/login` 登录一次，两种界面共用 `~/.mmp/pi` 里的登录信息。

### 升级

```bash
mmp update
```

`mmp update` 查询 GitHub 上最新的 Release；有新版就下载该版本的 `install.sh` 并运行，安装器同样会校验 SHA-256。交互模式每天最多检查一次新版本（后台进行，超时 3 秒），有新版时在底栏显示 `Update available! … Run: mmp update`。检查结果缓存在 `~/.mmp/update-check.json`，检查失败时错误也记在这里。非交互模式、`--offline`、`PI_OFFLINE`、`CI` 环境下不检查；设置 `MMP_DISABLE_UPDATE_CHECK=1` 可以完全关闭。MMP 会关掉 Pi 自带的更新提示，因为它提示的 `pi update` 不会更新 MMP 锁定的 Pi。MMP 不做后台自动安装。安装器不会自动使用 `sudo`：如果当初是装在需要 root 权限的全局目录里，`mmp update` 会失败退出，需要按当初的方式手动重装。

也可以直接通过 npm 安装同一个 GitHub Release：

```bash
npm install --global \
  https://github.com/RoacherM/mmp/releases/download/v0.1.4/mmp-0.1.4.tgz
mmp --version
```

Release 包含已构建的 `dist/`，安装时只获取运行时依赖；不要求本机预装 TypeScript，也不要求 PATH 中存在全局 `pi`。

从源码开发或修改 MMP：

```bash
git clone https://github.com/RoacherM/mmp.git
cd mmp
npm ci
npm run build
npm test
npm link
```

版本检查应输出：

```text
mmp 0.1.4
pi 0.87.1
```

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

# 启动 Pi TUI
mmp --model openai/gpt-4o-mini
```

MMP 自有参数：

| 参数 | 行为 |
|---|---|
| `--dry-run` | 校验完整装配并输出无 secret 的 JSON；不启动 Pi 或 Extension |
| `--no-project` | 完全禁用项目 `.mmp` 发现 |
| `--approve` | 本次运行信任最近的项目 `.mmp/mmp.json`。只作用于 MMP，不会转给 Pi；项目里的 `.pi/` 始终不读 |
| `--no-approve` | 本次运行忽略项目配置 |
| `--version` | 输出 MMP 与固定 Pi 版本 |
| `update` | 子命令，只能单独使用：安装最新的 MMP Release（见“升级”） |

其余模型、Session、工具和输出参数原样交给 Pi 0.87。Rules、Skills 与 Extensions 只能通过 Manifest 配置；ambient Themes、Prompt Templates、Context Files 与 `SYSTEM.md` / `APPEND_SYSTEM.md` 固定关闭。相关 Pi resource flags（例如 `--extension`、`--skill`、`--system-prompt`、`--no-context-files`）直接传入会 fail-fast。

如需隔离配置，设置绝对路径：

```bash
MMP_HOME=/absolute/path/to/mmp-home mmp --dry-run
```

## 配置布局

全局配置默认位于：

```text
~/.mmp/
├── mmp.json             # 全局 Manifest
├── RULES.md             # 示例 Rule，由 Manifest 显式声明
├── skills/              # 示例 Skill 目录，由 Manifest 显式声明
├── agents/*.md          # mmp:task 与 agent Hook 使用的 Agent profile
├── mcp.json             # mmp:mcp 配置
├── hooks.json           # mmp:hooks 配置
└── pi/                  # MMP 独立的 Pi auth/settings/sessions/trust
```

项目配置使用最近的祖先目录：

```text
<repo>/.mmp/
├── mmp.json
├── agents/*.md
├── mcp.json
└── hooks.json
```

项目文件只有在统一 Project Trust 决策为可信后才会读取。`--approve` 与 `--no-approve` 是本次运行覆盖；要长期信任某个项目，在 `mmp` 里用 `/trust` 保存，重启后生效。`--no-project` 连发现都禁用。先执行 `mmp --dry-run` 可核对 `projectDiscovery`、`trusted`、`loaded` 与每项资源的 provenance。

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

Manifest 修改后：

- `/reload` 会重新解析并严格校验 Manifest，然后在当前进程中重新加载 Rules 与 Skills；即使启动时尚未创建 `mmp.json`，创建后执行 `/reload` 也会生效。
- Extension 的选择与配置在进程启动时装配；修改 `extensions` 或 MCP/Hooks/Task 配置后必须重启 MMP。
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

在 Manifest 声明 `mmp:mcp`，然后创建 `~/.mmp/mcp.json`：

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["/absolute/path/to/server.mjs"],
      "env": {
        "SERVICE_TOKEN": "${SERVICE_TOKEN}"
      },
      "lifecycle": "eager",
      "requestTimeoutMs": 30000
    }
  },
  "settings": {
    "hostConfigDiscovery": "off",
    "mcpFooterStatus": "off"
  }
}
```

每个 server 必须且只能声明一个 transport：`command`、`socket` 或 `url`。`${ENV_NAME}` 在启动前展开；缺失变量 fail-fast。可信项目的 `<repo>/.mmp/mcp.json` 在全局配置之后合并。MMP 只负责校验和装配，MCP transport、OAuth、连接生命周期、tool discovery/call 与进程回收由固定的 `pi-mcp-adapter@2.38.0` 提供。

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

`timeoutMs` 默认 `10000`，最大 `300000`。超时、非零 command exit、非 2xx HTTP、超限输出、malformed JSON 和非法决策都视为 Hook 失败。阻断型 Pi 事件会 fail-closed；Session shutdown 会取消仍在运行的 handlers 并回收进程。

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

`--variant` 必须是 `pi-0.87-baseline`、`mmp-core-empty`、`mmp-rules-skills` 或 `mmp-full`。三个 MMP variant 的能力层级由传入的 bundle 内容决定；`pi-0.87-baseline` 直接运行同一依赖中的 Pi `0.87.1`，并关闭所有 ambient resource。

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
