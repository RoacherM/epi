# Pi 内核升级设计（草案）

日期：2026-09-29。状态：草案，待你拍板，还没写代码。

一句话目标：Pi 发新版后，MMP 自动完成升级和验证，人只在验证不通过、模型看到的内容变了、要对外发布这三种情况下介入；同时每个 MMP 发布版锁定的 Pi 版本仍然固定，安装结果可复现。

背景：这次从 0.83 升到 0.87（第 0 阶段）全是手工做的，包括改 3 个包的版本号、换掉不兼容的 MCP adapter、手工修改 8 个文件里的版本号、逐项核对资源隔离。Pi 的发布很频繁：0.84.0（8 月 6 日）到 0.87.1（9 月 22 日），7 周里发了 11 个版本，其中 4 个 minor 版本。

## 1. 三种做法

| 做法 | 说明 | 结论 |
|---|---|---|
| A. 放宽版本范围 | `package.json` 写 `^0.87` 之类，用户安装时拿到当时最新的 Pi | 不采用。用户从 tarball 安装时才解析版本，两个人会装到两个不同的 Pi。Pi 还在 0.x 阶段，minor 版本就会有破坏性变更：这次 0.84 起 pi-ai 删掉了 `complete`，MCP adapter 2.17.0 就加载不了了 |
| B. 版本仍然锁死，升级过程自动化 | 定时任务发现新版本后，自动把全部 Pi 包一起升级，跑一遍兼容性门禁，通过就开 PR，不通过就开 issue | **推荐** |
| C. 运行时用本机装的 Pi | MMP 不带 Pi，运行时去找已安装的版本 | 不采用。可复现性问题和 A 一样；而且 pi-coding-agent 自带 shrinkwrap，无论如何都会带上自己的 pi-tui（见 tui-design 3.2 节） |

B 的直接后果：用户只能通过 MMP 的新发布拿到新 Pi，所以 MMP 的发布频率会跟着上升，**发布自动化也是这个需求的一部分**（第 5 节）。

## 2. 流程

```
每天定时（GitHub Actions cron）
  │
  ├─ 检查 npm：pi-coding-agent 有没有新版本？没有就结束
  │
  ├─ 升级脚本（代码决定）
  │     新分支 → pi-coding-agent / pi-tui / pi-ai 升到同一个新版本
  │           → pi-mcp-adapter 的 peer 范围不包含新版本时，升到声明兼容的最新版
  │           → npm install
  │
  ├─ 兼容性门禁（代码决定，第 3 节）
  │     全部离线，不调用真实模型，不需要任何 API key
  │
  ├─ 通过 ──▶ 开 PR，附上门禁报告和"模型可见变更"摘要
  │           ├─ 模型可见内容没变 ──▶ 可以直接合并（是否自动合并由你定，U2）
  │           └─ 变了 ──▶ 标记"需要重跑 benchmark 基线"，等你决定（会花钱）
  │
  └─ 不通过 ──▶ 开 issue，列出失败的检查和对应的 Pi 变更

合并后 ──▶ 发布脚本（第 5 节）──▶ 新的 MMP 发布版
```

需要人介入的只有三处：门禁不通过；模型可见内容变了，要决定是否重跑基线；对外发布。以后可以再加一步，让 AI agent 在门禁不通过时先尝试修复，这里不展开设计。

## 3. 兼容性门禁

每一项都写明它能发现什么问题，以及这次 0.87 升级里的实际情况。

