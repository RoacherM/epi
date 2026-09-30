# mmp 端到端验收清单

状态：2026-09-30 第一版（用户要求："沉淀一套端到端的测试文档和预期结果"）。

自动测试（`npm test`）用的是假模型和模拟终端，查不出真实终端里的问题。今天的两个 P1 都是这样漏掉的：Ghostty 的按键松开事件（D7），点击图片标签后快捷键失效（D8）。本清单是人（或主控通过 Herdr）用真实终端、真实模型逐条走的验收步骤，每条写明预期结果。

## 1. 什么时候跑

| 时机 | 跑哪些 |
|---|---|
| 升级工具版之前（[dev-workflow-herdr.md](dev-workflow-herdr.md) 第 2 节） | 标 ★ 的冒烟条目 |
| 大节点审查前（打审查包时附上结果） | 全部 |
| Pi 内核升级后 | 全部 |
| 修了某一块的 bug | 那一块的全部条目 |

## 2. 怎么跑

- **Herdr 路线**（主控可以自动走）：`P=<pane> source scripts/dev/herdr.sh`，用 `startmmp` / `say` / `key` / `scr` 操作。粘贴图片时用 `MMP_TEST_CLIPBOARD_FILE=<png>` 启动，不碰真实剪贴板。Herdr 发不出的原始按键序列用 `herdr pane send-text $'…'`。
- **Ghostty 路线**（标 🖐 的条目必须在这里跑）：直接在 Ghostty 窗口运行工具版。Ghostty 会发送 kitty 键盘协议的按下 + 松开事件，会渲染图片预览，还会读写真实剪贴板，这些 Herdr 都模拟不全。主控在 Herdr 里用 `send-text $'\e[118;5u'`（按下）加 `$'\e[118;5:3u'`（松开）可以近似，但最终以 Ghostty 为准。
- **测试项目**：`scratchpad` 下建一个目录，放 `.mmp/mmp.json`（声明 `mmp:mcp`）和 `.mmp/mcp.json`（两个测试服务：`test/fixtures/mcp-server.mjs`，一个默认曝光，一个 `"exposure": "direct"`）。
- **模型**：`--provider magpie --model claude/claude-sonnet-5-5 --thinking high`。
- **记录**：每次跑完写 `.dev/e2e/<日期>-<版本>.md`，每条一行：编号、通过/失败、失败时的现象和画面。失败的条目记进 [dogfood-issues.md](dogfood-issues.md)。

## 3. 验收条目

预期结果里的"对齐 Pi"指和 Pi 自己的交互界面行为一致；"对齐 grok"指和 grok-build 实测一致（[tui-design.md](tui-design.md)）。

### 3.1 启动和退出

| 编号 | 步骤 | 预期结果 |
|---|---|---|
| ★ S1 | 在测试项目里启动 | 启动页显示 `runtime Pi <版本>`、manifest/project 状态、resources 计数；底部输入框右下角显示模型名和 thinking 档位；没有报错 |
| S2 | 在一个没信任过、带 `.mmp/mmp.json` 的新目录启动 | 先问是否信任；选"信任"后记住，下次不再问 |
| ★ S3 | 空输入框按 Ctrl+D | 退出，回到 shell，终端恢复正常（没有残留画面、光标可见） |
| S4 | 输入框有字时按 Ctrl+D | 不退出（对齐 Pi） |
| S5 | 输入 `/quit` 回车 | 退出 |
| S6 | 空输入框、没有在运行时，快速按两次 Ctrl+C | 第二次退出；输入框有字时 Ctrl+C 只清空输入框（`src/tui/keys.ts` 的 `app.clear`） |

### 3.2 对话和工具

| 编号 | 步骤 | 预期结果 |
|---|---|---|
| ★ C1 | 发一句 "list the files here" | 出现 thinking 块（`Thought for Ns`），工具调用显示成 grok 风格的块，最后有回答和 `Worked for Ns` |
| C2 | 运行中按 Esc | 停止当前回合，提示已中止；输入框可以继续输入 |
| C3 | 运行中输入一句再按 Enter | 进入排队，显示在队列区；回合结束后自动发出 |
| C4 | 运行中输入一句再按 Alt+Enter | 作为 steer 插入当前回合 |
| C5 | 有排队消息时按 Alt+↑ | 排队消息放回输入框，队列清空 |
| C6 | 按 Ctrl+O | 工具块展开/折叠，按一次切换一次 |
| C7 | 按 Ctrl+T | thinking 内容展开/折叠，按一次切换一次 |
| ★ C8 | 按 Shift+Tab | thinking 档位切一档（右下角标签变化），按一次只切一档 |
| C9 | `!ls` 和 `!!ls` | `!` 的输出进入上下文，`!!` 的不进入（对齐 Pi） |

### 3.3 粘贴和图片标签（今天出问题最多的一块）

