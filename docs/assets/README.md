# README 界面截图

`epi-ui.png` 展示对话、思考、真实 read/edit/bash 工具与 Markdown；`epi-welcome.png` 展示启动页。两张图均来自真实 Epi TUI，使用离线脚本化模型回复，不代表真实模型的效果或耗时。

复现（仓库根目录）：

```bash
npm ci --ignore-scripts
npm run build
node scripts/docs/capture-ui.mjs
```

额外需要 Python 3、Pillow 和 DejaVu Sans Mono 字体（含粗体、斜体）。Linux 默认字体目录为 `/usr/share/fonts/truetype/dejavu`；其他系统用 `EPI_SCREENSHOT_FONT_DIR` 指定目录，`PYTHON` 可指定 Python 可执行文件。

脚本在临时 `HOME`、`EPI_HOME` 与示例项目中运行现有 TUI harness，结束后删除临时目录。环境变量采用白名单；不联网、不加载真实凭证、不访问剪贴板。只有演示项目内的文件会被工具修改。截图从应用原始 ANSI 输出经 xterm 回放得到，保留单元格内容、配色与布局；背景为终端底色 `#181818`，以 2 倍尺寸栅格化，无额外窗口装饰。界面版本来自构建产物，耗时等运行信息可能随机器变化。
