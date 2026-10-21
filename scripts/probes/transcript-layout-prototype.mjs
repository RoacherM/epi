#!/usr/bin/env node
// docs/tui-transcript-layout-design.md 的可执行设计稿。
//
// 同一段真实会话（scripts/probes/fixtures/transcript-layout-session.json，从 0.1.21 发布那天的
// 真实 session 切片）渲染两遍：
//   现状  —— 由 dist/ 里的真实组件渲染（AssistantBlock / UserMessageBlock / toolBlock + 内置渲染器）
//   提案  —— 由本文件 §P 的新排版渲染器渲染（只动渲染层的数据流，验证设计规则成立）
// 输出 reports/transcript-layout-prototype.html（ANSI → HTML 转换，颜色即主题真值）。
//
// 用法：
//   node scripts/probes/transcript-layout-prototype.mjs            # 生成 HTML
//   node scripts/probes/transcript-layout-prototype.mjs --print    # 终端里直接看提案（100 列）
//
// 数据说明：工具耗时用 toolResult.durationMs 真值；思考时长重放数据没有逐段计时，
// 用所在消息的模型耗时近似（HTML 页脚有标注）。

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CWD = ROOT; // 会话的工作目录（cd 前缀剔除的基准）
const PRINT = process.argv.some((a) => a === "--print" || a.startsWith("--print="));

// ── 环境：强制 truecolor + chalk 全彩（否则管道里 chalk level=0，bold/italic 被吞掉）
process.env.COLORTERM = "truecolor";
process.env.FORCE_COLOR = "3";
const { piTui } = await import(join(ROOT, "dist/tui/pi-tui.js"));
piTui.setCapabilities({ images: null, trueColor: true, hyperlinks: false });

const { installEpiTheme } = await import(join(ROOT, "dist/tui/theme.js"));
const { AssistantBlock } = await import(join(ROOT, "dist/tui/assistant-block.js"));
const { toolBlock } = await import(join(ROOT, "dist/tui/tools/block.js"));
const { builtInToolRenderers } = await import(join(ROOT, "dist/tui/tools/index.js"));
const { UserMessageBlock, formatDuration } = await import(join(ROOT, "dist/tui/chrome.js"));
const { getMarkdownTheme, Theme } = await import("@earendil-works/pi-coding-agent");
const motion = await import(join(ROOT, "dist/tui/motion.js"));

const { visibleWidth, truncateToWidth } = piTui;

const agentDir = mkdtempSync(join(tmpdir(), "epi-layout-probe-"));
const theme = installEpiTheme(agentDir, "dark"); // 现状主题（getMarkdownTheme 的全局来源）

// 提案主题：现状调色板 + 色彩纪律的修订项（docs §R5）
const nightJson = JSON.parse(readFileSync(join(agentDir, "themes", "epi-grok-night.json"), "utf8"));
const BG_KEYS = ["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];
const fgNight = Object.fromEntries(Object.entries(nightJson.colors).filter(([k]) => !BG_KEYS.includes(k)));
const bgNight = Object.fromEntries(Object.entries(nightJson.colors).filter(([k]) => BG_KEYS.includes(k)));
const PROPOSED_FG_OVERRIDES = {
  mdCode: "#8fb3c0", // 行内代码：饱和青 → 与正文相邻的低饱和灰蓝
  mdListBullet: "#6c6c6c", // 列表符号是结构不是内容 → muted
  mdCodeBlockBorder: "#6c6c6c", // 代码块语言标签
  mdCodeBlock: "#b8c0cc", // 无高亮代码块：整块的亮青会在深底上糊成光斑 → 冷灰白（评审 v3）
};
const themeNext = new Theme({ ...fgNight, ...PROPOSED_FG_OVERRIDES }, bgNight, "truecolor", { name: "epi-proposed-night" });

const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "transcript-layout-session.json"), "utf8"));

// ── 小工具 ──────────────────────────────────────────────────────────────────
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const stripOsc = (line) => line.replace(OSC, "");

/** <1s 显示毫秒（"0.0s" 没有信息量），其余沿用 chrome.formatDuration。 */
function fmtDur(ms) {
  if (ms < 950) return `${Math.max(1, Math.round(ms))}ms`;
  return formatDuration(ms);
}

