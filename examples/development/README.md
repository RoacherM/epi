# 用 Epi 开发本仓库

此目录是模板，不会被 Epi 自动加载。普通使用、安装和运行测试不需要创建项目配置。

需要让 Epi 加载本仓库开发规则时，在仓库根目录执行：

```bash
mkdir -p .epi
if [ -e .epi/epi.json ] || [ -L .epi/epi.json ]; then
  echo '已有本地配置，请手动合并 rules；不覆盖现有文件。'
else
  cp examples/development/epi.json .epi/epi.json
fi
node dist/cli.js --approve --dry-run
```

模板的 `../AGENTS.md` 和 `../docs/dev-workflow.md` 相对于复制后的 `.epi/epi.json` 解析，不能把模板原位置用作 `EPI_HOME`。`--approve` 仅在本次调用信任项目；交互运行也可以通过信任提示记住决定。

`.epi/` 整目录被 Git 忽略，每个 worktree 按需配置。不要提交凭证、会话或个人 provider 设置。Herdr 自举是单独的可选流程，见 [操作说明](../../docs/dev-workflow-herdr.md)，不会由本模板自动启用。