| 检查 | 能发现什么 | 这次升级的实际情况 | 现状 |
|---|---|---|---|
| 编译 + 类型检查 | Pi 导出接口的类型变了 | 通过 | 已有 |
| 全部测试（`npm test`） | 行为回归 | 发现 MCP adapter 加载失败、8 个文件的版本号写死 | 已有 |
| ambient 资源隔离 | Pi 新增的自动发现来源 | 手工从 CHANGELOG 找到 `AGENTS.override.md` 补进测试；`SYSTEM.md` / `APPEND_SYSTEM.md` 一直没被覆盖，今天才发现并修好 | 已改进（2026-09-30）：埋设的资源清单改为在测试里直接从安装好的 Pi 读取（`test/fixtures/pi-ambient-sources.mjs` 读 `trust-manager.js` 的 `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` 和 `resource-loader.js` 的 context-file 候选名单），不再手写；`test/ambient-isolation.test.mjs` 用它埋设。Pi 新增一种来源，测试就会自动覆盖；读取的位置本身登记在 `docs/pi-internals.md` |
| 配置隔离 | 项目 `.pi/settings.json`、`~/.pi/agent` 被读取 | 实测：启动阶段总会读项目设置；`--approve` 时运行阶段也生效（已修复） | 运行阶段已是正式测试（`test/ambient-isolation.test.mjs`）。启动阶段的读取还挡不住，只能在报告里记录 |
| MCP 离线验收 | adapter 和新 Pi 不兼容 | 正好能发现 `complete` 被删掉 | 今天新增（`test/mcp.test.mjs`，用 faux provider 按剧本调用） |
| 模型可见内容快照 | system prompt 和工具 schema 的变化 | 0.87 把 system prompt 改成了 `<tools>`、`<rules>` 这样的分段格式，没有任何测试发现 | 已实现（2026-09-30，`scripts/model-snapshot.mjs` + `test/snapshots/model-visible.json`）。用固定的离线装配（rules+skills+三个内置 Extension，全部能离线加载）跑一次 faux 模型，截获它实际收到的 system prompt 和工具声明；路径、cwd、MMP/Pi 版本号都做了归一化，两次运行逐字节相同。只报告、不判失败：`--diff` 恒定退出码 0，没变化打印 `NO MODEL-VISIBLE CHANGES`，变了打印统一 diff，提示需要重跑 benchmark 基线 |
| 启动契约 | `piMain` 路径和 SDK 路径给模型的内容不一致（新 TUI 之后才有两条路径） | — | 新增，随新 TUI 一起做（tui-design 3.1 节） |
| Pi 接口清单 | MMP 用到的 Pi 符号被删掉或改名 | — | 已实现（2026-09-30，`test/pi-interface-inventory.test.mjs`）。用 TypeScript 编译器 API 静态收集 `src/**/*.ts` 里所有从 `pi-coding-agent`/`pi-tui`/`pi-ai` import 的名字（含 `import type`/内联 `type`），值导入对已安装包的运行时导出断言存在，类型导入对其 `.d.ts` 的导出断言存在。门禁不通过时报告具体符号和引用它的文件 |
| Pi 内部依赖清单 | MMP 按文件路径深导入的 Pi 内部模块、私有字段/方法、或 Pi 自己嵌套安装的依赖，被移动/改名/删除 | — | 已实现（2026-09-30，`test/pi-internals.test.mjs` + `docs/pi-internals.md`）。见第 6 节：每处深耦合登记为文档里的一行，测试对每行做实际检查；还会扫描 `src/`/`test/fixtures/`/`scripts/` 里新出现的 `join(piDist, ...)` 深路径，没登记的直接判失败 |
| 复制代码的漂移 | 从 Pi 复制过来的代码，上游改了 | — | 新增（设计阶段，还没实现）。`vendor.json` 记录每个复制文件对应的上游路径、版本和哈希。升级脚本比较新旧两个版本的上游文件，一有变化就判失败，交给人看 |
| pi-tui 实例检查 | 顶层 pi-tui 和 Pi 自带的 pi-tui 版本不一致 | — | 新增。启动时也检查，不一致就直接报错 |
| 交互冒烟 | 交互界面起不来或崩溃 | 0.87 启动页正常；退出流程没能测到 | 已有脚本（`pty-smoke.py`），要修好退出步骤，再改写成正式测试 |

