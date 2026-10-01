// Usage and rasterizer prerequisites: docs/assets/README.md.
// Capture the real app's ANSI output, then rasterize xterm's cells. No UI is re-created here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "mmp-ui-"));
const home = join(temp, "home");
const cwd = join(home, "Projects", "mmp-demo");
const columns = 120;
const rows = 34;
try {
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
  writeFileSync(join(cwd, "src", "greet.js"), 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n');
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({
    version: 1, extensions: [join(root, "scripts/docs/ui-demo.mjs")],
  }));
  const steps = [
    ["waitReady"], ["screen", "welcome"], ["rawMark", "welcome"],
    ["paste", "Make the greeting handle whitespace and empty names. Check the syntax."],
    ["key", "enter"],
    ["waitFor", { regex: "passed\\.[\\s\\S]*Worked for" }],
    // At this fixed viewport size, click the real edit card to reveal its diff.
    ["mouse", { x: 4, y: 12 }], ["wait", 100],
    ["screen", "session"], ["rawMark", "session"],
    ["key", "ctrl+d"],
  ];
  const run = spawnSync(process.execPath, [join(root, "test/fixtures/tui-harness.mjs")], {
    cwd,
    // Deliberately allowlist the environment: no credentials, user config, or NODE_OPTIONS.
    env: {
      PATH: dirname(process.execPath) + ":/usr/bin:/bin",
      HOME: home, MMP_HOME: join(home, ".mmp"),
      PI_OFFLINE: "1", MMP_DISABLE_UPDATE_CHECK: "1",
      TERM: "xterm-256color", COLORTERM: "truecolor", COLORFGBG: "15;0",
      MMP_TUI_HARNESS: JSON.stringify({
        columns, rows, args: ["--no-project", "--offline", "--thinking", "medium"], steps,
      }),
    },
    encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const capture = JSON.parse(run.stdout);
  assert.equal(capture.exit, 0);
  const session = capture.screens.session.join("\n");
  assert.match(session, /node --check src\/greet.js.*passed/);
  assert.match(session, /exit 0/);
  assert.match(session, /const displayName = name.trim/);
  assert.match(readFileSync(join(cwd, "src/greet.js"), "utf8"), /const displayName = name.trim\(\) \|\| "world";/);
  for (const [mark, filename] of [["welcome", "mmp-welcome.png"], ["session", "mmp-ui.png"]]) {
    const terminal = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
    await new Promise((resolve) => terminal.write(capture.marks[mark], resolve));
    const buffer = terminal.buffer.active;
    const cells = Array.from({ length: rows }, (_, y) => Array.from({ length: columns }, (_, x) => {
      const cell = buffer.getLine(buffer.viewportY + y).getCell(x);
      return {
        text: cell.getChars(), width: cell.getWidth(),
        fg: cell.getFgColor(), fgMode: cell.getFgColorMode(),
        bg: cell.getBgColor(), bgMode: cell.getBgColorMode(),
        bold: !!cell.isBold(), italic: !!cell.isItalic(), dim: !!cell.isDim(),
        inverse: !!cell.isInverse(), underline: !!cell.isUnderline(), strike: !!cell.isStrikethrough(),
        invisible: !!cell.isInvisible(),
      };
    }));
    const out = join(root, "docs/assets", filename);
    mkdirSync(dirname(out), { recursive: true });
    const render = spawnSync(process.env.PYTHON ?? "python3", [join(root, "scripts/docs/render-terminal.py"), out], {
      input: JSON.stringify({ columns, rows, cells }), encoding: "utf8",
    });
    assert.equal(render.status, 0, render.stderr || render.error?.message);
    terminal.dispose();
    console.log(out);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