/** 去掉与会话 cwd 相同的 `cd <cwd> &&`/`cd <cwd>;` 前缀；其他绝对路径里的 home 折成 ~。 */
function shortenCommand(command) {
  const first = command.split("\n")[0] ?? "";
  const extra = command.split("\n").length - 1;
  let text = first;
  for (const sep of [" && ", "; "]) {
    const prefix = `cd ${CWD}${sep}`;
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  text = text.replaceAll(homedir(), "~");
  return { text, extra }; // extra = 被折起的行数（heredoc/多行），作为受保护的尾部后缀
}

// ═══════════════════════════════════════════════════════════════════════════
// §C 现状渲染：全部走 dist 的真实组件
// ═══════════════════════════════════════════════════════════════════════════

function renderToolCurrent(theme, call, result, width) {
  const renderers = toolBlock(call.name, builtInToolRenderers[call.name]);
  const ctx = {
    args: call.arguments, cwd: CWD, isPartial: false, expanded: false,
    isError: result.isError === true, invalidate() {}, lastComponent: undefined,
    toolCallId: call.id, state: {}, executionStarted: true, argsComplete: true,
  };
  const callC = renderers.renderCall(call.arguments, theme, ctx);
  const resultC = renderers.renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
  // ToolExecutionComponent 的结构：构造时 Spacer(1)，self 外壳里 call、result 直接相连
  return ["", ...callC.render(width), ...resultC.render(width)];
}

function renderSceneCurrent(scene, width) {
  const lines = [];
  const pending = new Map(); // toolCallId → toolCall part
  let busyMs = 0;
  for (const entry of scene) {
    const msg = entry.message;
    busyMs += msg.durationMs ?? 0;
    if (entry.role === "user") {
      const block = new UserMessageBlock(theme, msg.content, new Date(msg.timestamp));
      lines.push("", ...block.render(width).map(stripOsc));
    } else if (entry.role === "assistant") {
      const block = new AssistantBlock(theme, msg, [], false, false);
      lines.push(...block.render(width).map(stripOsc));
      for (const part of msg.content) if (part.type === "toolCall") pending.set(part.id, part);
    } else if (entry.role === "toolResult") {
      const call = pending.get(msg.toolCallId);
      if (call) lines.push(...renderToolCurrent(theme, call, msg, width).map(stripOsc));
    }
  }
  lines.push("", ...new piTui.Text(theme.fg("muted", `Worked for ${formatDuration(busyMs)}`), 3, 0).render(width));
  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// §P 提案渲染：排版系统的可执行定义
//
// 网格（R3）：col 0 轨道（静态稿为空）· col 3 标记（2 列宽）· col 5 内容
// 层级（R2）：L1 正文 text · L2 工具 toolOutput · L3 元信息 muted/dim
// 度量（R1）：正文内容列 ≤ MEASURE；代码块、工具行不受限
// 节奏（R4）：同组 0 空行、块间 1 空行、成功不占行
// ═══════════════════════════════════════════════════════════════════════════

const MARKER_COL = 3;
const CONTENT_COL = 5;
const MEASURE = 76; // 正文内容列宽上限（R1：45–75 拉丁字符 / ~38 汉字的最佳阅读区间）

const LEAD = " ".repeat(MARKER_COL); // 轨道 + 留白，标记列从这里开始
const INDENT = " ".repeat(CONTENT_COL);

const FENCE = "FENCE"; // MarkdownTheme.codeBlockBorder 的哨兵，后处理时识别围栏行

/** 提案的 MarkdownTheme：围栏变哨兵（之后删行/换语言标签）、列表符号 •、行内代码降饱和。 */
const mdThemeNext = {
  ...getMarkdownTheme(),
  code: (text) => themeNext.fg("mdCode", text),
  codeBlock: (text) => themeNext.fg("mdCodeBlock", text),
  codeBlockBorder: (text) => `${FENCE}${text}`,
  listBullet: (marker) =>
    /^[-*+]\s$/.test(marker)
      ? themeNext.fg("mdListBullet", "• ")
      : themeNext.fg("mdListBullet", marker),
};

// 零信息量语言不印标签（评审 v3：孤立的 `text` 像忘了删的占位符）
const NO_LABEL_LANGS = new Set(["", "text", "txt", "plain", "plaintext"]);

/** 把 markdown 源码切成正文段与围栏代码段（R1：度量只管正文，代码是数据）。 */
function splitMarkdownSegments(source) {
  const segments = [];
  let prose = [];
  let code = null; // { lang, lines }
  for (const line of source.split("\n")) {
    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (code === null && fence) {
      if (prose.length > 0) segments.push({ kind: "prose", text: prose.join("\n") });
      prose = [];
      code = { lang: fence[1] ?? "", lines: [] };
    } else if (code !== null && fence) {
      segments.push({ kind: "code", lang: code.lang, text: code.lines.join("\n") });
      code = null;
    } else if (code !== null) {
      code.lines.push(line);
    } else {
      prose.push(line);
    }
  }
  if (code !== null) segments.push({ kind: "code", lang: code.lang, text: code.lines.join("\n") });
  else if (prose.length > 0) segments.push({ kind: "prose", text: prose.join("\n") });
  return segments.filter((s) => s.text.trim() !== "");
}

/** 单个 Markdown 实例渲染一段；返回已去尾部空白的行。 */
function renderMarkdownSlice(text, width) {
  const md = new piTui.Markdown(text, CONTENT_COL, 0, mdThemeNext);
  const out = [];
  for (const rawLine of md.render(width)) {
    const line = rawLine.trimEnd();
    if (line.includes(FENCE)) continue; // 围栏行：删（残留未配对围栏的安全网也走这里）
    out.push(line);
  }
  return out;
}

/** 正文：真实 pi-tui Markdown 渲染。正文段按 measure 封顶；代码段全宽，
 * 围栏行替换为暗色语言标签（无语言则不占行）。 */
function renderProse(text, width) {
  const capped = Math.min(width, CONTENT_COL * 2 + MEASURE);
  const out = [];
  const segs = splitMarkdownSegments(text);
  for (const [index, seg] of segs.entries()) {
    if (seg.kind === "prose") {
      out.push(...renderMarkdownSlice(seg.text, capped));
      continue;
    }
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    // 代码块容器感（评审 v3）：第 3 列一条极暗竖轨，代码从第 5 列起；语言标签贴在轨内
    const rail = `${LEAD}${themeNext.fg("borderMuted", "│")} `;
    if (!NO_LABEL_LANGS.has(seg.lang)) out.push(`${rail}${themeNext.fg("mdCodeBlockBorder", seg.lang)}`);
    for (const line of renderMarkdownSlice(`\`\`\`text\n${seg.text}\n\`\`\``, width)) {
      out.push(line.trim() === "" ? "" : rail + line.slice(CONTENT_COL + 2)); // 剥掉 paddingX + codeBlockIndent
    }
    if (index < segs.length - 1) out.push(""); // 代码块与后续正文之间 1 空行（R4）
  }
  // 连续空行坍缩成一个（R4）
  return out.filter((line, i) => !(line.trim() === "" && out[i - 1]?.trim() === ""));
}

/** 折叠的思考：一行 `∴ 12.3s`（glyph/spine 变体）或 `┬ 12.3s`（tee 变体），dim，无字重无时间（R2 L3）。 */
function renderThink(ms, variant) {
  const glyph = variant === "tee" ? "┬" : "∴";
  return `${LEAD}${themeNext.fg("dim", glyph)} ${themeNext.fg("dim", fmtDur(ms))}`;
}

/** 工具调用行。gutter 标记随结构变体（V 系列，见 HTML 稿第四节）：
 *  - glyph：bash 用琥珀色 `$` 占标记位，文件类工具用 `◆`
 *  - spine：同样的标记，但回合有一条贯穿的暗色脊柱，工具行叠加 `├─` 分支（在布局层加）
 *  - tee：不画脊柱，用 T 字朝向表义——工具 `├`（向右分支）、思考 `┬`（向下展开）、收尾 `┴`
 * 成功不占行，尾部暗色耗时（`✓` 省掉——正常不邀功，异常才高亮）。 */
function renderToolNext(call, result, width, variant) {
  const isError = result.isError === true;
  const dur = fmtDur(result.durationMs ?? 0);
  const status = isError ? null : themeNext.fg("dim", dur);

  let marker;
  let content;
  let suffix = "";
  const branch = themeNext.fg(isError ? "error" : "borderMuted", "├ ");
  if (call.name === "bash") {
    const { text: command, extra } = shortenCommand(String(call.arguments?.command ?? ""));
    if (variant === "tee") {
      marker = branch;
      content = `${themeNext.fg("bashMode", "$")} ${themeNext.fg("toolOutput", command)}`;
    } else {
      marker = themeNext.fg(isError ? "error" : "bashMode", "$ ");
      content = themeNext.fg("toolOutput", command);
    }
    if (extra > 0) suffix = themeNext.fg("dim", ` · +${extra} lines`);
  } else {
    marker = variant === "tee" ? branch : themeNext.fg(isError ? "error" : "muted", "◆ ");
    const verb = themeNext.fg("toolOutput", call.name);
    const rawPath = String(call.arguments?.path ?? call.arguments?.file_path ?? "");
    const rel = rawPath ? relative(CWD, rawPath.startsWith("/") ? rawPath : join(CWD, rawPath)) : "";
    const detail = rel ? ` ${themeNext.fg("toolOutput", rel)}` : "";
    let extra = "";
    if (call.name === "write" && typeof call.arguments?.content === "string") {
      extra = themeNext.fg("dim", ` · ${call.arguments.content.replace(/\n$/, "").split("\n").length} lines`);
    }
    content = `${verb}${detail}${extra}`;
  }

  // 尾部（· +N lines 与耗时）受保护：先截断命令，再拼尾部；与命令主体间留 2 列彻底脱开（评审 v3）
  const tail = `${suffix}${status ? `  ${status}` : ""}`;
  const budget = Math.max(1, width - CONTENT_COL - visibleWidth(tail) - 1);
  const truncated = visibleWidth(content) > budget ? truncateToWidth(content, budget, themeNext.fg("dim", "…")) : content;
  const line = `${LEAD}${marker}${truncated}${tail}`;
  if (!isError) return [line];
  // 失败才单独占行（R4：异常才有版面）；tee 变体里 `┤` 表示结果回流进主干
  const failMarker = variant === "tee" ? themeNext.fg("error", "┤ ") : "";
  return [line, `${variant === "tee" ? LEAD + failMarker : INDENT}${themeNext.fg("error", `✗ exit ${typeof result.exitCode === "number" ? result.exitCode : 1}`)}`];
}

function renderSceneNext(scene, width, variant = "glyph") {
  // 先摊平成条目流，再按节奏规则加间距（R4）：∴ 贴后续、工具连排 0 空行、其余 1 空行
  const items = [];
  const pending = new Map();
  let busyMs = 0;
  for (const entry of scene) {
    const msg = entry.message;
    busyMs += msg.durationMs ?? 0;
    if (entry.role === "user") {
      items.push({ kind: "user", msg });
    } else if (entry.role === "assistant") {
      const thinks = msg.content.filter((p) => p.type === "thinking" && p.thinking?.trim());
      const texts = msg.content.filter((p) => p.type === "text" && p.text?.trim());
      // ∴ 是正文的眉题：后面没有正文（纯思考+工具）时不单独占行，耗时在 Worked for 里汇总（评审 v3）
      if (thinks.length > 0 && texts.length > 0) items.push({ kind: "think", ms: msg.durationMs ?? 0 });
      for (const text of texts) items.push({ kind: "prose", text: text.text });
      for (const part of msg.content) if (part.type === "toolCall") pending.set(part.id, part);
    } else if (entry.role === "toolResult") {
      const call = pending.get(msg.toolCallId);
      if (call) items.push({ kind: "tool", call, result: msg });
    }
  }

  // 带标签的行：inTurn = 是否属于回合脊柱覆盖范围；junction = 脊柱上的分支/收尾
  const rows = [];
  let prevKind;
  const pushBlock = (kind, block) => {
    if (block.length === 0) return;
    const glue = (prevKind === "think") || (prevKind === "tool" && kind === "tool");
    if (rows.length > 0 && !glue) rows.push({ text: "", inTurn: prevKind !== undefined && prevKind !== "user" && kind !== "user" });
    for (const text of block) rows.push({ text, inTurn: kind !== "user", kind });
    prevKind = kind;
  };

  for (const item of items) {
    switch (item.kind) {
      case "user":
        pushBlock("user", new UserMessageBlock(themeNext, item.msg.content, new Date(item.msg.timestamp)).render(width).map(stripOsc));
        break;
      case "think":
        pushBlock("think", [renderThink(item.ms, variant)]);
        break;
      case "prose":
        pushBlock("prose", renderProse(item.text, width));
        break;
      case "tool":
        pushBlock("tool", renderToolNext(item.call, item.result, width, variant));
        break;
    }
  }
  const footerText = variant === "spine"
    ? `${LEAD} ${themeNext.fg("dim", `Worked for ${formatDuration(busyMs)}`)}` // ╰─ 由布局层叠加
    : `${LEAD}${themeNext.fg("dim", `${variant === "tee" ? "┴" : "─"} Worked for ${formatDuration(busyMs)}`)}`;
  pushBlock("footer", [footerText]);
  // spine 变体：回合内所有行（含空行）第 1 列叠暗色脊柱；工具行 `├─`、错误行红色 `├─`、收尾 `╰─`
  if (variant === "spine") {
    const spine = themeNext.fg("borderMuted", "│");
    const branch = themeNext.fg("borderMuted", "├─");
    const branchErr = themeNext.fg("error", "├─");
    const close = themeNext.fg("borderMuted", "╰─");
    return rows.map((row) => {
      if (!row.inTurn) return row.text;
      if (row.kind === "tool") {
        const j = row.text.includes("✗") ? branchErr : branch; // 失败续行：红色分支
        return ` ${j}${row.text.slice(3)}`;
      }
      if (row.kind === "footer") return ` ${close}${row.text.slice(3)}`;
      if (row.text === "") return ` ${spine}`;
      return ` ${spine}${row.text.slice(2)}`;
    });
  }
  return rows.map((row) => row.text);
}

/** 运行中的一帧（spine 变体）：脊柱就是 M4 的流光轨——回合进行时脊柱是活的，
 * 高光脉冲沿脊柱下滑（accent → thinkingHigh），思考行呼吸。真实执行 src/tui/motion.ts 的 railGlyph/breathe。 */
function renderLiveFrame(width) {
  const { railGlyph, breathe } = motion;
  const t = 1.4; // 固定一帧
  const rows = [
    { text: `${LEAD}${breathe(themeNext, "muted", "thinkingHigh", t, "∴")} ${themeNext.fg("muted", "Thinking…")}` },
    { text: `${LEAD}${themeNext.fg("dim", "先看一下我们内置的 motion/ascii-art 系统有什么可用的，再出结")}` },
    { text: `${LEAD}${themeNext.fg("dim", "构化的 gutter 设计稿。")}` },
    { text: "" },
    { text: `${LEAD}${themeNext.fg("bashMode", "$ ")}${themeNext.fg("toolOutput", "npm test -- --run")}`, branch: true },
    { text: `${INDENT}${themeNext.fg("toolOutput", "Test Files  42 passed (42)")}` },
  ];
  return rows.map((row, i) => {
    const rail = railGlyph(themeNext, i, t);
    if (row.branch) return ` ${rail}${themeNext.fg("accent", "─")}${row.text.slice(3)}`;
    if (row.text === "") return ` ${rail}`;
    return ` ${rail}${row.text.slice(2)}`;
  });
}

// ── 动画分镜：「一个回合的一生」，每一帧都是 motion.ts / flash.ts 原语的真实执行 ──
// 时间轴（秒）：0.0 思考（∴ 呼吸 + 脊柱脉冲）→ 1.6 思考完成（M6 绿闪衰减）→ 1.9 正文出现
// → 2.4 工具分支出现（运行中）→ 4.4 工具完成（分支绿闪 + 耗时浮现）→ 5.2 脊柱沉淀、╰─ 收尾 → 6.8 循环
const STORY = { thinkEnd: 1.6, proseAt: 1.9, toolAt: 2.4, toolEnd: 4.4, settleAt: 5.2, duration: 6.8, tick: 0.08 };

/** M6 的衰减公式（flash.ts flashRail），但 glyph 可换（脊柱上是 │/├ 而不是 ┃）。 */
function flashGlyph(tone, glyph, elapsedMs) {
  const HOLD_MS = 120, FLASH_MS = 400;
  if (elapsedMs < 0 || elapsedMs >= FLASH_MS) return null;
  const faded = Math.max(0, elapsedMs - HOLD_MS) / (FLASH_MS - HOLD_MS);
  return motion.blendFg(themeNext, tone, "borderMuted", 1 - Math.exp(-4 * Math.min(1, faded)), glyph);
}

function renderStoryboardFrame(t) {
  const { railGlyph, breathe } = motion;
  const settled = t >= STORY.settleAt;
  const spine = (row) => (settled ? themeNext.fg("borderMuted", "│") : railGlyph(themeNext, row, t));
  const rows = [];
  const push = (text, opts = {}) => rows.push({ text, ...opts });

  // 思考
  if (t < STORY.thinkEnd) {
    push(`${LEAD}${breathe(themeNext, "muted", "thinkingHigh", t, "∴")} ${themeNext.fg("muted", "Thinking…")}`, { kind: "think" });
    push(`${LEAD}${themeNext.fg("dim", "先确认每个问题在代码里的原因，提案才不会是猜测…")}`, { kind: "think" });
  } else {
    const fl = flashGlyph("success", "│", (t - STORY.thinkEnd) * 1000);
    push(`${LEAD}${themeNext.fg("dim", "∴")} ${themeNext.fg("dim", "1.6s")}`, { kind: "think", flash: fl });
  }
  // 正文
  if (t >= STORY.proseAt) {
    push("");
    push(`${INDENT}${themeNext.fg("text", "Confirmed. Running the full suite before the commit:")}`);
  }
  // 工具分支
  if (t >= STORY.toolAt) {
    push("");
    const done = t >= STORY.toolEnd;
    const fl = done ? flashGlyph("success", "├", (t - STORY.toolEnd) * 1000) : null;
    const tail = done ? `  ${themeNext.fg("dim", "2.0s")}` : "";
    push(`${LEAD}${themeNext.fg("bashMode", "$ ")}${themeNext.fg("toolOutput", "npm test -- --run")}${tail}`, { kind: "tool", flash: fl });
  }
  // 收尾
  if (t >= STORY.settleAt) {
    push("");
    push(`${LEAD} ${themeNext.fg("dim", "Worked for 5.2s")}`, { kind: "footer" });
  }

  return rows.map((row, i) => {
    if (row.kind === "footer") return ` ${themeNext.fg("borderMuted", "╰─")}${row.text.slice(3)}`;
    if (row.kind === "tool") {
      const j = row.flash ?? (settled ? themeNext.fg("borderMuted", "├") : motion.blendFg(themeNext, "accent", "thinkingHigh", 0.5, "├"));
      const dash = row.flash ? motion.blendFg(themeNext, "success", "borderMuted", 1 - Math.exp(-4 * Math.min(1, Math.max(0, (t - STORY.toolEnd) * 1000 - 120) / 280)), "─") : themeNext.fg(settled ? "borderMuted" : "accent", "─");
      return ` ${j}${dash}${row.text.slice(3)}`;
    }
    const rail = row.flash ?? spine(i);
    if (row.text === "") return ` ${rail}`;
    return ` ${rail}${row.text.slice(2)}`;
  });
}

function renderStoryboard() {
  const frames = [];
  for (let t = 0; t < STORY.duration; t += STORY.tick) frames.push(renderStoryboardFrame(t));
  return frames;
}

// ═══════════════════════════════════════════════════════════════════════════
// §H ANSI → HTML
// ═══════════════════════════════════════════════════════════════════════════

function xterm256(n) {
  if (n < 16) {
    return ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
      "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"][n];
  }
  if (n < 232) {
    const i = n - 16, v = (x) => (x === 0 ? 0 : 55 + x * 40);
    return `#${[v(Math.floor(i / 36) % 6), v(Math.floor(i / 6) % 6), v(i % 6)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  }
  const g = 8 + (n - 232) * 10;
  return `#${g.toString(16).padStart(2, "0").repeat(3)}`;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ansiToHtml(line) {
  let html = "", open = false;
  let fg = null, bg = null, bold = false, italic = false, faint = false, underline = false;
  const close = () => { if (open) { html += "</span>"; open = false; } };
  const apply = () => {
    close();
    const style = [
      fg && `color:${fg}`, bg && `background:${bg}`, bold && "font-weight:600",
      italic && "font-style:italic", faint && "opacity:.65", underline && "text-decoration:underline",
    ].filter(Boolean).join(";");
    if (style) { html += `<span style="${style}">`; open = true; }
  };
  let i = 0, text = "";
  const flush = () => { if (text) { html += esc(text); text = ""; } };
  while (i < line.length) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i);
      if (end === -1) break;
      flush();
      const params = line.slice(i + 2, end).split(";").map(Number);
      for (let p = 0; p < params.length; p++) {
        const c = params[p];
        if (c === 0) { fg = bg = null; bold = italic = faint = underline = false; }
        else if (c === 1) bold = true;
        else if (c === 2) faint = true;
        else if (c === 3) italic = true;
        else if (c === 4) underline = true;
        else if (c === 22) { bold = faint = false; }
        else if (c === 23) italic = false;
        else if (c === 24) underline = false;
        else if (c === 39) fg = null;
        else if (c === 49) bg = null;
        else if (c === 38 || c === 48) {
          const rgb = params[p + 1] === 2 ? `#${params.slice(p + 2, p + 5).map((x) => x.toString(16).padStart(2, "0")).join("")}` : xterm256(params[p + 2] ?? 0);
          if (c === 38) fg = rgb; else bg = rgb;
          p += params[p + 1] === 2 ? 4 : 2;
        }
      }
      apply();
      i = end + 1;
    } else {
      text += line[i];
      i++;
    }
  }
  flush();
  close();
  return html;
}

