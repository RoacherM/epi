// Records a release's feature showcase (docs/showcase/<version>/) from the real Epi TUI.
// Usage and prerequisites: docs/showcase/README.md. `node scripts/docs/capture-showcase.mjs 0.1.22`
//
// The scenario (scripts/docs/showcase/<version>.mjs) is an ordinary Epi extension that registers a
// scripted, offline model; its named exports describe the demo project, what to type, and which
// clips and stills to cut. Tools really run, inside a temporary HOME. Frames are xterm's cells,
// sampled while the app runs and rasterized by render-terminal.py; nothing on screen is re-created.
//
// Two processes, like capture-ui.mjs: this one prepares the temporary HOME, then runs itself again
// with an allowlisted environment to record (Pi must see the temporary HOME from its first import);
// back here it rasterizes the frames and cuts the clips with ffmpeg.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scenarioFile = (version) => join(root, "scripts/docs/showcase", `${version}.mjs`);

if (process.env.EPI_SHOWCASE_RECORD) await record(JSON.parse(process.env.EPI_SHOWCASE_RECORD));
else await main(process.argv[2]);

async function main(version) {
  assert.ok(version, "usage: node scripts/docs/capture-showcase.mjs <version>");
  assert.ok(existsSync(scenarioFile(version)), `no scenario at ${scenarioFile(version)}`);
  const scenario = await import(pathToFileURL(scenarioFile(version)).href);
  const outDir = join(root, "docs/showcase", version);
  const temp = mkdtempSync(join(tmpdir(), "epi-showcase-"));
  const home = join(temp, "home");
  // A fixed path: the scenario's commands refer to it (`cd ~/Projects/epi && …`).
  const cwd = join(home, "Projects", "epi");
  try {
    for (const [path, content] of Object.entries(scenario.files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    mkdirSync(join(home, ".epi", "pi"), { recursive: true });
    writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1, extensions: [scenarioFile(version)] }));
    const capture = join(temp, "capture.json");
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd,
      // Deliberately allowlisted: no credentials, user config, or NODE_OPTIONS.
      env: {
        PATH: dirname(process.execPath) + ":/usr/bin:/bin",
        HOME: home, EPI_HOME: join(home, ".epi"), EPI_OFFLINE: "1", EPI_DISABLE_UPDATE_CHECK: "1",
        TERM: "xterm-256color", COLORTERM: "truecolor", COLORFGBG: "15;0",
        EPI_SHOWCASE_RECORD: JSON.stringify({ version, cwd, out: capture }),
      },
      encoding: "utf8", stdio: ["ignore", "inherit", "inherit"], timeout: 120_000,
    });
    assert.equal(run.status, 0, run.error?.message ?? "recording failed (see above)");
    const { columns, rows, frames, times, marks, stills } = JSON.parse(readFileSync(capture, "utf8"));

    // Rasterize every frame once; clips and stills pick from them.
    const pngs = join(temp, "frames");
    const render = spawnSync(process.env.PYTHON ?? "python3", [join(root, "scripts/docs/render-terminal.py"), pngs], {
      input: JSON.stringify({ columns, rows, frames }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(render.status, 0, render.stderr || render.error?.message);

    mkdirSync(outDir, { recursive: true });
    const ffmpeg = (args) => {
      const done = spawnSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { encoding: "utf8" });
      assert.equal(done.status, 0, done.stderr || done.error?.message);
    };
    const pick = (name, table) => {
      assert.ok(name in table, `the scenario never marked ${name}`);
      return table[name];
    };
    for (const clip of scenario.clips) {
      const from = pick(clip.from, marks);
      const to = clip.to === undefined ? frames.length : pick(clip.to, marks);
      // Sampling runs slower than its interval (each frame costs a screen read): play at the measured rate.
      const fps = ((to - from - 1) * 1000 / (times[to - 1] - times[from])).toFixed(3);
      const input = ["-framerate", fps, "-start_number", String(from), "-i", join(pngs, "frame-%04d.png"), "-frames:v", String(to - from)];
      ffmpeg([...input, "-vf", "scale=1200:-2:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "slow",
        "-movflags", "+faststart", join(outDir, `${clip.name}.mp4`)]);
      if (clip.gif) {
        ffmpeg([...input, "-vf", "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
          "-loop", "0", join(outDir, `${clip.name}.gif`)]);
      }
      console.log(`${join(outDir, clip.name)}: ${to - from} frames at ${fps} fps`);
    }
    for (const name of scenario.stills) {
      const index = String(pick(name, stills)).padStart(4, "0");
      copyFileSync(join(pngs, `frame-${index}.png`), join(outDir, `${name}.png`));
      console.log(join(outDir, `${name}.png`));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function record({ version, cwd, out }) {
  // First, like dist/cli.js: EPI_* -> PI_* before any Pi module loads (src/pi-env.ts).
  await import("../../dist/isolate-pi-env.js");
  const { default: xterm } = await import("@xterm/headless");
  const { prepareEpiRun } = await import("../../dist/host.js");
  const { runTuiApp } = await import("../../dist/tui/app.js");
  const { createRuntimeFromPrepared, projectIdentityFromPrepared } = await import("../../dist/tui/start.js");
  const { installEpiTheme } = await import("../../dist/tui/theme.js");
  const scenario = await import(pathToFileURL(scenarioFile(version)).href);
  const { columns = 104, rows = 30 } = scenario;
  const SAMPLE_MS = 50;

  // The same in-memory terminal as test/fixtures/tui-harness.mjs.
  const screen = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true });
  let onInput = () => {};
  const terminal = {
    start(input) { onInput = input; },
    stop() {},
    async drainInput() {},
    write(data) { screen.write(data); },
    get columns() { return columns; },
    get rows() { return rows; },
    get kittyProtocolActive() { return false; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {},
  };

  const prepared = prepareEpiRun(["--no-project", "--offline", "--thinking", "medium"]);
  const theme = installEpiTheme(prepared.agentDir, "dark");
  const runtime = await createRuntimeFromPrepared(prepared, cwd);
  // Ready once the first model refresh settles (tui-harness.mjs's waitReady).
  let ready = false;
  const modelRuntime = runtime.services.modelRuntime;
  const refresh = modelRuntime.refresh.bind(modelRuntime);
  modelRuntime.refresh = async (...args) => {
    try { return await refresh(...args); } finally { setImmediate(() => { ready = true; }); }
  };
  const running = runTuiApp({
    runtime, theme, cwd, agentDir: prepared.agentDir, logDirectory: prepared.agentDir,
    projectIdentity: projectIdentityFromPrepared(prepared, cwd), resumeOnStart: false, terminal,
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const settle = () => new Promise((resolve) => screen.write("", resolve));
  const text = () => {
    const buffer = screen.buffer.active;
    return Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n");
  };
  const cells = () => {
    const buffer = screen.buffer.active;
    return Array.from({ length: rows }, (_, y) => Array.from({ length: columns }, (_, x) => {
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
  };

  const frames = [];
  const times = [];
  const marks = {};
  const stills = {};
  let sampler;
  let sampling = false;
  const KEYS = { enter: "\r", tab: "\t", esc: "\x1b" };
  const matches = (pattern) => (typeof pattern === "string" ? text().includes(pattern) : pattern.test(text()));
  const driver = {
    sleep,
    key: (name) => onInput(KEYS[name] ?? name),
    async type(value) {
      onInput(`\x1b[200~${value}\x1b[201~`);
      await sleep(260);
      onInput("\r");
    },
    async waitFor(pattern, { timeoutMs = 15000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await settle();
        if (matches(pattern)) return;
        if (Date.now() > deadline) throw new Error(`never showed ${pattern}. Screen:\n${text()}`);
        await sleep(15);
      }
    },
    async expect(pattern) {
      await settle();
      assert.ok(matches(pattern), `expected ${pattern} on screen. Screen:\n${text()}`);
    },
    record() {
      sampling = true;
      sampler = (async () => {
        while (sampling) {
          await settle();
          frames.push(cells());
          times.push(Date.now());
          await sleep(SAMPLE_MS);
        }
      })();
    },
    mark(name) { marks[name] = frames.length; },
    // The next sampled frame, so the still shows the screen as it is now.
    async still(name) {
      const next = frames.length + 1;
      while (frames.length < next) await sleep(5);
      stills[name] = frames.length - 1;
    },
  };

  while (!ready) await sleep(10);
  await sleep(60);
  await scenario.play(driver);
  sampling = false;
  await sampler;
  writeFileSync(out, JSON.stringify({ columns, rows, frames, times, marks, stills }));
  onInput("\x04");
  await Promise.race([running, sleep(5000)]);
  process.exit(0);
}
