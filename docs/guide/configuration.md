# 配置

[← 文档索引](README.md)

## 和 Pi 的隔离

Epi 不调用 PATH 中的 `pi`，使用独立的 `~/.epi/pi` 运行目录，不继承 `~/.pi/agent` 的配置。Rules 与 Extensions 由 Epi Manifest 显式声明；Skills 还会从三个固定目录自动发现（见下面的 [Manifest](#manifest)）。Epi 不自动加载项目 `.agents/`、`AGENTS.md` 或 `CLAUDE.md`。

所有模式都不读取项目的 `.pi/settings.json`（0.1.9 起；此前非交互模式在启动查找会话时会读取，见 [决策 N1](../decisions.md)）。

## 配置布局

全局配置默认位于：

```text
~/.epi/
├── epi.json             # 全局 Manifest
├── RULES.md             # 示例 Rule，由 Manifest 显式声明
├── skills/              # 自动发现（也可额外被 Manifest 显式声明）
├── agents/*.md          # epi:task 与 agent Hook 使用的 Agent profile
├── mcp.json             # epi:mcp 配置
├── hooks.json           # epi:hooks 配置
└── pi/                  # Epi 独立的 Pi auth/settings/sessions/trust
```

项目配置使用最近的祖先目录：

```text
<repo>/.epi/
├── epi.json
├── skills/              # 自动发现，仅在项目可信时读取
├── agents/*.md
├── mcp.json
└── hooks.json
```

项目文件只有在统一 Project Trust 决策为可信后才会读取。`--approve` 与 `--no-approve` 是本次运行覆盖。交互模式下第一次进入带 `.epi/epi.json` 且还没决定过的项目会弹出选择（信任 / 信任父目录 / 仅本次信任 / 不信任 / 仅本次不信任）；随时也可以在 `epi` 里用 `/trust` 改。两者都保存到同一个信任记录，重启后生效（Extensions 不能热加载）。`--no-project` 连发现都禁用；非交互模式（`-p`、`--mode json/rpc` 等）不会弹这个选择。先执行 `epi --dry-run` 可核对 `projectDiscovery`、`trusted`、`loaded` 与每项资源的 provenance。

## Manifest

`~/.epi/epi.json` 与 `<repo>/.epi/epi.json` 使用同一 schema：

```json
{
  "version": 1,
  "rules": ["./RULES.md"],
  "skills": ["./skills"],
  "extensions": [
    "./extensions/local-extension.ts",
    "npm:some-pi-extension@1.2.3"
  ],
  "disable": ["epi:hooks"]
}
```

规则：

- 只允许 `version`、`rules`、`skills`、`extensions`、`disable`；未知字段直接失败。
- 相对文件路径相对声明它的 Manifest 解析，并转换为 canonical absolute path。
- Global 资源先装配，可信 Project 资源后装配；相同 canonical path 去重。
- 内建能力只有 `epi:task`、`epi:mcp`、`epi:hooks`，**默认开启**（没有 `epi.json` 或 Manifest 为空也一样）。要关掉某个，把它写进 `disable`；关掉的能力不读它的配置文件（`mcp.json`、`hooks.json`、`agents/`），也不启动子进程，工具和 handler 都不存在。
- `disable` 只接受这三个名字，其他值是配置错误（报出是哪个文件）。全局和可信项目的 `disable` 取并集：任一文件关掉就是关掉，即使另一个文件在 `extensions` 里列了它（例如全局列了 `epi:task`、项目 `disable` 了它，结果是关）。未信任的项目不会被读取，它的 `disable` 也不生效。
- 在 `extensions` 里列内建能力仍然有效（旧配置不用改），只是多余；同一个文件里既在 `extensions` 又在 `disable` 列同一个名字是配置错误。
- 默认开启的能力没有配置时没有可见变化：没有 `mcp.json`（或一个服务都没有）时 `epi:mcp` 不给模型加任何工具或提示词；没有 `hooks.json` 时 `epi:hooks` 什么都不做。`epi:task` 会给模型加上 `task`、`task_status` 等工具。
- 内建能力开启时，它的配置文件写错会让启动失败（状态码 `2`），报错会说明可以改正文件，或用 `disable` 关掉这个能力。
- 外部 Extension 可使用本地路径、`npm:` 或 `git:` source；Epi 仍关闭 Pi 的 ambient discovery。

Rules 按装配顺序拼接到 Pi system prompt。Skills 使用 Pi 的 `SKILL.md` 格式，并通过绝对路径显式加载。

除 Manifest 声明的 Skill 路径外，Epi 还会自动发现三个固定目录（缺失时跳过，不报错）：

- 全局 `~/.agents/skills`（跨 Agent 通用约定目录）；
- Epi 自己的全局 `<EPI_HOME>/skills`（默认 `~/.epi/skills`，和 `epi.json` 同级）；
- 被信任项目的 `.epi/skills`（信任规则与 `.epi/epi.json` 一致——项目如果没有 `.epi/epi.json`，就不算 Epi 项目，其 `.epi/skills` 也不会被发现，`--approve` 也不例外）。

永远不会读取 Pi 自己的 Skill 目录（`~/.pi/agent/skills`、项目 `.pi/skills`），也不读取项目的 `.agents/skills`（不是用户为 Epi 选定的目录）。`<EPI_HOME>/pi` 是 Epi 存放 Pi 运行状态（登录凭据、会话、模型目录、设置）的目录，不是 Skill 目录；三个自动发现的目录解析符号链接后，如果落在它或 `~/.pi` 里面、或者是它们的上级目录，本次运行直接报配置错误。自动发现的目录和 Manifest 声明的目录一样，以显式绝对路径传给 Pi；canonical path 与已声明的 Skill 相同时去重，声明的一方保留其 source/declaredIn。`epi --dry-run`、`/epi`、启动页和 `epi list` 都会标注每个自动发现 skill root 的来源（`discovered: agents` / `discovered: epi` / `discovered: project`）。

Manifest 修改后：

- `/reload` 会重新解析并严格校验 Manifest，然后在当前进程中重新加载 Rules 与 Skills；即使启动时尚未创建 `epi.json`，创建后执行 `/reload` 也会生效。
- Extension 的选择在进程启动时装配；修改 Manifest 的 `extensions`、`disable`、Hooks 配置或 Task Agent profile 后必须重启 Epi。
- 已启用 `epi:mcp` 时，修改 `mcp.json` 后可用 `/reload` 重新读取配置并重建连接；关掉或重新打开 `epi:mcp` 仍需重启。
- `/epi` 显示当前实际生效的资源清单：开启的内建能力在 `inlineExtensions`（默认开启的标 `"source": "default"`，没有 `declaredIn`），被关掉的在 `disabledExtensions`（带关掉它的文件）。`epi --dry-run` 和 `epi list`（"Built-in capabilities:" 一段）也显示同样的信息。Manifest 输入字段只有 `version`、`rules`、`skills`、`extensions`、`disable`；`skillRoots`、`declaredResources` 等仅为运行时报告字段。

## 内置模型 provider

Epi 自带 `magpie` provider，默认连接本机 `http://127.0.0.1:3425`，自动发现模型并按模型选择协议。它不需要 Manifest 扩展声明，也不是 `disable` 中的第四个能力。唯一的配置是 API key，用 `/login` → Sign in with an API key → Magpie 保存；详见 [Magpie](magpie.md)。模型列表保存在 Epi 独立的 `pi/models-store.json`。

## 配置检查与故障定位

```bash
# 查看最终资源来源；不输出 Rule 正文或 secret
epi --dry-run

# 明确忽略项目配置
epi --no-project --dry-run

# 仅本次信任最近项目配置
epi --approve --dry-run

# 仅本次拒绝项目配置
epi --no-approve --dry-run

# 构建与契约测试
npm test
```

配置错误在 Pi Session 创建前退出，状态码为 `2`。运行时 Task/Hook/MCP 错误通过对应 tool result 或 Pi UI 通知返回；Epi 不做静默 fallback。
