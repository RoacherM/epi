# TUI 内代码审查：从 Mayoi 借鉴的升级提案

状态：**待评审提案**，不是已经实现的 `/review` 命令。用户目标是在 Epi TUI 看代码审查，不打开另一个应用。Mayoi 的已实现能力与 Epi 的新建议分开；源码及 probe 见 [trace-review-probes.md](notes/trace-review-probes.md)。

## 1. 推荐方向

在现有 `/preview` 上增加审查能力：连续看多个文件的 diff，展开上下文，记录与版本绑定的本地批注，最后将批注整理到对话草稿交给 agent。

建议用 `/review` 作为直接进入审查的入口，复用 preview 的 diff/文件查看能力；命令名称尚未由用户确认。不引入外部编辑器或 Web 页面。保留 `/preview` 的文件浏览和媒体查看用途。

Mayoi 值得学的是阅读组织：多文件一页、文件头固定、跨 hunk/文件跳转、可展开 gap、按视口加载。未发现其批注/AI review 实现证据，后两项不能声称来自 Mayoi。

## 2. 界面：优先让代码有足够宽度

全屏覆盖对话，主体是连续统一 diff。顶部显示**比较的两个版本**和工作区变化状态；底部显示文件/hunk 位置、批注数和快捷键。默认不常驻文件树、agent 日志或三栏。

```text
 Review · Index → 工作区快照 · 4 files · +128 −31       2 notes

 src/agent.ts                                      +24 −8
 @@ -81,6 +81,12 @@
    81   81   const result = await runTool(call);
 -  82        return result;
 +       82   if (!result.ok) throw new ToolError(result);
 +       83   return result.value;
              ◇ N1 这里需要保留原始错误信息。

              … 48 unchanged lines · Enter 展开

 test/agent.test.ts                                  +61 −0
 …

 ]c/[c 改动 · ./, 文件 · c 批注 · / 搜索 · Esc 返回
```

建议交互：

- `j/k` 或方向键选行，PageUp/PageDown 翻页，`]c/[c` 沿用 Epi 的改动块跳转。
- `.` / `,` 下一/上一个文件；文件头可折叠；文件选择器临时打开，选完回连续 diff。
- gap 按 Enter 原地展开上下文，再按可收起；`d` 看完整文件，返回保留原 hunk 和滚动位置。
- `c` 对当前行或范围写批注；由 TUI 多行编辑器输入，保存为本地草稿。批注列表可修改、删除。
- `m` 标记文件已读；对应快照内容变动后变成“需重看”，不永久沿用旧勾选。
- `R` 刷新审查快照；有变动先显示变更提示；旧批注保留来源、重新检查锚点。
- “带回对话”把批注打包成草稿，保留原草稿，不自动发送或自动触发模型。

80–120 列以统一 diff 为主。只有代码区两边各能放至少 80 列时，才自动并排；用户可手动切布局。批注编辑时临时用下方或整页，避免把代码压成两条窄列。

## 3. 基线必须显式

已有 ChangeLedger 是**首次工具触碰前快照**；不是 Git HEAD、不是 session 启动时的全部文件快照。它只捕获 write/edit，因此 bash 改的文件不完整；右侧读取当前磁盘，也可能混入外部变更。

| 来源 | old | new | 能说明什么 |
|---|---|---|---|
| 现有会话账 | 首次 write/edit 触碰前 | 该文件读入时的磁盘快照 | 已捕获路径的差异，不保证全仓完整或独占 agent 归因 |
| 现有上一轮账 | 最近 agent_start 期间首次触碰前 | 磁盘快照 | 延续现有 preview 定义；重试可能另算一轮 |
| Git 未暂存 | Index | Working Tree 快照 | 包含 shell 和外部编辑，不归因于某个 agent |
| Git 已暂存 | HEAD | Index 快照 | 即将提交到 index 的内容 |
| Git 分支审查（后续） | 固定 merge-base SHA | 固定目标 commit SHA | 分支已提交变化；不偷偷混进未提交内容 |

