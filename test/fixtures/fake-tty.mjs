// Preload (`node --import`) that makes the real `mmp` CLI take its interactive TUI path with piped
// stdin/stdout, so a test can drive the whole process -- cli.ts, host.ts, runTuiV2, pi-tui's own
// ProcessTerminal -- and see whether the process itself exits (tui-harness.mjs calls runTuiApp
// directly and exits on its own, so it can't tell). Raw-mode switches are appended to
// MMP_FAKE_TTY_LOG, one `raw=<bool>` line each, so the test can check the terminal was put back.
import { appendFileSync } from "node:fs";

process.stdin.isTTY = true;
process.stdout.isTTY = true;
process.stdout.columns = 120;
process.stdout.rows = 40;
// Cooked, like a shell's terminal: pi-tui restores whatever isRaw was at start when it stops.
process.stdin.isRaw = false;
process.stdin.setRawMode = (mode) => {
  if (process.env.MMP_FAKE_TTY_LOG) appendFileSync(process.env.MMP_FAKE_TTY_LOG, `raw=${mode}\n`);
  return process.stdin;
};
