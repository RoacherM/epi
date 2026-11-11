# 0.2.6 特性展示

[← 特性展示](../README.md)

0.2.6 引入四层 `bash` 与子代理执行防挂死守卫（默认 `120s` 超时与 `600s` 秒单位校验、0ms 流式/TUI/脱管守护预检、`TaskRuntime` 子代理孤儿进程组收割与非交互 Git/Editor 加固、退出即时 `abort()`），统一了 `epi:task` 与 `epi:monitor` 的可靠通知门禁与账本，并加固了批量 `task`、CLI `epi mcp` 子命令、Magpie 跨渠道签名及 macOS 剪贴板图片粘贴。

本版本没有改变主界面布局，不附新录屏。

## 1. 四层 `bash` 与子代理执行守卫（#13）

- **默认超时与秒单位防呆（Layer 2）**：未显式传入 `timeout` 的 `bash` 调用自动注入 `120` 秒默认预算；非有限数、`<= 0` 或 `> 600` 秒在 0ms 即时拦截，当传入 `>= 1000` 时明确提示 `bash.timeout` 单位为**秒**并给出毫秒换算建议；超时结果自动补充缩小范围/拆分命令的恢复提示与 `.git/index.lock` 检查，且完整保留 `structuredContent`。
- **0ms Shell 命令预检（Layer 1）**：引号、转义、注释与 heredoc 感知切分（未闭合语法 fail-open），自动剥离环境变量、`env`/`sudo`/`command`（保留 `-v`/`-V` 探测）/`timeout` 与最多 3 层 `sh|bash|zsh|dash -c` 包装：
  - 拦截无界流式跟随（`tail -f/-F`、`journalctl -f`、`dmesg -w`、`docker|podman|kubectl logs -f`、`watch`、`fswatch`、无 `-c/-w` 的 `ping`），显式带 `<= 60s` 超时的短探针自动放行；
  - 拦截无头交互式全屏程序（`vim`/`nvim`/`nano`/`emacs -nw`、`htop`/`btop`、无 `-l/-b/-n` 的 `top`、`script`/`expect`/`unbuffer`），放行 `less` 与批处理模式；
  - 拦截脱管守护与未等待后台作业（`nohup`、`setsid`、`disown`、`daemonize`、`tmux new -d`、`screen -dm` 及不含 `wait`/`kill`/`trap` 的顶层 `&`），按宿主是否启用 `Monitor` 给出分流指引。
- **子代理孤儿进程组收割与退出中止（Layer 3）**：`TaskRuntime` 子代理通过 Bash 3.2 兼容 `BASH_ENV` 账本记录顶层 `<pgid>`（记录后立即 `unset` 并链式加载用户原 `BASH_ENV`）及 `EPI_WORKER_COOKIE` 环境标记；子代理完成或取消时在删除胶囊目录前按进程组收割残存后代（严格保护系统/自身/父进程 PGID、跨 UID、共享守护白名单与时间窗口）；交互会话退出（`quit`）且工具仍在运行时立即触发 `context.abort()`。
- **子代理非交互环境加固（Layer 4）**：为子代理默认注入 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`GIT_PAGER=cat` 与快速失败的 `GIT_EDITOR` / `GIT_SEQUENCE_EDITOR` 桩脚本（不设 `CI=1`，以免改变测试框架快照行为）。

## 2. 统一后台通知门禁与 `task` / `Monitor` 加固

- **共享 `NotificationGate` 与 `NotificationLedger`**：`epi:task` 与 `epi:monitor` 共用同一唤醒门禁与三态回执账本，修复 `/compact` 压缩期间、`Esc` 中断或 `/tree` 切分支时后台监控事件丢失或泄漏到无关会话的问题。
- **批量 `task` 原子回滚与 `fork` 传递**：`task({ tasks })` 任一项校验或启动失败时自动取消并清理已启动的同批作业；批量模式完整透传 `context: "fork"` 父会话快照；`/tasks` 监控历史做终端控制序列净化。
- **`Monitor` 长行与连接关闭稳健性**：超长无换行输出流按单行上限渐进切分避免堆积到 1 MiB 才丢弃，WebSocket 关闭事件保证单次幂等落盘。

## 3. CLI、Magpie 与剪贴板粘贴修复

- **`epi mcp` 未知子命令报错**：未知子命令返回明确错误与非零退出码，不再静默回退为 `list`。
- **Magpie 跨渠道 Gemini 签名与空回合修复**：清理跨渠道残留的不兼容签名，避免剔除后产生空回合触发上游 400。
- **macOS 剪贴板图片临时文件防竞态**：剪贴板位图落盘改用进程与计数器隔离路径，消除连续快速粘贴时的覆盖竞态。
