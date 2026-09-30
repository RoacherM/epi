# AGENTS.md

MMP 是改名叫 mmp 的定制版 Pi：功能优先对齐官方 Pi，交互界面是 grok-build 风格。开始任何工作前读：

- [docs/dev-workflow.md](docs/dev-workflow.md)：开发流程（角色分工、任务说明、合并前审查、Herdr 实测）。
- [DEVELOPMENT.md](DEVELOPMENT.md)：产品约定和架构；[docs/decisions.md](docs/decisions.md)：已定的决策。

硬规则：

1. MMP 和 Pi 的配置不共享：不读写 `~/.pi/agent`，不读项目 `.pi/`，Pi 的状态只在 `~/.mmp/pi`。
2. 项目的 `.mmp/mmp.json` 只有被信任时才读。
3. 失败要可见，不静默兜底。
4. 对外只暴露 mmp 自己的参数、子命令和帮助。
5. 用到 Pi 的内部接口必须登记在 [docs/pi-internals.md](docs/pi-internals.md) 并有测试。
6. 测试不碰真实环境：临时 `HOME`/`MMP_HOME`，不联网，不碰真实剪贴板。
7. `npm run build` 后 `dist/` 要一起提交；`npm test` 全绿才算完成。
8. 推送、开 PR、发布前先问用户。