整套门禁都是离线的，因为 faux provider 可以代替真实模型。所以 CI 里不需要 API key，每次跑也不花钱。

## 4. 先消灭这次的手工步骤

这些是实现 B 之前就该做的，否则自动升级第一步就会卡住：

1. **版本号只保留一个来源。** 测试和夹具里写死的 `0.87.1` 全部改为读取已安装 Pi 的 `VERSION`。这次改了 8 个文件，以后不用再改。
2. **benchmark 变体名去掉版本号**：`pi-0.87-baseline` 改成 `pi-baseline`，版本记录在 metadata 里。
3. **文档里不写具体版本号**，统一写"见 `package.json`"，或者由发布脚本生成。
4. **MCP adapter 跟着升级**：升级脚本检查 adapter 的 peer 依赖范围，不包含新 Pi 时，自动换成声明兼容的最新版。

## 5. 发布自动化

**版本号谁来加。** MMP 的 patch 版本号在升级 PR 里就已经加好了：`scripts/pi-upgrade.mjs` 门禁通过后顺手把 `package.json`（和 `package-lock.json` 里对应的根版本号）加一个 patch 版本，这样这条 PR 本身就是"可发布"的（见第 8 节步 3）。`src/host.ts` 的 `MMP_VERSION` 在运行时直接读 `package.json`（单一来源，另一处并行改动），升级脚本不需要再改它。`scripts/release.mjs` 只读 `package.json` 里已经写好的版本号，自己不改版本号，也不提交任何东西。

**SHA-256 只算一次，仓库里不存哈希。** `install.sh` 在仓库里是一份模板，`MMP_VERSION` 和 `DEFAULT_PACKAGE_SHA256` 两处都是占位符（`__MMP_VERSION__` / `__MMP_PACKAGE_SHA256__`），从来不是真的版本号或哈希——直接跑这份模板会在 SHA-256 格式校验那一步就报错退出，不需要额外代码。真正的哈希只在发布时算一次：

1. 从 `package.json` 读版本号 `X`，tag 定为 `vX`；
2. tag 已存在（`git ls-remote --tags origin refs/tags/vX`）就跳过，直接结束——这样 `release.yml` 每次 push 到 main 都能安全地跑，不需要额外判断"是不是刚发布过"；
3. `npm pack --json` 打包出 `mmp-X.tgz`；
4. 用 `node:crypto` 对这个 tgz 算 SHA-256（不用 `npm pack` 自带的 `shasum`，那是 SHA-1）；
5. 把算出来的版本号和哈希填进 `install.sh` 模板的两个占位符，渲染到临时文件；
6. `gh release create vX <tgz> <渲染后的 install.sh> --generate-notes --target <commit>`：tag 由这一步顺带创建，不需要单独 `git tag` / `git push`，CI 也就不需要给 main 推任何提交。

`releases/download/vX/install.sh` 和 `releases/latest/download/install.sh` 都能拿到这份渲染好的文件（后者随最新 release 自动指向新版本，README 的一键安装命令用这个，不用每次发布改链接）；`mmp update`（`src/update.ts` 的 `installerUrl`）用的是前一种带具体版本号的地址，跟发布产物的命名对得上，不用改。

`gh` / `git` / `npm` 都是 `scripts/release.mjs` 里的可注入依赖（`exec` 参数），测试用假的实现驱动，不碰真实网络或真实仓库；`test/release.test.mjs` 验证「tag 已存在就跳过」「打包、算哈希、渲染 install.sh、发布」两条路径，`test/install.test.mjs` 额外验证「渲染后的 install.sh 能跑通完整安装流程」和「没渲染就跑会报错」。

对外发布是否需要你每次点一下，由你定（U2）：目前是"升级 PR 你点合并，合并后发布脚本自动跑"，`release.yml` 监听 push to main，跳过判断（tag 已存在）保证它不会重复发布。

