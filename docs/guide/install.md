# 安装与升级

[← 文档索引](README.md)

## 要求

- Node.js `>=22.19.0`
- `@earendil-works/pi-coding-agent`：见 `package.json`（MCP 用它 0.99 起的原生支持，不再有独立的 adapter 依赖，见 [docs/mcp-design.md](../mcp-design.md)）


## 安装

要求 Node.js `>=22.19.0`。推荐使用版本固定的安装器：

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://github.com/RoacherM/mmp/releases/latest/download/install.sh | sh
```

安装器检查 Node.js/npm，验证发行包的 SHA-256 后再执行全局安装，不会自动使用 `sudo`。不希望把脚本直接交给 shell 时，可以先下载并审阅 `install.sh`。

首次安装不要求创建 Manifest；`mmp --no-project --dry-run` 可以空配置启动。MMP 使用独立 Pi 运行目录 `~/.mmp/pi`。认证可通过 Pi 支持的 provider 环境变量提供；也可以启动 `mmp` 后使用 `/login`。认证、settings、sessions 与 project trust 都不会从 `~/.pi/agent` 自动继承。

## 升级

```bash
mmp update
```

`mmp update` 查询 GitHub 上最新的 Release；有新版就下载该版本的 `install.sh` 并运行，安装器同样会校验 SHA-256。交互模式每天最多检查一次新版本（后台进行，超时 3 秒），有新版时在底栏显示 `Update available! … Run: mmp update`。检查结果缓存在 `~/.mmp/update-check.json`，检查失败时错误也记在这里。非交互模式、`--offline`、`MMP_OFFLINE`、`CI` 环境下不检查；设置 `MMP_DISABLE_UPDATE_CHECK=1` 可以完全关闭。MMP 会关掉 Pi 自带的更新提示，因为它提示的 `pi update` 不会更新 MMP 锁定的 Pi。MMP 不做后台自动安装。安装器不会自动使用 `sudo`：如果当初是装在需要 root 权限的全局目录里，`mmp update` 会失败退出，需要按当初的方式手动重装。

也可以直接通过 npm 安装同一个 GitHub Release；`<version>` 换成 [Releases 页面](https://github.com/RoacherM/mmp/releases)上的最新版本号（tgz 的文件名带版本号，没有 `latest` 别名）：

```bash
npm install --global \
  https://github.com/RoacherM/mmp/releases/download/v<version>/mmp-<version>.tgz
mmp --version
```

Release 包含已构建的 `dist/`，安装时只获取运行时依赖；不要求本机预装 TypeScript，也不要求 PATH 中存在全局 `pi`。

本文档描述当前主分支；安装器和 `mmp update` 获取最新 GitHub Release，发布版可能落后于主分支。合并到 `main` 与发布新版本是两件事：Release workflow 在推送到 `main` 时运行，只有 `package.json` 对应版本尚无标签时才发布。

版本检查应输出两行：`mmp <当前 MMP 版本>` 和 `pi <当前锁定的 Pi 版本>`（具体版本号见 `package.json`，不在这里写死，避免每次发布都要改文档）。

## 从源码构建

```bash
git clone --branch main https://github.com/RoacherM/mmp.git
cd mmp
npm ci
npm run build
npm test
npm link
```

需要让 MMP 加载本仓库开发规则时，可将 [开发配置模板](../../examples/development/mmp.json) 复制到本地 `.mmp/mmp.json` 后显式信任项目；已有配置请手动合并，勿覆盖。模板路径以目标 `.mmp/` 为基准，只引用 `AGENTS.md` 与当前开发流程；运行时 `.mmp/` 不提交。

本文档描述当前主分支；安装器和 `mmp update` 获取最新 GitHub Release，发布版可能落后于主分支。合并到 `main` 与发布新版本是两件事：Release workflow 在推送到 `main` 时运行，只有 `package.json` 对应版本尚无标签时才发布。

开发文档：[产品与架构](../development.md) · [开发流程](../dev-workflow.md) · [设计决策](../decisions.md) · [端到端验收](../e2e-acceptance.md)。根目录 [AGENTS.md](../../AGENTS.md) 是给开发代理的简短入口，不是自动生效的 MMP 运行配置。
