# 安装与升级

[← 文档索引](README.md)

## 要求

- macOS 或 Linux（`arm64` / `x86_64`），系统自带 `curl` 与 `tar`（首次自动下载 Bun 时需 `unzip` 或 `python3`）
- **无需预装 Node.js、npm 或 Bun**
- `@earendil-works/pi-coding-agent`：见 `package.json`，由发行包预先打包锁定

## 安装

一键安装（支持 `bash` 或 `sh`）：

```bash
curl -fsSL https://github.com/RoacherM/epi/releases/latest/download/install.sh | bash
```

自定义安装目录（默认启动器落在 `~/.local/bin/epi`）：

```bash
curl -fsSL https://github.com/RoacherM/epi/releases/latest/download/install.sh | sh -s -- --dir "$HOME/bin"
```

安装器执行以下步骤，全程不需要 `sudo`，也不会在安装时访问 npm registry：

1. **准备 Bun 运行时**：优先复用 `EPI_BUN`、系统 `PATH` 中的 `bun` 或 `~/.bun/bin/bun`；若本机没有 Bun，自动下载锁定版本的 Bun 并校验 SHA-256，安装到私有的 `~/.epi/runtime/bun/bin/bun`（不污染系统 `PATH`）。
2. **下载并校验发行包**：下载对应版本的通用预打包归档 `epi-<version>-bundle.tar.gz`（含构建好的 `dist/` 与按 `npm-shrinkwrap.json` 锁定的生产依赖）并校验 SHA-256。
3. **原子切换**：解压到 `~/.epi/releases/<version>`，原子更新 `~/.epi/current` 软链并清理旧版本目录，在 `~/.local/bin/epi`（或 `--dir` / `EPI_BIN_DIR` 指定目录）写入启动器。

不希望把脚本直接交给 shell 时，可以先下载并审阅 `install.sh`。常用环境变量：

- `EPI_BIN_DIR`：启动器安装目录（等同 `--dir`，默认 `~/.local/bin`）
- `EPI_INSTALL_DIR`：发行版本与私有 Bun 的存放根目录（默认 `${EPI_HOME:-~/.epi}`）
- `EPI_BUN`：显式指定 `bun` 可执行文件路径（跳过检测与自动下载）

如果此前通过旧版 `npm install --global` 装过 Epi 且该路径排在 `~/.local/bin` 之前，安装器会提示运行 `npm uninstall -g epi` 或调整 `PATH` 顺序。

首次安装不要求创建 Manifest；`epi --no-project --dry-run` 可以空配置启动。Epi 使用独立 Pi 运行目录 `~/.epi/pi`。认证可通过 Pi 支持的 provider 环境变量提供；也可以启动 `epi` 后使用 `/login`。认证、settings、sessions 与 project trust 都不会从 `~/.pi/agent` 自动继承。

## 升级

```bash
epi update
```

`epi update` 查询 GitHub 上最新的 Release；有新版就下载该版本的 `install.sh` 并运行，安装器同样校验 SHA-256、复用已有的 Bun 运行时并原子切换 `~/.epi/current`。交互模式每天最多检查一次新版本（后台进行，超时 3 秒），有新版时在底栏显示 `Update available! … Run: epi update`。检查结果缓存在 `~/.epi/update-check.json`，检查失败时错误也记在这里。非交互模式、`--offline`、`EPI_OFFLINE`、`CI` 环境下不检查；设置 `EPI_DISABLE_UPDATE_CHECK=1` 可以完全关闭。Epi 会关掉 Pi 自带的更新提示，因为它提示的 `pi update` 不会更新 Epi 锁定的 Pi。Epi 不做后台自动安装。

本文档描述当前主分支；安装器和 `epi update` 获取最新 GitHub Release，发布版可能落后于主分支。合并到 `main` 与发布新版本是两件事：Release workflow 在推送到 `main` 时运行，只有 `package.json` 对应版本尚无标签时才发布。

版本检查应输出两行：`epi <当前 Epi 版本>` 和 `pi <当前锁定的 Pi 版本>`（具体版本号见 `package.json`，不在这里写死，避免每次发布都要改文档）。

## 从源码构建

本地开发与运行离线测试套件仍支持 Node.js `>=22.19.0` 与 Bun：

```bash
git clone --branch main https://github.com/RoacherM/epi.git
cd epi
bun install --frozen-lockfile --ignore-scripts --no-save
npm run build
npm test
```

需要让 Epi 加载本仓库开发规则时，可将 [开发配置模板](../../examples/development/epi.json) 复制到本地 `.epi/epi.json` 后显式信任项目；已有配置请手动合并，勿覆盖。模板路径以目标 `.epi/` 为基准，只引用 `AGENTS.md`（其余文档按需读取）；运行时 `.epi/` 不提交。

开发文档：[产品与架构](../development.md) · [开发流程](../dev-workflow.md) · [设计决策](../decisions.md) · [端到端验收](../e2e-acceptance.md)。根目录 [AGENTS.md](../../AGENTS.md) 是给开发代理的简短入口，不是自动生效的 Epi 运行配置。