**升级 PR 上没有 CI。** `pi-upgrade.yml` 用默认 `GITHUB_TOKEN` 开 PR 时，GitHub 不会为这个 PR 触发别的 workflow（包括 `ci.yml`），这是平台限制，不是 bug——升级脚本自己已经在开 PR 之前跑过完整门禁，所以这不影响正确性，只是那条 PR 页面上看不到绿色的 CI 勾。想要 PR 页面也有 CI，加一个 repo secret `PI_UPGRADE_PAT`（有 `contents:write` / `pull-requests:write` 权限的 PAT）：`pi-upgrade.yml` 已经写好 `secrets.PI_UPGRADE_PAT || github.token` 的兜底逻辑，不需要改代码，加了 secret 就自动生效，没加也能正常工作。

**供应链防护（pre-merge review 后加）。** 升级脚本会给一个几小时前刚发布、我们不掌控的上游包跑 `npm install`，这本身就是攻击面：

- `npm install` 固定加 `--ignore-scripts`（本地验证过：从零装依赖、`--ignore-scripts`、`npm run build`、跑满 507 个测试，全部通过——这个仓库的构建和测试不依赖任何包的 postinstall/install 脚本，包括 esbuild、fsevents、protobufjs 这几个真正带脚本的包）。
- adapter 的声明 peer 范围不包含新 Pi 版本时（见下），升级脚本会往 `package.json` 写一条 npm 原生的 `overrides`（`{ "pi-mcp-adapter": { "@earendil-works/pi-ai": "$@earendil-works/pi-ai" } }`），否则 npm 的严格 peer 校验会直接拒绝安装（`ERESOLVE`，本地对着真实 registry 验证过：`pi-mcp-adapter@3.3.0` 配 `@earendil-works/pi-ai@0.99.1` 会报这个错）。没选 `--legacy-peer-deps`：那个开关只能加在"门禁这一次"的 install 命令上，PR 合并后 `release.yml`/`ci.yml` 跑的是不带这个开关的 `npm ci`，一样会报 `ERESOLVE`——门禁绿了但合并后的 main 装不上。写进 `package.json` 的 `overrides` 是仓库状态的一部分，PR 的 diff 里能直接看到，合并后不带任何开关的 `npm ci` 也验证过能正常跑通；adapter 以后声明支持了，`overrides` 会在下一次升级时自动删掉。
- `pi-upgrade.yml` 的 `actions/checkout` 用 `persist-credentials: false`：token 不写进 `.git/config`，只在真正要 push / 调 `gh` 的那一步里临时塞进远程 URL——这一步在 `npm install` 已经跑完之后才执行，缩小了"万一 `--ignore-scripts` 没挡住"时 token 暴露的窗口。
- 新版本发布不到 3 天（`MIN_PUBLISH_AGE_MS`，读 `npm view <pkg> time --json`）不会自动采用，除非显式传 `--version`——给生态一点时间发现被入侵或有问题的发布。这个数字是我定的。同一个检查也套用在"猜的" adapter 版本上（adapter 是 `declared: false` 时）：那个版本也可能是刚发布的，同样没人验证过，`--version` 会同时跳过 Pi 和 adapter 两边的检查。

**`overrides` 只在 MMP 自己是安装根目录时生效。** 这是 npm 的既有行为，不是这次改动引入的限制，但值得记在这里：`npm install --global` 装 MMP 的 tgz 时，MMP 自己就是那次安装的根，`overrides` 按预期生效，只是 npm 会打印一条 `npm warn ERESOLVE overriding peer dependency` 的提示（能装上，行为符合预期，只是有告警）；但如果有人把 MMP 的 tgz 当作*另一个*项目的普通依赖装进去（非 global），MMP 自己的 `overrides` 不会被外层项目继承——那种场景下装出来的树里会有两份 `@earendil-works/pi-ai`。MMP 的正常分发方式（`install.sh` → `npm install --global`）走的是前一种情况，不受影响；这里不改 `install.sh`。

