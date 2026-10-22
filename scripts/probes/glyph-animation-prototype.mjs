// docs/tui-glyphs-design.md §3 prototype: the rotating x over a scripted turn -- an even turn while
// a call runs, two quick shakes when it lands, then its kind glyph (or a red × on failure).
// Usage: node scripts/probes/glyph-animation-prototype.mjs [out.json], then rasterize with
// scripts/docs/render-terminal.py and encode with ffmpeg (commands in docs/tui-glyphs-design.md §6).
import { writeFileSync } from "node:fs";
const C = { accent: "#bb9af7", bash: "#e0af68", muted: "#6c6c6c", error: "#f7768e", success: "#9ece6a", text: "#e1e1e1", dim: "#585858", border: "#323237", cyan: "#7dcfff", out: "#c8c8c8" };
const hex = (h) => parseInt(h.slice(1), 16);
const TICK = 80; // ms, Epi's MOTION_TICK
const COLS = 78, ROWS = 12;
// Running: a quarter turn every 4 ticks (320ms), evenly.
const turn = [["+", 4], ["×", 4]];
// Landing: two quick shakes (1 tick each), then the call settles.
const SHAKE = ["×", "+", "×", "+"];
function frameOf(seq, tick, offset = 0) {
  const total = seq.reduce((n, [, d]) => n + d, 0);
  let t = (tick + offset) % total;
  for (const [g, d] of seq) { if (t < d) return g; t -= d; }
  return seq[0][0];
}
// Scripted turn (ms): each row runs from start to end; status at end.
const script = [
  { kind: "think", label: "Thinking…", settled: "◇ 1.2s", start: 0, end: 1200 },
  { kind: "tool", marker: "◆", color: C.muted, body: "read src/web/fuse.ts · 120 lines", start: 1300, end: 1700 },
  { kind: "tool", marker: "$", color: C.bash, body: "npm test -- test/web-fuse.test.mjs", start: 1800, end: 4200 },
  { kind: "tool", marker: "◆", color: C.muted, body: "search \"rrf fusion k=60\" · exa ✗", start: 1900, end: 3300, fail: true },
  { kind: "tool", marker: "◆", color: C.muted, body: "edit src/web/fuse.ts · +12 −3", start: 4300, end: 4700 },
];
const DURATION = 6200;
function cells(text, color, bold = false) { return [...text].map((ch) => ({ text: ch, color, bold })); }
function line(parts) { const row = parts.flat(); while (row.length < COLS) row.push({ text: " ", color: C.text }); return row.slice(0, COLS); }
function marker(s, now, tick, phase) {
  if (now < s.end) return { glyph: frameOf(turn, tick, phase), color: C.accent, bold: true };
  const landed = Math.floor((now - s.end) / TICK);
  if (landed < SHAKE.length) return { glyph: SHAKE[landed], color: s.fail ? C.error : C.accent, bold: true };
  if (s.fail) return { glyph: "×", color: C.error };
  if (s.kind === "think") return { glyph: "◇", color: C.dim };
  return { glyph: s.marker, color: now - s.end < 400 + SHAKE.length * TICK ? C.success : s.color };
}
function render(now, title) {
  const tick = Math.floor(now / TICK);
  const rows = [line([cells(`  ${title}`, C.dim)]), line([])];
  rows.push(line([cells("    ❯ ", C.muted), cells("make the fusion test pass", C.text)]), line([]));
  script.forEach((s, i) => {
    if (now < s.start) return;
    const m = marker(s, now, tick, i * 2);
    const done = now >= s.end + SHAKE.length * TICK;
    if (s.kind === "think") {
      rows.push(line([cells("   │ ", C.border), cells(m.glyph, m.color, m.bold), cells(" ", C.text), cells(done ? s.settled.slice(2) : s.label, done ? C.dim : C.cyan)]));
      return;
    }
    const flash = done && !s.fail && now - s.end < 400 + SHAKE.length * TICK;
    rows.push(line([cells("   ├─", flash ? C.success : s.fail && done ? C.error : C.border), cells(m.glyph, m.color, m.bold), cells(" ", C.text), cells(s.body, C.out)]));
    if (s.fail && done) rows.push(line([cells("   ├─  ", C.error), cells("✗ exa: 401 invalid API key", C.error)]));
  });
  if (now > 5000) rows.push(line([cells("   ╰─ ", C.border), cells("Worked for 4.8s", C.dim)]));
  while (rows.length < ROWS) rows.push(line([]));
  return rows;
}
const frames = [];
for (let now = 0; now < DURATION; now += 40) {
  const rows = render(now, "an even turn while running · two quick shakes when it lands");
  frames.push(rows.map((row) => row.map((c) => ({ text: c.text, width: 1, fg: hex(c.color), fgMode: 0x3000000, bg: 0, bgMode: 0, bold: !!c.bold, italic: false, dim: false, inverse: false, underline: false, strike: false, invisible: false }))));
}
writeFileSync(process.argv[2] ?? "reports/glyph-prototype/frames.json", JSON.stringify({ columns: COLS, rows: ROWS, frames }));
console.log(frames.length, "frames");
