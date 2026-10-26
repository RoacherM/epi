#!/usr/bin/env node
// Probe: "双下巴" —— 底部 chrome 行重复（状态栏 / 回合状态 / 快捷键条同一帧出现两次）。
//
// 用法：
//   node scripts/probes/double-chin-probe.mjs
//       把真实 app 跑在 in-memory 终端里，遍历一组场景，对每一帧给底部行分类，
//       断言每种 chrome 行最多出现一次，并打印各场景的行尾表。
//
//   node scripts/probes/double-chin-probe.mjs --capture <file> [--cols 120] [--rows 40]
//       回放真实终端抓到的 PI_TUI_WRITE_LOG（原始 ANSI 字节），逐帧做同样的分类。
//       这是在你自己的机器上抓「双下巴」现场的办法：
//         PI_TUI_WRITE_LOG=/tmp/epi-capture epi      # 复现问题后退出
//         node scripts/probes/double-chin-probe.mjs --capture /tmp/epi-capture/tui-*.log
//
// 为什么值得单独一个探针：`doRender()` 只在行内容变化时重画该行，所以「本该清掉却没清」
// 的行不会出现在后续输出里，只能在**屏幕快照**上看见。用户报的正是屏幕快照。

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import xterm from "@xterm/headless";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const HARNESS = join(ROOT, "test", "fixtures", "tui-harness.mjs");
const FAUX_QUEUE = join(ROOT, "test", "fixtures", "faux-queue.mjs");
const FAUX_MULTILINE = join(ROOT, "test", "fixtures", "faux-multiline-status.mjs");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const capturePath = flag("capture", undefined);
const CAPTURE_COLS = Number(flag("cols", 120));
const CAPTURE_ROWS = Number(flag("rows", 40));

// ── 行分类 ───────────────────────────────────────────────────────────────────
// 每种角色对应一条底部 chrome 行。正常一帧里每种最多 1 行。
// 分类只认形状，不认具体内容，所以模型名/耗时变化不影响判定。

/** 带标签的下边框：`╰──── label ────╯` 或 `└──── label ────┘`。 */
const LABELLED_BOTTOM = /[╰└]─+ .+ ─+[╯┘]\s*$/;
/** 粘贴预览盒的标签（同样是带标签的下边框，但是合法存在的第二个盒子）。 */
const PREVIEW_LABEL = /paste again|expand/;

/** 一帧的底部行 → 角色列表。 */
function classify(row) {
  const text = row.replace(/\s+$/, "");
  const plain = text.trimStart();
  const roles = [];
  if (LABELLED_BOTTOM.test(text)) {
    roles.push(PREVIEW_LABEL.test(text) ? "previewBottom" : "promptBottom");
  }
  // 回合状态行：`+ Running bash… 0.0s` … 右对齐 `… [stop]`
  if (/^[+×] .+\s\[stop\]\s*$/.test(plain)) roles.push("turnStatus");
  // 快捷键条：至少两个 `Key:label` 片段
  if ((plain.match(/\S+:(?:stop|cancel|effort|commands|expand|steer|select|confirm)\b/g) ?? []).length >= 2) {
    roles.push("footer");
  }
  if (/^[╭┌]/.test(plain)) roles.push("frameTop");
  return roles;
}

/** 重复 = 同一角色在同一帧出现 >1 次。previewBottom / frameTop 不参与判定：粘贴预览盒
 * 合法地在 prompt frame 上方再画一个带 `╭`/`╰` 的盒子，所以这两个形状本来就可能是 2 个。 */
const SOLE_ROLES = ["promptBottom", "turnStatus", "footer"];

/** 下边框被劈成两半：`╰─` 开头的那半截没有收尾的 `╯`，而收尾的 `─╯` 落在了另一行上
 * （典型是被覆盖到 footer 行里）。只认「除了框线字符还有别的内容」的行，避免把
 * 欢迎卡那种纯边框误判。 */
function splitBorders(rows) {
  const NON_BOX = /[^\s─╭┌╮┐╰└╯┘├┤┬┴│┃]/;
  const found = [];
  for (const [index, row] of rows.entries()) {
    const text = row.replace(/\s+$/, "");
    const roles = classify(row);
    if (roles.includes("promptBottom") || roles.includes("previewBottom")) continue;
    if (!NON_BOX.test(text)) continue;
    const hasTail = /─+[╯┘]\s*$/.test(text);
    const hasHead = /^\s*[╰└]─+ /.test(text);
    if (hasTail || (hasHead && !hasTail)) found.push(index);
  }
  return found;
}

/** 布局里 footer 之后只剩一个空行（app.ts 的 VStack 末尾）。footer 下面还有可见内容，
 * 说明有东西画到了自己的槽位之外 —— 用户截图里的 `for pat in` 就在这个位置。 */
