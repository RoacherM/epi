# Epi contributor entrypoint

Epi 是使用锁定 Pi SDK 的定制 Harness，交互界面由 Epi 实现。

开始工作前阅读 [架构设计（原则）](docs/architecture.md)、[开发流程与硬规则](docs/dev-workflow.md)、[代码规范与质量检查](docs/code-quality.md)、[实现与契约](docs/development.md) 和 [已定决策](docs/decisions.md)。根目录只保留此入口，详细规则以这些文档为准。

构建产物 `dist/` 必须同步提交；`run-review.sh precheck` 通过且独立审查无 P0–P2 后才能合并（单次送审 `src/` ≤ 800 行，作者不自审）。整个开发流程在 epi 内部完成：主控、审查、终审、阅读都是 epi 会话（审查 harness 固定 `epi -p`），模型一律先从 magpie 的模型列表里选，不依赖 Claude Code 或 Fable（决策 WF1–WF4）。测试使用临时 `HOME`/`EPI_HOME`，不联网、不碰真实凭证或剪贴板。推送、开 PR、发布前须有用户授权。
