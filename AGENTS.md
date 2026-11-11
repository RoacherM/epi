# Epi contributor entrypoint

Epi 是使用锁定 Pi SDK 的定制 Harness，交互界面由 Epi 实现。

开始工作前阅读 [架构设计（原则）](docs/architecture.md)、[开发流程与硬规则](docs/dev-workflow.md)、[代码规范与质量检查](docs/code-quality.md)、[实现与契约](docs/development.md) 和 [已定决策](docs/decisions.md)。根目录只保留此入口，详细规则以这些文档为准。

**设计先出可交互 HTML 原型**：任何设计（界面、交互、流程）先交 `scripts/probes/<名字>-prototype.html`，用户亲自试过并明确同意后才写实现；同意前不改 `src/`、不合并（决策 WF6）。构建产物 `dist/` 必须同步提交；禁止在 `main` 分支直接提交 `src/` 改动，必须经 `dev/<id>` 分支、`run-review.sh precheck` 通过且 `agy` 双模型（`gemini-4-carbon-high` + `gemini-4-argon-high`）独立盲审均无 P0–P2、`run-review.sh verify` 签发 `verified.sha` 后才能合并（单次送审 `src/` ≤ 2000 行，无绕过开关，作者不自审，决策 WF4、WF7、WF8）。测试使用临时 `HOME`/`EPI_HOME`，不联网、不碰真实凭证或剪贴板。推送、开 PR、发布前须有用户授权。