function contentBelowFooter(rows) {
  const footerRow = rows.findIndex((row) => classify(row).includes("footer"));
  if (footerRow === -1) return [];
  return rows
    .map((row, index) => ({ row: row.replace(/\s+$/, ""), index }))
    .filter(({ row, index }) => index > footerRow && row !== "")
    .map(({ index }) => index);
}

function duplicates(rows) {
  const seen = new Map();
  rows.forEach((row, index) => {
    for (const role of classify(row)) {
      if (!seen.has(role)) seen.set(role, []);
      seen.get(role).push(index);
    }
  });
  const found = [...seen.entries()]
    .filter(([role, indexes]) => SOLE_ROLES.includes(role) && indexes.length > 1)
    .map(([role, indexes]) => ({ role, rows: indexes }));
  const below = contentBelowFooter(rows);
  if (below.length > 0) found.push({ role: "contentBelowFooter", rows: below });
  const split = splitBorders(rows);
  if (split.length > 0) found.push({ role: "splitBorder", rows: split });
  return found;
}

function tail(rows, count = 12) {
  const from = Math.max(0, rows.length - count);
  return rows.slice(from).map((row, index) => `${String(from + index).padStart(2)} |${row}|`).join("\n");
}

// ── 模式 1：真实 app × 场景矩阵 ──────────────────────────────────────────────

const SCENARIOS = [
  {
    name: "idle 120x30",
    cols: 120, rows: 30,
    steps: [["waitReady"], ["wait", 400], ["screen", "s"]],
  },
  {
    name: "idle 100x17 (chrome 高度临界点附近)",
    cols: 100, rows: 17,
    steps: [["waitReady"], ["wait", 400], ["screen", "s"]],
  },
  {
    name: "streaming + 单行草稿",
    cols: 120, rows: 30,
    steps: [["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "FIRST-START"], ["wait", 300], ["screen", "s"]],
  },
  {
    name: "streaming + 多行草稿（编辑器高于 minSize 3）",
    cols: 120, rows: 30,
    steps: [
      ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "FIRST-START"],
      ["paste", "for pat in a b c d e f g h\n do echo $pat\ndone\n"], ["wait", 300], ["screen", "s"],
    ],
  },
  {
    name: "streaming + 长草稿（body 撑满、布局被压缩）",
    cols: 100, rows: 22,
    steps: [
      ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "FIRST-START"],
      ["paste", Array.from({ length: 14 }, (_, i) => `line${i} for pat in x y z`).join("\n") + "\n"],
      ["wait", 300], ["screen", "s"],
    ],
  },
  {
    name: "streaming + 排队消息（queueDisplay 出现）",
    cols: 100, rows: 24,
    steps: [
      ["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "FIRST-START"],
      ["type", "queued follow-up"], ["key", "enter"], ["waitFor", "Follow-up:"], ["screen", "s"],
    ],
  },
  {
    name: "窄终端 60x20",
    cols: 60, rows: 20,
    steps: [["waitReady"], ["type", "go"], ["key", "enter"], ["waitFor", "FIRST-START"], ["screen", "s"]],
  },
  // 下面三条用 faux-multiline-status.mjs：扩展把一个带换行的字符串塞进单行组件。
  // 这三条现在**应该报重复** —— 它们是这个探针的阳性对照。
  {
    name: "[阳性] 扩展 status 带换行（footer 右侧）",
    cols: 100, rows: 20, extensions: [FAUX_MULTILINE],
    steps: [["waitReady"], ["type", "/setmultiline"], ["key", "enter"], ["wait", 500], ["screen", "s"]],
  },
  {
    name: "[阳性] 扩展 statusLine 带换行（输入框下边框标签）",
    cols: 100, rows: 20, extensions: [FAUX_MULTILINE],
    steps: [["waitReady"], ["type", "/setmultilinestatusline"], ["key", "enter"], ["wait", 500], ["screen", "s"]],
  },
  {
    name: "[阴性] 扩展 status 单行（同样的文本，不带换行）",
    cols: 100, rows: 20, extensions: [FAUX_MULTILINE],
    steps: [["waitReady"], ["type", "/setstatusone"], ["key", "enter"], ["wait", 500], ["screen", "s"]],
  },
];

function runScenario(scenario) {
  const root = mkdtempSync(join(tmpdir(), "epi-chin-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".epi"), { recursive: true });
  const extensions = scenario.extensions ?? [FAUX_QUEUE];
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions }));
  const result = spawnSync(process.execPath, [HARNESS], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      EPI_HOME: join(home, ".epi"),
      EPI_OFFLINE: "1",
      EPI_TUI_HARNESS: JSON.stringify({
        steps: scenario.steps,
        args: ["--no-project"],
        columns: scenario.cols,
        rows: scenario.rows,
      }),
    },
    encoding: "utf8",
    timeout: 90_000,
  });
  if (result.status !== 0) {
    return { name: scenario.name, error: `harness exited ${result.status}: ${result.stderr.slice(-800)}` };
  }
  const rows = JSON.parse(result.stdout).screens.s;
  return { name: scenario.name, rows, duplicates: duplicates(rows) };
}