| 编号 | 步骤 | 预期结果 |
|---|---|---|
| ★ P1 🖐 | 复制一张截图，在输入框按 Ctrl+V | 出现**一个** `[Image #1]` 标签（D7 回归） |
| P2 | Cmd+V 粘贴一段 4 行以上的文字 | 折叠成 `[Pasted: N lines]` 标签（阈值 `MIN_PASTE_LINES = 4`，`src/tui/paste-chips.ts`），光标在标签后时显示预览浮窗 |
| ★ P3 🖐 | 贴一张图，鼠标**单击**这个标签，然后按 Shift+Tab、再按 Ctrl+V | Shift+Tab 能切档位，Ctrl+V 能再贴出 `[Image #2]`（D8 回归） |
| P4 | 贴图后接着打字、发送 | 用户消息块里显示文字和 `[Image #1]`；模型的回答说明它看到了图 |
| ★ P5 🖐 | 发送带图消息后，复制一张**新**截图，在下一条消息里按 Ctrl+V | 贴出新的图片标签，不是文字 |
| P6 | 剪贴板为空时按 Ctrl+V | 提示 "Nothing to paste: the clipboard holds no image or text." |
| P7 | 双击文字标签 | 展开成原文 |
| P8 | 光标在标签上按退格 | 整个标签一次删掉，不会删成半截 |
| P9 | 贴图后连按 Ctrl+Z 撤销 | 按顺序撤回，标签和内容一起撤回，不会互换 |
| P10 🖐 | 在对话区拖选一段文字 | 右下角闪 "Copied!"，剪贴板里是选中的文字（"选中即复制"，对齐 Pi 的默认设置）。注意：这会覆盖剪贴板里原来的图 |

### 3.4 斜杠命令

逐个执行，预期都是"不报错、行为对齐 Pi"，特别注意的写在后面：

`/model`（弹出选择器，Esc 关闭后快捷键仍然有效）、`/thinking`、`/new`（旧会话保存、新会话为空）、`/resume`（列表里能看到刚才的会话，选中后恢复内容）、`/tree`、`/fork`、`/clone`、`/name`、`/session`、`/compact`（显示 "Compacting…"，结束后上下文用量下降）、`/reload`、`/trust`、`/copy`、`/export`、`/import`、`/hotkeys`、`/scoped-models`、`/share`、`/changelog`、`/bug`、`/login`、`/logout`、`/mcp`。

| 编号 | 步骤 | 预期结果 |
|---|---|---|
| ★ K1 | 打开任意弹窗（`/model`）再关掉，然后按 Shift+Tab、Ctrl+V | 快捷键仍然有效（焦点回到输入框） |
| K2 | 输入 `/` | 补全列表只有 mmp 的命令，没有 Pi 独有、MMP 不提供的命令 |

### 3.5 MCP 和 skills

| 编号 | 步骤 | 预期结果 |
|---|---|---|
| ★ M1 | 让模型分别调用两个测试服务的 echo | 默认曝光的服务通过 codemode 调用，嵌套调用只显示在 codemode 块里一次；direct 服务单独一个块；结果正确 |
| M2 | `/mcp` | 列出两个服务和状态；进入某个服务，路径显示的是 `.mmp/mcp.json` |
| M3 | 在 `/mcp` 里停用再启用一个服务 | 改动写回 `.mmp/mcp.json`，不出现 `.pi/` 目录；全部停用后 `/mcp` 仍能打开面板 |
| M4 | 退出后查进程 | 没有残留的 MCP 服务进程 |
| M5 | `mmp mcp list`（信任 / 不信任的项目各一次） | 信任时列出状态；不信任时提示 not trusted，不启动服务 |
| M6 | 输入 `/skill:` | 列出 `~/.agents/skills` 里的 skills |

### 3.6 命令行和非交互

| 编号 | 步骤 | 预期结果 |
|---|---|---|
| ★ N1 | `mmp -p "reply OK" </dev/null` | 输出 OK，退出码 0（注意要关掉标准输入，否则会一直等） |
| N2 | `mmp --mode json -p "hi" </dev/null` | 标准输出只有 JSON 事件 |
| N3 | `mmp --help`、`mmp mcp --help`、`mmp install --help` | 只出现 mmp 的名字和参数，没有 `pi` |
| N4 | `mmp --version` | 显示 mmp 版本和 Pi 版本 |
| N5 | `mmp -e x`、`--no-extensions` 等不提供的参数 | 报错并提示改 Manifest |

### 3.7 配置隔离（每次 Pi 升级必跑）

| 编号 | 步骤 | 预期结果 |
|---|---|---|
| I1 | 在临时 HOME 的 `~/.pi/agent/` 和项目 `.pi/` 里放 settings、skills、extensions、mcp.json，启动 mmp（交互和 `-p` 各一次） | 都不生效：模型、skills、扩展、MCP 服务都不出现 |
| I2 | 检查 `~/.pi/agent` | mmp 运行后没有被创建或修改 |

## 4. 已知不一致（还没修，跑的时候不算失败，但要留意）

| 编号 | 现象 | 状态 |
|---|---|---|
| D9 | Pi 0.99 会把图片缩放说明（`[Image: original WxH, displayed at …]`）追加到发给模型的文字里，MMP 的用户消息块把它原样显示出来，看起来像多了一行乱码 | 待定：建议界面上隐藏这类说明，模型照常收到 |
| D10 | Pi 0.99 新增的快捷键 MMP 还没接：切换模型（`app.model.cycleForward/Backward`）、上一条/下一条提示（`tui.altScreen.previousPrompt/nextPrompt`）、搜索（`tui.altScreen.search`） | 待排期 |
