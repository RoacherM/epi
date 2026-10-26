#!/usr/bin/env node
// Probe: 对话区「乱」的成因与三个排版提案（不是靠调颜色，而是行宽 / 归组 / 密度）。
//
// 复现用户在 230 列终端里的实际观感：连续 5 个 bash 调用，每个都吐长行（grep 结果、curl 输出）。
// 「现状」帧用 dist 里的真实组件渲染（toolBlock + 内置渲染器），不是手绘。
//
// 用法：
//   node scripts/probes/layout-density-probe.mjs            # 生成 reports/layout-density-probe.html
//   node scripts/probes/layout-density-probe.mjs --print A  # 终端里直接看某一档（A/B/C）

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.COLORTERM = "truecolor";
process.env.FORCE_COLOR = "3";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const { piTui } = await import(join(ROOT, "dist/tui/pi-tui.js"));
piTui.setCapabilities({ images: null, trueColor: true, hyperlinks: false });
const { installEpiTheme } = await import(join(ROOT, "dist/tui/theme.js"));
const { toolBlock } = await import(join(ROOT, "dist/tui/tools/block.js"));
const { builtInToolRenderers } = await import(join(ROOT, "dist/tui/tools/index.js"));
const { visibleWidth, truncateToWidth } = piTui;

const agentDir = mkdtempSync(join(tmpdir(), "epi-density-"));
const theme = installEpiTheme(agentDir, "dark");
const CWD = "/Users/byronwayne/Projects/sides/storyforge";

// ── 场景：照用户截图重排的一轮工具调用 ─────────────────────────────────────
// 关键特征：几条 grep 输出的单行就有 200+ 列；curl 健康检查吐 8 行重复结构。

const LONG_A = "docs/development.md:30:这份文档怎么写：本地检查、仓库边界、授权边界、工作方式、skill 同步与发版、评审。原则在 [architecture.md](architecture.md)，决策来历在 [decisions.md](decisions.md)。宿主（Creator 接入与 ChatUI）的运行契约以 [host/README.md](../host/README.md) 为准；storyforge skill 的接入设计见 [storyforge-skill-integration.md]";
const LONG_B = "docs/f5-conversation-film-contract.md:5:空闲轮次可通过同一 Creator 消息添加最多 4 份、每份不超过 20MiB 的既有 Project 素材。`POST conversation/attachments` 以实际 bearer 及 Project 权限，读取原字节，核 MIME/大小/SHA 后返回通用引用";
const LONG_C = "docs/f5-creator-entry-contract.md:30: GET /projects/:projectId/activity?after=N 逐页返回同一工程真实工具事件、确认、费用及交付；`POST /projects/:projectId/confirmations/:uuid` 提交精确文件 revision/digest 及决定。JWT 由 PVA 签发";

const SCENE = [
  {
    name: "bash",
    command: "sed -n '1,3p' docs/development.md; grep -nE '素材|附件|revision' docs/*.md",
    output: [
      LONG_A,
      LONG_B,
      LONG_C,
      "docs/f2-pva-read-evidence.md:24:1. `GET /api/projects/{projectId}`: Bearer JWT, 返回 id/user_id/draft_id/schema 必须匹配。",
      "docs/f5-creator-entry-contract.md:41:3. 拒绝 dev_user、重复 Authorization、跨 Origin 及越权。Bearer 只交业务适配，不写入 Agent 输入或公共事件。",
    ],
  },
  {
    name: "bash",
    command: "for s in healthz readyz; do echo \"### W $s\"; curl -sS -o /dev/null -w '%{http_code}\\n' https://storyforge.local/$s; done",
    output: [
      "## W healthz",
      "HTTP 200",
      "Content-Type: text/plain",
      "ok",
      "## W readyz",
      "HTTP 200",
      "Content-Type: text/plain",
      "Cache-Control: no-store",
      "ok",
    ],
  },
  {
    name: "bash",
    command: "curl -sS -H 'Authorization: Bearer $TOKEN' https://storyforge.local/metrics | head -71",
    output: ["### WEB GET sessions, no bearer"],
    more: 71,
  },
  {
    name: "bash",
    command: "npm test -- --run test/docs",
    output: ["Ran 42 tests in 35.075s", "", "OK", "", "Ran 2 tests in 0.004s", "", "OK"],
  },
  {
    name: "bash",
    command: "git log --oneline -3",
    output: ["494dd76 producer: 3-tier artifact rules, .work draft clean, multi-stage codebook, OSS archive-plan"],
  },
];