**adapter 选择不能降级（pre-merge review 修的一个真实 bug）。** 早期实现按"新→旧排序，选第一个满足声明范围的版本"选 adapter，会把已经锁定的 `2.38.0` **降级**成 `2.21.0`——因为 `pi-mcp-adapter` 2.12.0-2.21.0 声明的 peer 范围是 `*`（什么都匹配），排序上又比更晚的、范围写得更精确的版本先满足条件。现在的规则：`*`、空字符串、或者压根没声明这个 peer key，一律算"没声明"，不算"兼容"；候选版本也只看比当前锁定版本更新的；如果连最新版本都没声明支持新 Pi 版本，就试最新版本（装的时候用上面的 `overrides`），把结果交给门禁（尤其是 `test/mcp.test.mjs` 的离线 MCP 验收）去判断真假兼容，并在报告里如实写清楚"这是猜的，不是 adapter 自己说的"。范围匹配用 `semver` 包（现在是正式 devDependency），不再手撸——手撸的版本只认识 `^` 和精确匹配，遇到 `~`、`x`、`>=` 这类合法写法会直接判"不兼容"，也会在排序遇到预发布版本号时抛异常。

备注：`--version` 传一个预发布版本号（比如 `0.88.0-rc.1`）时，即使 adapter 声明的范围本来能覆盖对应的正式版（`^0.88.0`），`semver.satisfies` 默认也不认预发布版本命中——所以显式传预发布版本永远走"没声明，试最新版本"这条路径，这是 `semver` 的默认行为，符合"没人验证过这个预发布版本"的直觉，不用额外处理。

**现状（写这段的时候）：下一次真实升级会是 0.87.1 → 0.99.1，跨 12 个 minor 版本。** 门禁大概率过不了，报告里会标出"一次跨这么多版本，不是日常小步升级"；`pi-mcp-adapter` 目前最新版（3.3.0）声明的 peer 范围只到 `^0.87.0`，大概率会走"没有 adapter 声明支持，试最新版本"这条路径。这不是这次改动要解决的问题——第一次真实升级本来就需要人来处理，设计本身允许门禁失败、开 issue、等人决定。

**PR 和 issue 不会刷屏。** 分支固定叫 `pi-upgrade`（不是每个版本一个分支）：门禁通过就在这条分支上强制更新（force-push 前先检查分支上是否有非 bot 的提交，有就不推，改成在 PR 下留言说明，等人处理）；同一个版本的 PR 被人关掉且没合并过，就不会再自动开一个一样的。门禁失败开的 issue 只在报告内容真正变化时才追加评论（给报告内容算哈希，跟 issue 最后一条评论或者 issue 本身的正文比对），同一个失败原因不会每天多一条评论。

**`${{ steps.*.outputs.* }}` 不直接拼进 `run:` 脚本。** step 的输出最终来自升级脚本解析到的、上游 registry 返回的版本号字符串——理论上是不受信输入。所有用到它的地方都走 `env:` 再在脚本里引用 shell 变量，不直接拼进 `run:` 的命令文本，这是 GitHub 自己建议的防注入写法。

## 5.1 用户侧：更新提示（参照 Claude Code）

> 2026-09-29 已实现（U5），实现和下面的设计有两处出入：
> - 现在只在底栏显示（`setStatus`），启动页不加这一行。一种机制就够了，底栏的位置也和 Claude Code 一致。
> - 检查失败的原因只记在 `~/.mmp/update-check.json`，还没接到 `/mmp` 的输出里。
>
> 代码在 `src/update.ts` 和 `src/extensions/runtime.ts`，测试在 `test/update.test.mjs`。

自动升级只解决了"MMP 发新版"。用户要知道有新版、知道怎么升，所以需要一个类似 Claude Code 右下角 `Update available! Run: brew upgrade claude-code@latest` 的提示。

