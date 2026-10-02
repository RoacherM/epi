# MMP 定位与设计逻辑（初稿，待对齐）

状态：2026-10-02 初稿；同日部分对齐，见决策 H2：K1 选 A（不 fork），K2、K5 先不做（先做好外围，遇到瓶颈再考虑改 Pi 的行为），K7 按 D63 执行；K3、K4、K6、K8 待定。依据：决策 H1（长期方向参照 OMP）、OMP 研究笔记 [notes/omp-study.md](notes/omp-study.md)、现行 [development.md](development.md) §1–3 和 §17。对齐后并入 development.md，这份草稿删除。

标记说明：**[提议]** 是我建议的、需要你拍板的内容；其余是已经定下或已经实现的事实。

## 1. 一句话定位

**[提议]** MMP 是跟着官方 Pi 走的定制版 Pi：
- 内核用官方 Pi SDK，锁定版本，自动升级；
- 交互界面是 MMP 自己的 grok 风格界面；
- harness 能力参照 OMP 的设计，作为 Pi 扩展自己实现；
- 配置严格只属于 MMP。

和两个参照物的关系：

| | Pi | OMP | MMP |
|---|---|---|---|
| 和 Pi 的关系 | 上游 | 硬 fork，包全部改名，手工移植上游，最近一次同步在 2026-03 | 依赖官方包，不 fork；升级靠门禁自动化，现在已到 1.0.0 |
| 运行时 | Node | Bun + Rust | Node |
| 界面 | pi-tui 经典界面 | 自己的界面 | 在 pi-tui 组件上重写的 grok 风格界面 |
| harness | 最小：工具、MCP、扩展 | 很全：子 agent 中心、模型角色、审批、web、LSP、memory…… | 现在有 Task、Hooks、MCP 配置；以后补齐（见 §4） |
| 配置哲学 | `~/.pi`、`.pi/`，有项目信任 | 读 `~/.claude`、`.codex`、`.gemini` 等；没有项目信任；默认 yolo | `~/.mmp`、`.mmp/`，严格隔离，显式装配，需要信任 |

## 2. 不变的原则（现有硬规则，建议保留）

1. **功能优先对齐官方 Pi。** Pi 有的功能，MMP 的行为和 Pi 一致；有意的差异要记在文档里（例如 K1 Ctrl+P、D50 print 模式退出、D41 退出不留帧）。
2. **配置不和任何其他工具共享。** 不读 Pi，也不读 Claude、Codex、Gemini、Cursor 的配置；也不认用户给 Pi 设的 `PI_*` 环境变量（D63）。
3. **项目配置只有被信任才读。**
4. **失败要可见。**
5. **对外只有 mmp 自己的命令、参数、帮助和文案。** 不出现 `pi` 命令，也不出现 Pi 文档的链接。
6. **不往外发任何数据**，测试全部离线。
7. **用到的 Pi 内部接口都要登记并配测试**，升级门禁会抓住漂移。

## 3. 要改的边界

现行 development.md 里，有几条和"自建 harness"的方向冲突：

| 现行条目 | 问题 | **[提议]** 改成 |
|---|---|---|
| §3.1 "MMP 不重新实现……pi-tui renderer……" | 交互界面已经是 MMP 自己的了 | Pi 拥有：agent loop、provider/认证、session 格式、compaction、基础工具、MCP 协议栈、扩展生命周期。MMP 拥有：交互界面、配置装配和信任、**harness 层**（子 agent、模型角色、审批、额外工具、设置） |
| §3.3 "当前实现范围"列出的未纳入能力 | 这些写法像禁止项 | 改成"路线图候选"（§4），逐项设计后纳入 |
| §3.4 "未声明就不加载"（Task/MCP/Hooks 要靠 Manifest 打开） | OMP 是开箱即用；MMP 现在要手动打开 | 见关键点 K4 |
| §17 非目标：Memory、自定义 compactor、OMP 配置兼容 | 部分和 H1 冲突 | 保留"OMP/Claude 配置兼容"为非目标；Memory 和 compactor 降为"暂不做" |
| docs/tui-design.md 开头的"草稿，还没写代码" | 已经过时 | 改为当前状态 |

## 4. harness 路线图候选

全部作为 Pi 扩展实现，只借鉴 OMP 的设计，不搬它的代码。