// ── 现状：dist 真实组件 ────────────────────────────────────────────────────

function renderCurrent(width) {
  const rows = [];
  for (const item of SCENE) {
    const renderers = toolBlock(item.name, builtInToolRenderers[item.name]);
    const ctx = {
      args: { command: item.command }, cwd: CWD, isPartial: false, expanded: false,
      isError: false, invalidate() {}, lastComponent: undefined, toolCallId: "t",
      state: {}, executionStarted: true, argsComplete: true,
    };
    const result = {
      role: "toolResult", toolCallId: "t", toolName: item.name, isError: false,
      content: [{ type: "text", text: item.output.join("\n") + (item.more === undefined ? "" : `\n${"x".repeat(item.more)}`) }],
    };
    rows.push(...renderers.renderCall({ command: item.command }, theme, ctx).render(width));
    // 截图里的形态是**展开态**（Ctrl+O 之后）：折叠态成功不画任何行（mutating.ts）。
    rows.push(...renderers.renderResult(result, { expanded: true, isPartial: false }, theme, ctx).render(width));
  }
  return rows;
}

// 长行在现状里被**截断**（丢字），统计丢了多少列 —— 这是"全宽"最实际的代价
function lostColumns(width) {
  let lost = 0;
  for (const item of SCENE) {
    for (const line of item.output) lost += Math.max(0, visibleWidth(line) - width);
  }
  return lost;
}

// ── 提案 ──────────────────────────────────────────────────────────────────

const MARK = " ".repeat(3);
const BODY = " ".repeat(5);

/** 提案的共同基础：工具输出按 MEASURE 折行、续行对齐到内容列；代码/表格不在此列。 */
function wrapTo(text, width) {
  return piTui.wrapTextWithAnsi(text, width);
}

/**
 * A ·「限宽」
 * 只改一件事：工具输出与正文按 110 列折行（不是截断），续行对齐内容列。
 * 代码块、表格、diff 仍然全宽。
 */
function renderProposedMeasure(width, measure = 110) {
  const inner = Math.min(width - 5, measure);
  const rows = [];
  for (const item of SCENE) {
    const head = `${MARK}${theme.fg("bashMode", "$")} ${theme.fg("toolOutput", fitWidth(item.command, Math.max(20, width - 5 - 10)))}`;
    rows.push(head);
    for (const line of item.output) {
      for (const piece of wrapTo(line, inner)) rows.push(`${BODY}${theme.fg("toolOutput", piece)}`);
    }
    if (item.more !== undefined) rows.push(`${BODY}${theme.fg("dim", `… +${item.more} lines (Ctrl+O) `)}`);
    rows.push("");
  }
  return rows;
}

/**
 * B ·「限宽 + 连续 bash 归组」
 * 在 A 之上：连续 bash 收成一个组头，只展开第一条，其余折叠成一行 `+4 calls`。
 * 组头本身带成功计数，所以"跑了 5 条命令都过了"一眼可见。
 */
function renderProposedGrouped(width, measure = 110) {
  const inner = Math.min(width - 5, measure);
  const rows = [];
  rows.push(`${MARK}${theme.fg("muted", "◈")} ${theme.fg("toolOutput", `${SCENE.length} bash`)}  ${theme.fg("dim", "·")} ${theme.fg("dim", "all ok")}`);

  const first = SCENE[0];
  rows.push(`${MARK}${theme.fg("bashMode", "$")} ${theme.fg("toolOutput", fitWidth(first.command, Math.max(20, width - 5 - 14)))}  ${theme.fg("dim", "5 lines")}`);
  for (const line of first.output) {
    for (const piece of wrapTo(line, inner)) rows.push(`${BODY}${theme.fg("toolOutput", piece)}`);
  }
  rows.push(`${BODY}${theme.fg("dim", `+${SCENE.length - 1} more calls (Ctrl+O) `)}`);
  rows.push("");

  // 归组后仍然给出每个调用的**一行摘要**，让"哪几条重要"能扫读
  for (const item of SCENE.slice(1)) {
    const summary = summarize(item);
    rows.push(`${MARK}${theme.fg("bashMode", "·")} ${theme.fg("toolOutput", fitWidth(item.command, Math.max(20, width - 5 - summary.length - 6)))}  ${theme.fg("dim", summary)}`);
  }
  return rows;
}