// ── 模式 2：回放真实终端抓包 ─────────────────────────────────────────────────

/** 抓包是原始字节流；按 synchronized-output 分帧，顺序喂给 headless xterm，逐帧看屏幕。
 * 逐帧而不是只看最后一帧：重复行可能被之后的一次整屏重画洗掉，但用户看到过它。 */
async function replayCapture(path) {
  // 按**字节**切帧，不按字符串：框线字符是多字节 UTF-8，用 latin1 解码会拆散字符、
  // 让 xterm 的列计数错位（抓包就是原始 UTF-8 字节）。
  const raw = readFileSync(resolve(path));
  const FRAME_START = Buffer.from("\x1b[?2026h");
  const FRAME_END = Buffer.from("\x1b[?2026l");

  const terminal = new xterm.Terminal({ cols: CAPTURE_COLS, rows: CAPTURE_ROWS, allowProposedApi: true });
  const write = (chunk) => new Promise((done) => terminal.write(chunk, done));
  const readScreen = () => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: CAPTURE_ROWS }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
  };

  const frames = [];
  let index = 0;
  while (index < raw.length) {
    const start = raw.indexOf(FRAME_START, index);
    if (start === -1) break;
    const end = raw.indexOf(FRAME_END, start);
    if (end === -1) break;
    index = end + FRAME_END.length;
    frames.push(raw.subarray(start, index));
  }

  const findings = [];
  for (const [frameIndex, frame] of frames.entries()) {
    await write(frame);
    const rows = readScreen();
    const duplicatesHere = duplicates(rows);
    if (duplicatesHere.length > 0) findings.push({ frameIndex, rows, duplicates: duplicatesHere });
  }
  return { frameCount: frames.length, findings };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

if (capturePath !== undefined) {
  const { frameCount, findings } = await replayCapture(capturePath);
  console.log(`抓包：${resolve(capturePath)}`);
  console.log(`分帧：${frameCount} 帧 · 终端 ${CAPTURE_COLS}x${CAPTURE_ROWS}`);
  if (frameCount === 0) {
    // 没有 synchronized-output 标记 = 不是一个 pi-tui alt-screen 抓包（空文件、抓错了进程、
    // 或者用 PI_TUI_WRITE_LOG 指向了目录但目录里还没文件）。不当作“通过”。
    console.log("\n结论：抓包里没有可供分析的帧；确认文件来自 Epi 的 alt-screen 运行。");
    process.exit(2);
  }
  if (findings.length === 0) {
    console.log("\n结论：没有任何一帧出现重复的 chrome 行。");
    process.exit(0);
  }
  await Promise.resolve();
  const first = findings[0];
  console.log(`\n结论：${findings.length} 帧出现重复，第一帧是第 ${first.frameIndex} 帧`);
  console.log(`  重复：${first.duplicates.map((d) => `${d.role} @ rows ${d.rows.join(",")}`).join("; ")}`);
  console.log(`\n该帧的尾部：\n${tail(first.rows, 14)}`);
  process.exit(1);
}

let failures = 0;
for (const scenario of SCENARIOS) {
  const result = runScenario(scenario);
  console.log(`\n===== ${result.name} =====`);
  if (result.error !== undefined) {
    failures += 1;
    console.log(`  运行失败：${result.error}`);
    continue;
  }
  const dup = result.duplicates;
  const expected = result.name.startsWith("[阳性]");
  if (dup.length === 0) {
    if (expected) {
      failures += 1;
      console.log("  ✗ 期望复现，但没有重复（阳性对照失效 = 探针没有检测能力）");
      console.log(tail(result.rows, 10).split("\n").map((line) => `  ${line}`).join("\n"));
    } else {
      console.log("  ✓ chrome 行不重复，footer 下面也没有内容");
    }
  } else if (expected) {
    console.log(`  ✓ 如期复现：${dup.map((d) => `${d.role} @ ${d.rows.join(",")}`).join("; ")}`);
  } else {
    failures += 1;
    console.log(`  ✗ 重复：${dup.map((d) => `${d.role} 出现在行 ${d.rows.join(", ")}`).join("; ")}`);
    console.log(tail(result.rows, 14).split("\n").map((line) => `  ${line}`).join("\n"));
  }
}

console.log(`\n${failures === 0 ? "全部场景通过" : `${failures} 个场景发现重复`}`);
process.exit(failures === 0 ? 0 : 1);