**显示在哪里**

| 阶段 | 位置 | 样式 |
|---|---|---|
| 现在（交互界面还是 Pi 的） | 启动页底部一行；会话中途才拿到检查结果的，用 `ctx.ui.setStatus("mmp-update", …)` 显示在底栏 | `warning` 色：`Update available! mmp 0.1.4 → 0.1.5 · Run: <升级命令>` |
| 新 TUI | 快捷键栏右侧，右对齐，和 Claude Code 的位置一致；窄屏时先丢掉这一段（tui-design 4.5 节） | 同上 |

**怎么检查**

```
交互模式启动 ──▶ 读 ~/.mmp/update-check.json（上次的结果）──▶ 有更新就立刻显示
             └─▶ 距上次检查超过 24 小时？──▶ 后台请求 GitHub Releases API（latest），超时 3 秒
                                            ──▶ 写回缓存；比当前版本新，就更新提示
```

- 数据源：`https://api.github.com/repos/RoacherM/mmp/releases/latest` 的 tag，和 `MMP_VERSION` 做 semver 比较。不需要登录，未登录限额是每小时 60 次，一天查一次足够。
- 缓存放在 `~/.mmp/update-check.json`，是 MMP 自己的目录，不放进 `~/.mmp/pi`。
- 完全在后台进行，不阻塞启动，也不影响正在进行的对话。
- 检查失败不打扰用户：错误记进缓存文件，`/mmp` 里能看到"上次检查失败：原因"。这样失败不是悄悄吞掉的，只是不在主界面弹出来。
- 24 小时、3 秒这两个数字是我定的。

**什么时候不检查**

- 非交互模式（print、json、rpc）和 benchmark 一律不检查，保证运行结果可复现，也不产生网络请求；
- 设置了 `--offline` 或 `PI_OFFLINE`；
- 设置了 `MMP_DISABLE_UPDATE_CHECK=1`；
- 设置了 `CI` 环境变量。

**关掉 Pi 自己的更新提示。** Pi 的交互界面会自己去查 Pi 的新版本，提示 `New version 0.87.1 is available. Run pi update`（0.83 冒烟时实际看到过）。在 MMP 里这是误导：`pi update` 升的是全局的 Pi，不是 MMP 锁定的那份。MMP 启动 Pi 前设置 `PI_SKIP_VERSION_CHECK=1`（Pi 的 `version-check.js` 认这个变量），只保留 MMP 自己的提示。

**提示里给什么命令**

- v1：重新运行安装器，也就是 `curl -fsSL https://github.com/RoacherM/mmp/releases/latest/download/install.sh | sh`。前提是发布脚本把 `install.sh` 作为 release 附件上传，GitHub 的 `releases/latest/download/<文件名>` 会自动指向最新一版。
- 更顺手的写法是加一个 `mmp update` 子命令，和 `claude update` 一样，内部就是跑上面那个安装器。提示就可以写成 `Run: mmp update`（U5）。

**后台自动安装**（Claude Code 默认会这么做）：v1 不做。安装器执行的是 `npm install --global`，在对话进行中替换正在运行的程序有风险，还可能遇到权限问题。先只做提示，等用户反馈再决定（U6）。

## 6. 对新 TUI 设计的约束

自建第 4 层后，MMP 和 Pi 耦合得更深，每一处耦合都会变成每次升级的成本。所以给 [tui-design.md](tui-design.md) 定三条规则：