未跟踪文件单列为新增候选，明确“未跟踪”；Git diff 本身不会列出它们。重命名保存 oldPath/newPath；二进制、symlink、submodule、冲突、纯权限变化、无首个提交的仓库有各自说明，不强行当普通文本。

P5 已实测同一文件同时为 staged/unstaged、空格重命名、未跟踪与二进制条目。尚未 probe 完整 Git loader 的冲突/子模块等边界，正式实现必须补齐。

Git 读取采用 argv 数组、机器输出（如 porcelain v2 -z），以 NUL 分隔路径；disable external diff/textconv，不通过用户配置的程序渲染差异。错误和不存在的版本要区分。

## 4. 稳定审查快照与批注

agent 继续改文件时，阅读中的 diff 不自动重排，顶部显示“工作区已有新变化”。用户刷新后更新快照；这与现有 preview 的实时查看是不同目的，两个模式可并存。

大仓库采用按文件的不可变快照：打开审查时将 Git revision 解析为固定 commit SHA；对 Index 一次读取并保存路径→blob OID/mode/stage 的清单（例如 `git ls-files --stage -z`），之后旧侧按该 OID 读取，不能再次按“当前 Index”读取。只有一个 Index 哈希不足以恢复旧内容。冲突 stages 不折成单一旧版本；对象后来不可读时显示快照失效，不能偷偷换版本。

工作区文件在接近视口时读取；每个文件记录读入内容哈希和读取时刻。未读文件只列为候选，不能声称已经保存了打开审查那一刻的内容。整体工作区不是原子快照；刷新/导出前复核变化，不能宣称所有文件来自同一个物理瞬间。

审查比较以原始内容为准，再为终端做可见字符处理。可以复用现有 diff 的绘制与导航，但不能直接沿用 `displayLines()` 先统一 CRLF、Tab 再判断差异的流程。纯格式差异也必须显示；暂时没有细粒度表示时，至少列出“存在换行符/空白/结尾换行差异”，不能显示无变化。原始哈希负责版本身份，不能替代正确的 diff。

批注至少记录：

```ts
interface ReviewNote {
  id: string;
  sessionId: string;
  branchAnchor: string;
  source: string;              // ledger / git-index / git-worktree …
  oldPath?: string;
  newPath?: string;
  oldHash?: string;            // 原始字节/文本摘要，不是格式化后的 diff
  newHash?: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  quote: string;               // 选中片段及有限上下文
  text: string;
  state: 'draft' | 'stale' | 'delivered';
}
```

删除行锚定 old 侧，不能塞成不存在的新行号。P5 的插行案例证明，仅保存 path+line 会错误定位。刷新后基于内容/上下文尝试关联：唯一匹配才提示新位置；多处匹配或片段消失标 stale，让用户选择，不静默贴到另一行。

本地批注可以用 Pi custom entry 保存，不进入模型上下文；编辑保存为追加修订，当前分支重放得到状态。追加会真实推进 leaf，并非不改变会话树。建议明确继承规则：只恢复当前分支祖先链上可达的批注；在批注之前分叉不继承之后的批注，已弃分支的批注不自动合并回来。保存只在对应 session/branch generation 仍有效时发生；不改写原消息或原 parentId，不通过批注触发 prompt/continue。恢复、分叉、重载和磁盘耐久性必须单独验证。这是提案，第一阶段可先只读浏览，批注另一个完整切片实现。

“带回对话”的包包含：比较来源、版本/哈希、路径、旧/新侧行范围、引用片段、用户意见、过期状态。进入 composer 后由人决定提交；运行中提交沿用现有 follow-up/steering 语义，不自动开审查 agent。

## 5. 与 /trace 的关系

两个入口共享定位方式：选对象 → 看详情 → 返回原位置。它们分别回答不同问题：