const frame = (lines, caption) => `
<figure class="term">
  <figcaption>${caption}</figcaption>
  <pre>${lines.map(ansiToHtml).join("\n")}</pre>
</figure>`;

// ═══════════════════════════════════════════════════════════════════════════
// 页面
// ═══════════════════════════════════════════════════════════════════════════

const WIDTH_MAIN = 116;
const WIDTH_WIDE = 200;

const scenes = [
  { key: "release", title: "场景 A · 发布收尾（6 个 bash，长命令、heredoc、时钟密集）" },
  { key: "design-answer", title: "场景 B · 设计回答（用户消息、write 工具、Markdown 长文：代码块 / 列表 / 行内代码）" },
];

const frames = {};
for (const { key } of scenes) {
  frames[`${key}-current`] = renderSceneCurrent(fixture.scenes[key], WIDTH_MAIN);
  frames[`${key}-next`] = renderSceneNext(fixture.scenes[key], WIDTH_MAIN);
}
frames["release-current-wide"] = renderSceneCurrent(fixture.scenes["release"], WIDTH_WIDE);
frames["release-next-wide"] = renderSceneNext(fixture.scenes["release"], WIDTH_WIDE);
// 左缘结构语言变体（第四节）：spine = 回合脊柱，tee = T 字朝向表义
frames["release-spine"] = renderSceneNext(fixture.scenes["release"], WIDTH_MAIN, "spine");
frames["release-tee"] = renderSceneNext(fixture.scenes["release"], WIDTH_MAIN, "tee");
frames["design-answer-spine"] = renderSceneNext(fixture.scenes["design-answer"], WIDTH_MAIN, "spine");
frames["live-spine"] = renderLiveFrame(WIDTH_MAIN);
const storyboard = renderStoryboard(); // 每帧都是 motion.ts/flash.ts 的真实执行
const storyRows = Math.max(...storyboard.map((f) => f.length));