/** 一条工具调用的单行摘要：能说清"它干了什么、结果如何"，不重述原始输出。 */
function summarize(item) {
  if (item.name === "bash" && /healthz|readyz/.test(item.command)) return "2 endpoints · 200";
  if (item.more !== undefined) return `1 line · +${item.more} more`;
  if (/npm test/.test(item.command)) return "44 tests passed";
  if (/git log/.test(item.command)) return "3 commits";
  return `${item.output.length} lines`;
}

/**
 * C ·「B + 重复结构压成摘要」
 * 在 B 之上：输出里重复的键值结构（curl -w / 多个 endpoint）压成一行结论。
 * 原始行仍在 Ctrl+O 后面，画面上不再占版面。
 */
function renderProposedSummary(width, measure = 110) {
  const rows = renderProposedGrouped(width, measure);
  // B 已经给了摘要行，C 的差别在于第一条也压掉：整轮只留组头 + 摘要 + 收尾
  const compact = rows.slice(0, 1);
  for (const item of SCENE) {
    const summary = summarize(item);
    compact.push(`${MARK}${theme.fg("bashMode", "·")} ${theme.fg("toolOutput", fitWidth(item.command, Math.max(20, width - 5 - summary.length - 6)))}  ${theme.fg("dim", summary)}`);
  }
  compact.push("");
  compact.push(`${MARK}${theme.fg("dim", "Worked for 12m41s")}`);
  return compact;
}

function fitWidth(text, width) {
  return visibleWidth(text) <= width ? text : truncateToWidth(text, Math.max(1, width - 1), "…");
}

// ── ANSI → HTML（与 transcript-layout-prototype.mjs 同一套）────────────────

function xterm256(n) {
  if (n < 16) return ["#000000","#800000","#008000","#808000","#000080","#800080","#008080","#c0c0c0","#808080","#ff0000","#00ff00","#ffff00","#0000ff","#ff00ff","#00ffff","#ffffff"][n];
  if (n < 232) { const i = n - 16, v = (x) => (x === 0 ? 0 : 55 + x * 40);
    return `#${[v(Math.floor(i / 36) % 6), v(Math.floor(i / 6) % 6), v(i % 6)].map((x) => x.toString(16).padStart(2, "0")).join("")}`; }
  const g = 8 + (n - 232) * 10;
  return `#${g.toString(16).padStart(2, "0").repeat(3)}`;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ansiToHtml(line) {
  let html = "", open = false, fg = null, bg = null, bold = false, italic = false;
  const close = () => { if (open) { html += "</span>"; open = false; } };
  const apply = () => { close();
    const style = [fg && `color:${fg}`, bg && `background:${bg}`, bold && "font-weight:600", italic && "font-style:italic"].filter(Boolean).join(";");
    if (style) { html += `<span style="${style}">`; open = true; } };
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
        if (c === 0) { fg = bg = null; bold = italic = false; }
        else if (c === 1) bold = true;
        else if (c === 3) italic = true;
        else if (c === 22) bold = false;
        else if (c === 23) italic = false;
        else if (c === 39) fg = null;
        else if (c === 49) bg = null;
        else if (c === 38 || c === 48) {
          const rgb = params[p + 1] === 2
            ? `#${params.slice(p + 2, p + 5).map((x) => x.toString(16).padStart(2, "0")).join("")}`
            : xterm256(params[p + 2] ?? 0);
          if (c === 38) fg = rgb; else bg = rgb;
          p += params[p + 1] === 2 ? 4 : 2;
        }
      }
      apply(); i = end + 1;
    } else { text += line[i]; i++; }
  }
  flush(); close();
  return html;
}

const frame = (lines, caption) => `
<figure class="term">
  <figcaption>${caption}</figcaption>
  <pre>${lines.map(ansiToHtml).join("\n")}</pre>
</figure>`;

// ── 输出 ──────────────────────────────────────────────────────────────────

const WIDE = 230;   // 用户截图里的终端宽度
const NORMAL = 120;

const currentWide = renderCurrent(WIDE);
const currentNormal = renderCurrent(NORMAL);
const aWide = renderProposedMeasure(WIDE);
const bWide = renderProposedGrouped(WIDE);
const cWide = renderProposedSummary(WIDE);
const aNormal = renderProposedMeasure(NORMAL);
const bNormal = renderProposedGrouped(NORMAL);