- `/trace`：当时发生了什么、参数结果是什么、花了多久。
- `/review`（建议名）：选定两个版本之间，代码具体变了什么、哪些地方需要反馈。

轨迹中的编辑可跳到“该步骤记录的 diff”；没有历史 diff 就只能打开当前文件，并标“当前工作区”。审查视图可在有确定 entry/toolCall 关联时跳回轨迹；Git 范围内的其他改动无关联时写“来源未归属”，不猜。

建议跨视图定位携带 session identity、branch anchor、entry/toolCall identity 或 review snapshot identity、path、side、line；退出返回原位置。不要先造一个全局工作区管理器；先提供这两个页面真正需要的窄入口，保持内置/第三方同等接口原则。

## 6. 最小实现顺序

1. **连续阅读**：复用现有 diff 的绘制/导航，先确保原始差异不被显示规范化吞掉；在 preview 加多文件连续视图、展开 gap、文件/hunk 跳转与返回定位。视觉和阅读效率可以先验收。
2. **明确比较来源**：Git staged/unstaged/untracked loader 与 ledger source 并列，快照/更新提示、二进制等边界。不能把所有差异都叫“本轮 agent 修改”。
3. **批注反馈**：锚点、保存、stale 检查、已读状态、打包到对话草稿。自动发送/AI 审查/暂存/丢弃不随此切片加入。
4. **轨迹联动**：只关联确实有身份的步骤/文件版本；完整子代理轨迹后续单独设计。

以上是建议顺序，不是已授权生产实现。当前用户要求先理解需求和 probe，故只落研究和方案。

## 7. 状态与验收

| 状态 | 失效/处理 |
|---|---|
| 比较来源与固定 revision | 用户换来源重建；HEAD/index 变化提示，不替换旧基线 |
| 文件快照/hash | 明确刷新才替换；失败显示错误，不变空文件 |
| row/hunk/file 选择 | 用文件身份和旧/新行锚点，不用绘制行号；resize 保位 |
| gap/文件折叠与布局 | 局部视图状态；切换统一/并排后保留语义位置 |
| 批注与已读标记 | 随快照版本校验；变化变 stale/需重看 |
| 异步读取/diff 工作 | source generation 过期即丢弃旧返回，不覆盖新来源 |
| 返回轨迹位置 | session/branch 仍一致才恢复；不存在则可见提示 |

验收覆盖：连续跨文件导航、可逆展开、40/80/120/180 列、旧侧删除行、CJK/Tab/CRLF/无结尾换行、超长文件、磁盘外部改动、相同大小内容替换、重命名与空格/换行路径、无 Git/无 HEAD、异常读取、批注保存与过期、运行中带回草稿、切会话/重载/分支、关闭页回收订阅。

当前已通过的是研究报告列出的 probe，尚未实现或验证上述完整审查功能。

## 8. 已实现第一版（2026-10-15）

已实现：多文件连续统一 diff（文件头、每文件 +/−、文件折叠）、gap 原地展开与收起、]c/[c 跨文件改动跳转、. 与 , 文件跳转、m 已读标记（绑定版本哈希）、c 行内批注（记录旧或新侧、两侧哈希、引用文本）、R 刷新并重新关联批注（唯一匹配才改位置，否则标 stale）、B 把批注打成草稿放回 composer（不自动发送）、s 在 ledger、unstaged、staged 三种来源间切换、按视口加载（未到的文件只画文件头）。批注以 custom entry `epi.review.note.v1` 随会话保存，重载时只从当前分支祖先链恢复。

尚未实现：并排 diff（当前只有统一 diff；40/80/120/180 列与 CJK/Tab/CRLF 的完整验收未跑）；从 git revision 冻结 blob 的不可变快照（当前在打开与 R 时按当时磁盘读取）；d 打开完整文件；批注的多行编辑器与修改/删除；跨视图回到轨迹；子模块、symlink、权限位等边界。