| 耦合方式 | 规则 |
|---|---|
| Pi 包入口导出的接口 | 当作契约来用，由"Pi 接口清单"检查兜底（`test/pi-interface-inventory.test.mjs`） |
| 从 Pi 复制过来的代码 | 只允许小段，并且必须登记在 `vendor.json` 里接受漂移检查。目前计划复制的有：`app.*` 键位定义（约 114 行）、`resolveAppMode`（13 行）、项目信任流程 |
| 按文件路径直接 import Pi 没导出的模块、读取私有字段/方法，或依赖 Pi 自己嵌套安装的其他包 | 现实是新 TUI 已经用了好几处（pi-tui 的 `Editor.state`、`KeybindingsManager`、剪贴板读取、scoped-models 选择器、`pi-agent-core` 的 `Agent`……）。规则改为：**允许，但必须登记在 [`docs/pi-internals.md`](pi-internals.md) 并由 `test/pi-internals.test.mjs` 覆盖**；未登记的 `join(piDist, ...)` 深路径、`importFromPi(...)` 或 `createRequire(piEntry).resolve(...)` 深导入会让那个测试失败（按这三种固定写法扫描 `src/`/`test/fixtures/`/`scripts/`，其它写法的深导入目前扫不到），登记过的一项如果被 Pi 升级移动或改名，也会在那个测试里指名失败，而不是禁止后被绕开 |

## 7. 待你拍板

| # | 问题 | 我的推荐 |
|---|---|---|
| U1 | 用哪种做法 | B：版本锁死，升级自动化 |
| U2 | 门禁通过、模型可见内容也没变时，是自动合并并发布，还是每次你点一下 | 先做"开 PR，你点合并"，发布脚本在合并后自动跑。稳定一段时间后再考虑全自动 |
| U3 | 仓库目前没有任何 CI，要不要加 GitHub Actions（每日定时任务 + PR 检查） | 要。门禁全部离线，不需要 secrets |
| U5 | ~~更新提示里给的命令~~ | 已定并已完成：`mmp update` |
| U6 | ~~要不要后台自动安装新版~~ | 已定：不做 |
| U4 | ~~第 0 阶段发现 `mmp --approve` 会让 Pi 信任项目 `.pi/settings.json`~~ | 已按推荐修法完成（2026-09-29）：不再转发 `--approve`，固定给 Pi 传 `--no-approve` |

## 8. 实施顺序

| 步 | 内容 |
|---|---|
| 1 | 第 4 节：版本号单一来源、变体改名、文档去版本号 |
| 2 | 补齐门禁：配置隔离改成正式测试、ambient 清单从 Pi 读取、模型可见内容快照、Pi 接口清单、交互冒烟 |
| 3 | 升级脚本（本地可跑：`npm run pi:upgrade`） |
| 4 | GitHub Actions：每日检查 + PR 检查 |
| 5 | 发布脚本（把 `install.sh` 作为 release 附件上传） |
| 6 | 更新提示：关掉 Pi 自带的提示、后台检查与缓存、启动页和底栏显示、`mmp update`（新 TUI 里改为显示在快捷键栏右侧） |

新 TUI 开发期间同样执行第 6 节的规则，漂移检查和启动契约随 TUI 代码一起加。

## 9. 已知：升到 Pi 0.99 时需要人决定的一件事

Pi 0.99 加入了原生 MCP 支持（`core/mcp-servers.js`），把 `mcp.json` 变成 Pi 自己识别、并纳入 project trust 的一项资源。MMP 现在的隔离假设是"Pi 不认识 `mcp.json`，只有 `mmp:mcp` + `pi-mcp-adapter` 认识它"——0.99 打破这个假设。升到 0.99（或更高）时，在自动化门禁跑完、开 PR 之前，需要人决定：

- ambient 隔离要不要新增一项：阻止 Pi 原生读取项目/全局的 `mcp.json`（同 `SYSTEM.md`/`APPEND_SYSTEM.md` 现在的做法），还是改用 Pi 原生 MCP 取代 `mmp:mcp` + `pi-mcp-adapter`；
- 如果两者共存，`mcp.json` 的 schema、trust 语义和生效顺序会不会冲突，MMP 该以哪一份为准。

这不是自动化能替人拍板的决定，先在这里记一笔，免得升级脚本悄悄把 0.99 当成又一次普通的 patch 升级放过去。