const which = process.argv.find((a) => a.startsWith("--print="))?.split("=")[1];
if (which !== undefined) {
  const table = { A: aNormal, B: bNormal, C: cWide, current: currentNormal };
  console.log((table[which] ?? currentNormal).join("\n"));
  process.exit(0);
}

const metrics = [
  { name: "现状", rows: currentWide.length, lost: lostColumns(WIDE) },
  { name: "A 限宽", rows: aWide.length, lost: 0 },
  { name: "B 限宽 + 归组", rows: bWide.length, lost: 0 },
  { name: "C B + 摘要", rows: cWide.length, lost: 0 },
];

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>对话区密度与行宽 · Epi TUI</title>
<style>
  :root { color-scheme: dark; } * { box-sizing: border-box; }
  body { margin:0; padding:48px 24px 96px; background:#0e0f11; color:#d4d4d8;
    font:15px/1.75 -apple-system,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif; }
  main { max-width: 1240px; margin: 0 auto; }
  h1 { font-size:26px; font-weight:650; color:#ececee; margin:0 0 6px; letter-spacing:-.01em; }
  h2 { font-size:19px; font-weight:650; color:#ececee; margin:52px 0 4px; }
  h3 { font-size:15px; font-weight:650; color:#c9c9cf; margin:26px 0 4px; }
  p, li { color:#a5a5ad; } p { margin:6px 0; max-width:76ch; }
  ul { margin:6px 0; padding-left:22px; } li { margin:3px 0; }
  code { font:13px ui-monospace,"SF Mono",Menlo,monospace; color:#9db8c4; }
  .sub { color:#71717a; font-size:14px; }
  figure.term { margin:16px 0 8px; border:1px solid #26282d; border-radius:10px; overflow:hidden;
    background:#161719; box-shadow:0 12px 32px rgba(0,0,0,.35); }
  figure.term figcaption { padding:8px 14px; font-size:12.5px; color:#8e8e96; background:#1c1d20;
    border-bottom:1px solid #26282d; display:flex; justify-content:space-between; gap:12px; }
  figure.term figcaption b { color:#c9c9cf; font-weight:600; }
  figure.term pre { margin:0; padding:14px 0 16px; overflow-x:auto;
    font:12.5px/1.5 ui-monospace,"SF Mono",Menlo,"Sarasa Mono SC",monospace; color:#e1e1e1; white-space:pre; }
  .legend { font-size:13.5px; color:#8e8e96; margin:4px 2px 28px; max-width:80ch; }
  .legend b { color:#c2c2c9; font-weight:600; }
  table.m { border-collapse:collapse; margin:14px 0; font-size:14px; }
  table.m th, table.m td { border:1px solid #26282d; padding:6px 14px; text-align:right; }
  table.m th { color:#8e8e96; font-weight:500; text-align:left; }
  table.m td:first-child { text-align:left; color:#a5a5ad; }
  .bad { color:#f7768e; } .good { color:#9ece6a; }
  .box { border:1px solid #332828; border-radius:8px; padding:16px 20px; background:#1a1618; margin:16px 0; }
</style></head><body><main>
  <h1>对话区为什么「乱」：行宽、归组、密度</h1>
  <p class="sub">用 <code>node scripts/probes/layout-density-probe.mjs</code> 生成。「现状」帧由 dist 里的真实组件（<code>toolBlock</code> + 内置渲染器）渲染，不是手绘。终端宽度 ${WIDE} 列，与你截图一致。</p>

  <div class="box">
    <p><b>结论：颜色不是主因。</b>截图里的乱来自三件事，按影响排序：</p>
    <ul>
      <li><b>① 行宽没有上限。</b>0.1.23 曾把正文限到 76 列；0.1.24 按「都应该支持终端全宽」的指示（提交 <code>b598fbe</code>，决策 L1）把 <code>measure.ts</code> 改成了 <code>Infinity</code>。于是 grep 结果那种 200+ 列的单行要么被截断丢字，要么整屏拉满，视线无法回到行首。</li>
      <li><b>② 连续的 bash 平铺不归组。</b>一轮 5 条命令 = 5 个同样灰的 <code>◆ bash</code> 块，看不到"这一轮一共跑了什么、都成了没有"。只读工具（read/grep/find/ls）早就有 <code>◈ Read 3 files</code> 的归组，bash 故意不合并——理由是命令本身要扫读。但 5 条以上时，代价大于收益。</li>
      <li><b>③ 每块输出自己占行数与提示行。</b><code>… +N lines (Ctrl+O to expand)</code> 单独占一行，5 块就是 5 行；curl 健康检查那种 8 行重复键值结构，结论其实只有「2 个 endpoint 都 200」。</li>
    </ul>
  </div>

  <h2>一、量化</h2>
  <table class="m">
    <tr><th>方案</th><th>行数（${WIDE} 列）</th><th>被截断丢失的列数</th></tr>
    ${metrics.map((m) => `<tr><td>${m.name}</td><td>${m.rows}</td><td class="${m.lost > 0 ? "bad" : "good"}">${m.lost > 0 ? m.lost : 0}</td></tr>`).join("\n    ")}
  </table>
  <p class="legend">「丢失列数」= 所有工具输出行中超出终端宽度的字符总数。现状不是折行而是截断，所以这些字**看不到**（要 Ctrl+O 进 inspector 才能看全）。A/B/C 三案在任何宽度下都不丢字。</p>

  <h2>二、现状</h2>
  ${frame(currentWide, `<b>现状 · ${WIDE} 列</b><span>dist 真实组件</span>`)}
  <p class="legend">注意：① grep 的 5 条结果中前 3 条被右侧截断；② 5 个 <code>$</code> 命令块连成一片，没有"这轮一共 5 条"的概念；③ curl 的 8 行 <code>HTTP 200 / Content-Type / ok</code> 占了 8 行；④ <code>… +71 lines</code> 独占一行。</p>

  <h2>三、三个提案</h2>

  <h3>A · 限宽（只改一件事）</h3>
  ${frame(aWide, `<b>A</b><span>工具输出与正文按 110 列折行，续行对齐内容列</span>`)}
  <p class="legend">代码块、表格、diff 仍然全宽——它们是数据，折行会破坏对齐。只把<b>叙述性输出</b>（grep 结果、散文、日志）折到 110 列。改动集中在 <code>measure.ts</code> 与 <code>tools/common.ts</code> 的折行，不动任何交互。</p>

  <h3>B · 限宽 + 连续 bash 归组</h3>
  ${frame(bWide, `<b>B</b><span>组头 <code>◈ 5 bash · all ok</code>，第一条展开，其余折成摘要行</span>`)}
  <p class="legend">组头回答"这轮跑了什么、都成了没有"。每条命令保留一行（命令本身要能扫读），但输出折叠。和只读工具的 <code>◈</code> 归组用同一个机制（<code>tools/group.ts</code>），Ctrl+O 展开。</p>

  <h3>C · B + 重复结构压成摘要</h3>
  ${frame(cWide, `<b>C</b><span>整轮 5 条命令 = 6 行；原始输出在 Ctrl+O 后面</span>`)}
  <p class="legend">最激进：连第一条也不展开，整轮工具调用压到组头 + 每命令一行摘要 + <code>Worked for</code>。适合"跑了一堆检查、只想看结论"的回合。风险是丢掉了"命令输出长什么样"的副信息，所以建议做成 <span class="kbd">/settings</span> 里的密度档位。</p>

  <h2>四、${NORMAL} 列下</h2>
  ${frame(currentNormal, `<b>现状 · ${NORMAL} 列</b><span>dist 真实组件</span>`)}
  ${frame(aNormal, `<b>A · ${NORMAL} 列</b><span>折行</span>`)}
  ${frame(bNormal, `<b>B · ${NORMAL} 列</b><span>归组</span>`)}
  <p class="legend">窄终端下现状的截断更严重（丢失列数更多）。A/B 在这里的差别变小——归组的价值主要在窄屏，因为一行放不下几条命令。</p>

  <h2>五、和颜色提案的关系</h2>
  <p class="sub">另一个 probe（<code>theme-color-probe.mjs</code>）提的 P1/P2/P3 是<b>层的区分</b>（哪条是 shell、哪条是文件操作）。本文的 A/B/C 是<b>行宽与密度</b>。两者独立，可以分别落地；但先做行宽——它解决的是"读不下去"，颜色解决的是"分不清"。</p>
  <p class="sub">复现：<code>node scripts/probes/layout-density-probe.mjs</code>；终端直看：<code>--print=A|B|C|current</code>。</p>
</main></body></html>`;

mkdirSync(join(ROOT, "reports"), { recursive: true });
const out = join(ROOT, "reports", "layout-density-probe.html");
writeFileSync(out, html);
console.log(`wrote ${out}`);
for (const m of metrics) console.log(`${m.name}: ${m.rows} rows, lost ${m.lost} columns`);
