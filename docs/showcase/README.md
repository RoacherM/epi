# 特性展示

每个版本一个目录，放这个版本新特性的录屏和截图，用于 README、发布说明和社交媒体宣发。画面全部来自真实的 Epi TUI：脚本驱动真实的应用跑一遍，逐帧采样终端格子再栅格化，不手绘、不重建界面。

| 版本 | 内容 |
|---|---|
| [0.1.23](0.1.23/README.md) | Mermaid 图表画成框线图；一列排版，工具耗时变成对齐的小条 |
| [0.1.22](0.1.22/README.md) | 回合脊柱、单行工具调用、76 列正文；`/preview`、`/review`、`/trace` 导览 |

## 约定

每次发版都要有这里的一个目录，是发版清单的一项（[dev-workflow.md](../dev-workflow.md) §7），`test/showcase.test.mjs` 会检查。

- **目录**：`docs/showcase/<版本>/`，里面一个 `README.md` 说明每个文件展示了什么；宣发文案放同目录的 `announce.md`。
- **场景脚本**：`scripts/docs/showcase/<版本>.mjs`，同时是一个 Epi 扩展（默认导出注册离线脚本模型）和录制剧本（`files` 演示项目、`play` 输入步骤、`clips` 剪哪几段、`stills` 截哪几张）。新版本复制上一版改。
- **格式**：每段都出 MP4（发社交媒体用，比 GIF 清楚）；只有要在文档里内嵌显示的段落才额外出 GIF。完整导览只出 MP4，控制仓库体积。
- **诚实标注**：模型回复是脚本写好的（模型名显示为 `offline-demo`），不代表真实模型的效果和速度；工具真实执行，画面上的耗时是真实测量。
- **已发布的不重录**：每个目录记录的是那个版本当时的样子，后续版本界面变化不回头改旧目录。

## 重新生成

在仓库根目录：

```bash
npm run build
node scripts/docs/capture-showcase.mjs 0.1.22
```

额外需要：

- `ffmpeg`（切片、编码 MP4 和 GIF）。
- Python 3 与 Pillow、DejaVu Sans Mono 字体，同 [截图说明](../assets/README.md)：`EPI_SCREENSHOT_FONT_DIR` 指定字体目录，`PYTHON` 指定带 Pillow 的 Python。

脚本在临时 `HOME`、`EPI_HOME` 和演示项目里运行，环境变量采用白名单：不联网、不加载真实凭证、不读你的 `~/.epi`，结束后删除临时目录。录制用的是 `@xterm/headless`，不支持图形协议，所以 `/preview` 的图片和视频画面录不到，需要在 Ghostty、kitty 或 iTerm2 里手动录。

每次输出会覆盖 `docs/showcase/<版本>/` 下的同名文件；耗时、时钟随运行而变，所以重录后媒体文件总会有差异。