if (PRINT) {
  const which = process.argv.find((a) => a.startsWith("--print="))?.split("=")[1] ?? "release-next";
  console.log(frames[which].join("\n"));
  process.exit(0);
}

// 行数/可见字符统计（页面顶部的对照数字）
function stats(lines) {
  const nonEmpty = lines.filter((l) => visibleWidth(l) > 0);
  return { rows: lines.length, nonEmpty: nonEmpty.length };
}
const statPairs = scenes.map(({ key }) => ({
  key,
  before: stats(frames[`${key}-current`]),
  after: stats(frames[`${key}-next`]),
}));

const chip = (hex, label) => `<span class="chip"><i style="background:${hex}"></i>${label} <code>${hex}</code></span>`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>对话区排版设计稿 · Epi TUI</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 24px 96px;
    background: #0e0f11; color: #d4d4d8;
    font: 15px/1.75 -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  }
  main { max-width: 1060px; margin: 0 auto; }
  h1 { font-size: 26px; font-weight: 650; color: #ececee; margin: 0 0 6px; letter-spacing: -0.01em; }
  h2 { font-size: 19px; font-weight: 650; color: #ececee; margin: 56px 0 4px; }
  h3 { font-size: 15px; font-weight: 650; color: #c9c9cf; margin: 28px 0 4px; }
  p, li { color: #a5a5ad; }
  p { margin: 6px 0; max-width: 72ch; }
  ul { margin: 6px 0; padding-left: 22px; }
  li { margin: 3px 0; }
  code { font: 13px ui-monospace, "SF Mono", Menlo, monospace; color: #9db8c4; }
  .sub { color: #71717a; font-size: 14px; }
  .rule { border: none; border-top: 1px solid #232529; margin: 40px 0 0; }

  figure.term {
    margin: 18px 0 8px; border: 1px solid #26282d; border-radius: 10px; overflow: hidden;
    background: #161719; box-shadow: 0 12px 32px rgba(0,0,0,.35);
  }
  figure.term figcaption {
    padding: 8px 14px; font-size: 12.5px; color: #8e8e96;
    background: #1c1d20; border-bottom: 1px solid #26282d;
    display: flex; justify-content: space-between; gap: 12px;
  }
  figure.term figcaption b { color: #c9c9cf; font-weight: 600; }
  figure.term pre {
    margin: 0; padding: 14px 0 16px; overflow-x: auto;
    font: 12.5px/1.5 ui-monospace, "SF Mono", Menlo, "Sarasa Mono SC", monospace;
    color: #e1e1e1; white-space: pre;
  }
  .legend { font-size: 13.5px; color: #8e8e96; margin: 4px 2px 30px; max-width: 76ch; }
  .legend b { color: #c2c2c9; font-weight: 600; }

  table.metrics { border-collapse: collapse; margin: 14px 0; font-size: 14px; }
  table.metrics th, table.metrics td { border: 1px solid #26282d; padding: 6px 14px; text-align: right; }
  table.metrics th { color: #8e8e96; font-weight: 500; text-align: left; }
  table.metrics td:first-child { text-align: left; color: #a5a5ad; }
  .delta { color: #9ece6a; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 4px 28px; }
  .chip { display: inline-flex; align-items: center; gap: 7px; margin: 3px 14px 3px 0; font-size: 13px; color: #a5a5ad; }
  .chip i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .principle { margin: 14px 0; }
  .principle b { color: #e4e4e8; font-weight: 650; }
  .kbd { border: 1px solid #33353a; border-radius: 4px; padding: 0 5px; font-size: 12px; color: #a5a5ad; }
</style>
</head>
<body>
<main>
  <h1>对话区排版设计稿</h1>
  <p class="sub">Epi TUI · ${new Date().toISOString().slice(0, 10)} · 由 <code>scripts/probes/transcript-layout-prototype.mjs</code> 执行生成：「现状」帧是 dist 真实组件的渲染输出，「提案」帧是新渲染器对同一段真实会话（0.1.21 发布当天 session，${fixture.source.slice(0, 10)}）的渲染输出。不是手绘稿。</p>

  <h2>一、排版系统：五条规则</h2>
  <p class="sub">每条规则先给理论依据，再给可执行定义。提案帧就是这套定义的渲染结果。</p>

  <div class="principle"><b>R1 · 度量（measure）</b> — 连续阅读的最佳行长是 45–75 个拉丁字符（Bringhurst；WCAG 1.4.8 要求 ≤80），中英文混排时汉字占两列，约 38 字即达上限。
  <br>→ <b>正文内容列宽封顶 ${MEASURE} 列</b>（Pi 的 Markdown 组件 paddingX 左右对称各加 ${CONTENT_COL} 列，实际渲染宽度 ${CONTENT_COL * 2 + MEASURE} 列）。代码块、表格、工具输出是「数据」，不受度量限制。</div>

  <div class="principle"><b>R2 · 层级（hierarchy）</b> — 终端没有字号，层级只能靠墨量（亮度对比）和字重。三级：回答正文 ＞ 工具调用 ＞ 思考与状态。越常见、信息越少的行越暗。
  <br>→ <b>bold 只留给需要扫读定位的词</b>；现在加粗的 <code>◆ Thought</code> 恰好违反了这条：最弱的信息拿了最强的字重。</div>

  <div class="principle"><b>R3 · 网格（grid）</b> — 一条左轴：第 0 列轨道（动态效果预留）、第 3 列标记（<code>◆ ∴ ◈ ❯</code>）、第 5 列内容。眼睛沿一条直线即可给信息分类。</div>

  <div class="principle"><b>R4 · 节奏（rhythm / 亲密性）</b> — 间距即语义：<b>同组 0 空行</b>（连续工具调用、∴ 与它引出的动作）、<b>块间 1 空行</b>（正文 ↔ 工具组）。<b>成功不占行</b>：常态折叠进调用行尾部的 <code>✓ 耗时</code>，失败才单独占一行红字。时间戳只属于回合边界（用户消息、Worked for），段落级时钟是噪音。</div>

  <div class="principle"><b>R5 · 色彩纪律（color discipline）</b> — 全局只留一个强调色 + 语义色：琥珀 = <code>$</code> 提示符，绿 = 成功/新增，红 = 失败/删除，紫 = 交互强调。装饰性高饱和色降饱和到正文相邻色阶。
  <br><span class="sub">墨量阶梯与语义色（主题真值）：</span><br>
  ${chip("#e1e1e1", "text · L1 正文")}${chip("#c8c8c8", "toolOutput · L2")}${chip("#6c6c6c", "muted · L3")}${chip("#585858", "dim · L3 弱")}<br>
  ${chip("#e0af68", "bashMode · 仅 $")}${chip("#9ece6a", "success · ✓")}${chip("#f7768e", "error")}${chip("#bb9af7", "accent · 交互")}<br>
  ${chip("#3A95AB", "mdCode 现状（跳色）")}${chip("#8fb3c0", "mdCode 提案")}</div>

  <h2>二、对照</h2>
  <table class="metrics">
    <tr><th>场景（${WIDTH_MAIN} 列渲染）</th><th>现状 · 总行数</th><th>现状 · 非空行</th><th>提案 · 总行数</th><th>提案 · 非空行</th><th>非空行变化</th></tr>
    ${statPairs.map(({ key, before, after }) => {
      const scene = scenes.find((s) => s.key === key);
      const d = Math.round((after.nonEmpty / before.nonEmpty - 1) * 100);
      return `<tr><td>${scene.title.split(" · ")[0]}</td><td>${before.rows}</td><td>${before.nonEmpty}</td><td>${after.rows}</td><td>${after.nonEmpty}</td><td class="delta">${d}%</td></tr>`;
    }).join("\n    ")}
  </table>

  <h3>${scenes[0].title}</h3>
  ${frame(frames["release-current"], "<b>现状</b><span>真实组件渲染 · 116 列</span>")}
  <p class="legend">注意：① 每条回复右上角的时钟；② 加粗的 <b>◆ Thought</b>；③ 整行橙色的 <b>cd … &amp;&amp;</b> 前缀与 <b>…</b> 截断；④ 每条命令下一行的 <b>exit 0</b>；⑤ 工具块之间的空行。</p>
  ${frame(frames["release-next"], "<b>提案</b><span>新渲染器 · 同一份数据 · 116 列</span>")}
  <p class="legend">v3（审美评审后）：① 琥珀色 <b>$</b> 直接占 gutter 标记位，命令 L2 灰白，同目录 <code>cd</code> 前缀剔除、多行脚本标 <code>· +N lines</code>（受保护后缀）；② 成功不邀功——行尾只留暗色耗时（durationMs 真值），失败才红字占行；③ <b>∴</b> 只作正文的眉题，纯工具步骤不印；④ 连续调用 0 空行；⑤ 代码块第 3 列暗竖轨 <b>│</b>，零信息量的 <code>text</code> 标签不印。</p>

  <h3>${scenes[1].title}</h3>
  ${frame(frames["design-answer-current"], "<b>现状</b><span>真实组件渲染 · 116 列</span>")}
  <p class="legend">注意：① 代码块露出的 <b>&#96;&#96;&#96;text</b> / <b>&#96;&#96;&#96;</b> 围栏行；② 行内代码的饱和青色在大段文字里反复跳色；③ 列表符号 <b>-</b> 的亮蓝色。</p>
  ${frame(frames["design-answer-next"], "<b>提案</b><span>新渲染器 · 同一份数据 · 116 列</span>")}
  <p class="legend">v3：① 围栏行删除，代码块由暗竖轨 <b>│</b> 收拢成容器，无高亮代码降为冷灰白 <code>#b8c0cc</code>；② 行内代码灰蓝 <code>#8fb3c0</code>；③ 列表符号 <b>•</b> 用 muted；④ 正文按 ${MEASURE} 列折行；⑤ <code>─ Worked for</code> 收尾。</p>

  <h2>三、宽终端（${WIDTH_WIDE} 列）：度量封顶的效果</h2>
  <p class="sub">现状的正文铺满整个终端宽度；提案的正文停在 76 列度量，工具行仍可用全宽（命令的关键信息在左侧，行尾状态紧随其后，不会漂到 200 列开外）。</p>
  ${frame(frames["release-current-wide"], "<b>现状</b><span>真实组件渲染 · 200 列</span>")}
  ${frame(frames["release-next-wide"], "<b>提案</b><span>新渲染器 · 200 列</span>")}

  <h2>四、左缘结构语言：给 gutter 一个骨架（回应「都是矩形」）</h2>
  <p class="sub">现状的左边缘是一列相同的 ◆ 叠成的“矩形串”，思考、工具、收尾全靠同一个实心菱形，没有结构。两个结构化方向，都是真实渲染：</p>

  <h3>V-S · 回合脊柱（推荐）</h3>
  <p>一个回合 = 一条贯穿的暗色脊柱（<code>borderMuted</code>）：正文和思考在主干上，工具调用是向右的分支 <code>├─</code>，失败是红色分支，回合以 <code>╰─ Worked for</code> 收口。<b>和内置动效的关系</b>：现在只在运行中出现的 M4 流光轨就是这条脊柱——回合进行中脊柱是活的（高光脉冲下滑、完成闪烁沿脊柱衰减），结束后沉淀为静态结构。动效不再是装饰层，而是骨架的生命体征。</p>
  ${frame(frames["release-spine"], "<b>V-S · 脊柱</b><span>场景 A · 116 列 · 真实渲染</span>")}
  <figure class="term">
    <figcaption><b>V-S · 动画：一个回合的一生</b><span>每帧都是 motion.ts / flash.ts 的真实执行 · ${Math.round(STORY.duration / STORY.tick)} 帧 · 循环</span></figcaption>
    <pre id="story" style="min-height:${(storyRows * 1.5 + 2.4).toFixed(1)}em"></pre>
  </figure>
  <p class="legend">分镜：<b>∴ 呼吸 + 脊柱脉冲</b>（回合开始）→ 思考完成、脊柱根部 <b>M6 绿闪衰减</b> → 正文落版 → <b>├─ 分支亮起</b>（工具运行中）→ 工具完成、<b>分支绿闪</b>、耗时浮现 → 脊柱沉淀为静态 <code>borderMuted</code>、<b>╰─ Worked for</b> 收口。动效即骨架的生命体征。</p>
  <p class="legend">长文场景下的脊柱如下。注意代码块的暗竖轨 <code>│</code> 与回合脊柱形成嵌套缩进参考线。</p>
  ${frame(frames["design-answer-spine"], "<b>V-S · 脊柱</b><span>场景 B · 116 列 · 真实渲染</span>")}

  <h3>V-T · T 字朝向表义（轻量备选）</h3>
  <p>不画连续脊柱，用 T 字的朝向表达结构语义：思考 <code>┬</code>（向下展开出正文）、工具 <code>├</code>（从主干向右分支）、失败 <code>┤</code>（结果回流）、收尾 <code>┴</code>（向上闭合回合）。比脊柱轻，但没有脊柱的“回合是一个整体”感。</p>
  ${frame(frames["release-tee"], "<b>V-T · T 字分型</b><span>场景 A · 116 列 · 真实渲染</span>")}

  <h2>五、落地项与待确认</h2>
  <ul>
    <li><b>纯渲染层</b>：以上全部只改绘制，不改模型收到的内容；实现后 <code>model-snapshot</code> 测试必须无差异。</li>
    <li><b>思考行</b>：按你的决定用 <code>∴ 2.1s</code> 单行。流式中的 <code>∴ Thinking…</code> + 流光轨道保持现状。</li>
    <li><b>时钟</b>：建议从回复行移除，只保留用户消息与 <code>Worked for</code>（R4：时间属于回合边界）。</li>
    <li><b>度量</b>：建议做成 <span class="kbd">/settings</span> 项，默认 ${MEASURE}，可选「不限」。</li>
    <li><b>连续 bash 不合并</b>：保留每条命令可见（与只读工具的 <code>◈ Read 3 files</code> 不同，命令内容本身是要扫读的）。</li>
    <li><b>formatTokens 缺陷</b>：<code>↑156186k</code> 应为 <code>156M</code>，纯 bug，可单独先修。</li>
  </ul>

  <hr class="rule">
  <p class="sub">数据：${fixture.source}（会话切片已剔除不可见的大 payload：思考正文、超长输出；可见内容与真实会话逐列一致）。思考行的时长用所在消息的模型耗时近似（重放数据没有逐段思考计时），其余时长均为真值。复现：<code>node scripts/probes/transcript-layout-prototype.mjs</code>；终端直看：<code>--print</code>。</p>
  <p class="sub">v2 工程评审（<a style="color:#7aa2f7" href="../docs/notes/review-transcript-layout-argon.md">notes/review-transcript-layout-argon.md</a>）：命令体降 L2 <code>toolOutput</code>、<code>· +N lines</code> 受保护后缀。v3 布局审美评审（<a style="color:#7aa2f7" href="../docs/notes/review-transcript-layout-aesthetics-argon.md">notes/review-transcript-layout-aesthetics-argon.md</a>）：<code>$</code> 占 gutter、常态成功省掉 <code>✓</code>、<code>∴</code> 只作正文眉题、代码块暗竖轨容器、<code>─ Worked for</code> 收尾。</p>
<script>
const FRAMES = ${JSON.stringify(storyboard.map((f) => f.map(ansiToHtml).join("\n")))};
const storyEl = document.getElementById("story");
let frameIndex = 0;
let storyTimer = null;
function tickStory() { storyEl.innerHTML = FRAMES[frameIndex]; frameIndex = (frameIndex + 1) % FRAMES.length; }
function startStory() { if (storyTimer === null) { tickStory(); storyTimer = setInterval(tickStory, ${Math.round(STORY.tick * 1000)}); } }
function stopStory() { clearInterval(storyTimer); storyTimer = null; }
document.addEventListener("visibilitychange", () => (document.hidden ? stopStory() : startStory()));
startStory();
</script>
</main>
</body>
</html>
`;

const outDir = join(ROOT, "reports");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "transcript-layout-prototype.html");
writeFileSync(outFile, html);
console.log(`wrote ${outFile}`);
for (const [k, v] of Object.entries(frames)) {
  console.log(`${k}: ${v.length} rows`);
}
