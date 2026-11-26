# 0.2.9 特性展示

[← 特性展示](../README.md)

0.2.9 推出免 Node.js 一键安装与 Bun 预打包发行流水线（决策 IN1），并将底层锁定 Pi SDK 从 `1.4.0` 升级至 `1.6.1`。

本版本没有改变主界面布局，不附新录屏。

## 1. 免 Node.js 一键安装与 Bun 预打包发行（IN1）

- **零前置依赖一键安装**：`curl -fsSL https://github.com/RoacherM/epi/releases/latest/download/install.sh | bash`（亦支持 `| sh` 与 `--dir <path>`），不再要求本机预装 Node.js 或 npm，也不需要 `sudo`。安装器优先复用 `EPI_BUN`、系统 `PATH` 或 `~/.bun/bin/bun` 中 `>= 1.2.0` 的 Bun，未命中时自动下载锁定版本 Bun（`1.4.5`）并校验官方 `SHASUMS256.txt` 后落入私有 `~/.epi/runtime/bun/bin/bun`。
- **通用预打包归档与原子升级**：`scripts/release.mjs` 使用 `bun install --production --ignore-scripts --frozen-lockfile --no-save` 按 `npm-shrinkwrap.json` 组装跨 macOS/Linux 通用的 `epi-<version>-bundle.tar.gz`，安装与 `epi update` 全程零 npm registry 请求、原子切换 `~/.epi/current` 并保留 `N-1` 版本目录保护已打开的并发 TUI 会话；启动器自动透传 `EPI_LAUNCHER_*` 使 `--dir` / `EPI_INSTALL_DIR` 自定义安装在 `epi update` 时原地升级。
- **Bun `fd 3` 子代理协议修复**：修复 Bun 下 `net.Socket({ fd: 3 })` 静默丢数据及 `createReadStream({ fd: 3 }).destroy()` 忽略 `autoClose: false` 的问题，确保 `dispatch` 子代理与看板在 Bun 与 Node 上行为一致。

## 2. Pi SDK 升级至 1.6.1

- 同步升级全部 8 个 `@earendil-works/*` 锁定包至 `1.6.1`（新增直接锁定 `@earendil-works/pi-schema`），适配 `pi-tui` `Component.render()` 返回 `readonly string[]`、`typebox` 独立 `Type` 导入及新增的 `PI_SELF_UPDATE_COMMAND` / `PI_CLIENT` / `PI_CLIENT_METADATA_DOCUMENTS` 环境隔离规则。
