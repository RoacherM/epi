# MMP contributor entrypoint

MMP 是使用锁定 Pi SDK 的定制 Harness，交互界面由 MMP 实现。

开始工作前阅读 [开发流程与硬规则](docs/dev-workflow.md)、[代码规范与质量检查](docs/code-quality.md)、[架构与契约](docs/development.md) 和 [已定决策](docs/decisions.md)。根目录只保留此入口，详细规则以这些文档为准。

构建产物 `dist/` 必须同步提交；完整测试与独立审查通过后才能合并。测试使用临时 `HOME`/`MMP_HOME`，不联网、不碰真实凭证或剪贴板。推送、开 PR、发布前须有用户授权。