| 能力 | 价值 | MMP 现状 | OMP 参考 | 初步顺序 |
|---|---|---|---|---|
| web 搜索和抓取 | 实际使用中最大的缺口 | 没有 | `web_search`，读 URL 并提取正文 | 1 |
| 写文件后看 LSP 诊断 | 改完代码立即看到错误 | 没有 | `docs/lsp-config.md` | 2 |
| 子 agent 升级：结构化结果、Agent Hub（查看、引导、终止）、可选的 git worktree 隔离 | 已有 `mmp:task`，在它上面扩展 | 只有 task/status/wait/cancel | `docs/tools/task.md`、`docs/agent-hub.md` | 3 |
| 模型角色（smol / slow / plan）和回退链 | 子 agent 用便宜模型，规划用强模型 | 有 scoped models，每个 agent 可指定模型 | `config/model-roles.ts` | 4 |
| 审批分级（读 / 写 / 执行） | 现在没有审批，只靠 hooks 拦截 | 没有 | `docs/approval-mode.md` | 5（默认值见 K6） |
| 设置注册表：每个设置只声明一次，非法值报错可见 | 统一 `/settings`、Manifest 和环境变量 | `/settings` 照搬 Pi 的设置项 | `docs/config-usage.md` | 6 |
| Memory、compaction 链 | 价值待验证 | 用 Pi 的 compaction | mnemopi、snapcompact | 暂不做 |

明确不学 OMP 的地方：
- 读取其他工具的配置；
- 没有项目信任；
- 默认 yolo；
- 往外发数据（autoqa、install ID、公共中继）；
- 五十来个子命令和魔法关键词；
- 硬 fork、手工移植上游；
- 依赖 Bun 和 Rust。

## 5. 架构分层（提议后）

```
mmp CLI（只暴露 mmp 自己的面）
 ├─ 配置装配：~/.mmp + 受信任的 .mmp → Manifest → 资源（rules / skills / extensions）
 ├─ 交互界面：src/tui（grok 风格，基于 pi-tui 组件）
 ├─ harness 层：src/extensions/*（task、hooks、mcp 接入；以后加 web、lsp、roles、approval……）
 └─ 官方 Pi SDK（锁定版本）：agent loop、provider、session、工具、MCP runtime、扩展生命周期
```

分别由谁决定：
- **代码**：装配、信任、隔离（硬规则）。
- **模型**：要不要调用 harness 的工具。
- **用户**：Manifest 和 `/settings`。

## 6. 需要对齐的关键点

每条都给了我的建议。你回复编号和选择就行，例如"K4 选 B"。

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| K1 ✅ A | 和 Pi 的关系 | A. 继续用官方 SDK、不 fork；B. 像 OMP 那样 fork | **A**。OMP 的 fork 已经落后上游半年；我们的升级门禁这次一天内就把 1.0 接上了 |
| K2 ⏸ 先不做 | §3.1 的边界 | A. 照第 3 节的表改：界面和 harness 归 MMP，内核归 Pi；B. 保持现状 | **A** |
| K3 | 配置哲学 | A. 保持严格（不读别家配置，显式装配，要信任）；B. 学 OMP 自动发现 | **A**。以后需要的话，可以加一个显式的一次性导入命令（例如 `mmp import claude`） |
| K4 | 内置能力要不要默认开 | A. 维持"在 Manifest 里声明才开"；B. 一组"标准能力"默认开（Task、MCP、web……），在 Manifest 里可以关掉；C. 用 profile 选择 | **B**。开箱即用更接近 OMP 的体验，也仍然显式、可关，failures 照样可见 |
| K5 ⏸ 先不做 | 路线图顺序 | 第 4 节的 1 到 6 | 按表里的顺序，web 和 LSP 先做 |
| K6 | 审批默认值 | A. 和 Pi 一样不审批；B. 只在写和执行时审批；C. 学 OMP 默认 yolo、提供分级 | **A**，先把分级机制做出来，默认值以后再定；理由是对齐 Pi |
| K7 | 环境变量 | 统一用 `MMP_*`，不认用户的 `PI_*` | 已按你的决定在做（D63） |
| K8 | 文档整理 | 对齐后并入 development.md §1–3、§17，改 tui-design.md 的开头，删掉这份草稿 | 照做 |
