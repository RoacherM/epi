// /settings (docs/tui-design.md 4.6): MMP's cut-down version of Pi's SettingsSelectorComponent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** A temp HOME/MMP_HOME and project dir; `run` can be called more than once to restart the app on
 * the same settings.json. */
function makeEnv(t, { extension = "faux-echo.mjs", settings } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mmp-tui-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".mmp", "pi"), { recursive: true });
  mkdirSync(project);
  writeFileSync(join(home, ".mmp", "mmp.json"), JSON.stringify({ version: 1, extensions: [fixture(extension)] }));
  const settingsFile = join(home, ".mmp", "pi", "settings.json");
  if (settings !== undefined) writeFileSync(settingsFile, JSON.stringify(settings));
  return {
    root, home, project, settingsFile,
    readSettings: () => JSON.parse(readFileSync(settingsFile, "utf8")),
    run(steps, { rows, env = {} } = {}) {
      const result = spawnSync(process.execPath, [harness], {
        cwd: project,
        env: {
          PATH: process.env.PATH, HOME: home, MMP_HOME: join(home, ".mmp"), PI_OFFLINE: "1", ...env,
          MMP_TUI_HARNESS: JSON.stringify({ steps, ...(rows ? { rows } : {}) }),
        },
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.exit, 0);
      return parsed;
    },
  };
}

/** Open /settings, pick `label` through the search box, press Enter `times` times (each press moves
 * to the next value), then Esc. */
const change = (label, times = 1) => [
  ["type", "/settings"], ["key", "enter"], ["waitFor", "Type to search"],
  ["type", label], ["wait", 50],
  ...Array.from({ length: times }, () => ["key", "enter"]),
  ["key", "esc"], ["wait", 150],
];
const quit = [["key", "ctrl+c"], ["wait", 100], ["key", "ctrl+d"]];
const after = (marks, from, to) => marks[to].slice(marks[from].length);

const SHOWN = [
  "Auto-compact", "Auto-resize images", "Block images", "Skill commands", "Show hardware cursor",
  "Autocomplete max items", "Steering mode", "Follow-up mode", "Transport", "HTTP idle timeout",
  "Cache warming", "Tree filter mode", "Fullscreen scrollbar", "Fullscreen copy on select",
  "Fullscreen wheel scrolling",
];
// Pi's items MMP leaves out, and why: docs/tui-design.md 4.6. "Show images"/"Image width" only
// exist in Pi's list when the terminal can draw images.
const HIDDEN = [
  "Show images", "Image width", "Editor padding", "Output padding", "Clear on shrink", "Terminal progress",
  "Hide thinking", "Mermaid diagrams", "Cache miss notices", "Collapse changelog", "Quiet startup",
  "Install telemetry", "Default project trust", "Double-escape action", "Warnings",
  "Default thinking level per model", "TUI mode", "Fullscreen exit output", "Theme",
];
// Pi's wording names keys or behaviour MMP does not have (see src/tui/settings-command.ts).
const OWN_DESCRIPTION = new Set(["steering-mode", "follow-up-mode", "fullscreen-copy-on-select"]);

test("/settings lists MMP's 15 items and none of the ones it leaves out", (t) => {
  const env = makeEnv(t);
  const { marks } = env.run([
    ["waitReady"], ["mark", "start"],
    ["type", "/settings"], ["key", "enter"], ["waitFor", "Type to search"],
    ...Array.from({ length: SHOWN.length - 1 }, () => ["key", "down"]),
    ["waitFor", `(${SHOWN.length}/${SHOWN.length})`], ["mark", "walked"],
    ["type", "Default project trust"], ["waitFor", "No matching settings"], ["mark", "searched"],
    ["key", "esc"], ["wait", 100], ...quit,
  ]);
  const list = after(marks, "start", "walked");
  for (const label of SHOWN) assert.match(list, new RegExp(`→ ${label} `), label);
  for (const label of HIDDEN) assert.doesNotMatch(list, new RegExp(`${label} {2,}`), label);
  assert.match(after(marks, "walked", "searched"), /No matching settings/);
});

test("Esc closes /settings and gives the prompt its keys back (e2e K1: Shift+Tab, Ctrl+V)", (t) => {
  const env = makeEnv(t, { extension: "faux-reasoning-model.mjs" });
  const clipboard = join(env.root, "clipboard.txt");
  writeFileSync(clipboard, "PASTED-AFTER-SETTINGS");
  const { marks } = env.run([
    ["waitReady"], ["waitFor", "thinker (medium)", { all: true }],
    ["type", "/settings"], ["key", "enter"], ["waitFor", "Type to search"], ["key", "esc"], ["wait", 150], ["mark", "closed"],
    ["raw", "\x1b[Z"], ["waitFor", "thinker (high)"], ["mark", "cycled"],
    ["key", "ctrl+v"], ["waitFor", "PASTED-AFTER-SETTINGS"], ["mark", "pasted"],
    ...quit,
  ], { env: { MMP_TEST_CLIPBOARD_FILE: clipboard } });
  assert.match(after(marks, "closed", "cycled"), /thinker \(high\)/);
  assert.match(after(marks, "cycled", "pasted"), /❯ PASTED-AFTER-SETTINGS/);
});

test("every item saves to ~/.mmp/pi/settings.json, nothing lands under ~/.pi or the project's .pi/, and a restart reads it", (t) => {
  const env = makeEnv(t);
  const { marks } = env.run([
    ["waitReady"],
    ...SHOWN.flatMap((label) => change(label)),
    ["mark", "changed"], ...quit,
  ]);
  assert.match(marks.changed, /HTTP idle timeout: disabled/);
  assert.match(marks.changed, /Cache warming: idle/);
  // One Enter each, from Pi's defaults: the next value in each item's list.
  assert.deepEqual(env.readSettings(), {
    compaction: { enabled: false },
    images: { autoResize: false, blockImages: true },
    enableSkillCommands: false,
    showHardwareCursor: true,
    autocompleteMaxVisible: 7,
    steeringMode: "all",
    followUpMode: "all",
    transport: "sse",
    httpIdleTimeoutMs: 0,
    cacheWarming: "idle",
    treeFilterMode: "no-tools",
    fullscreenScrollbar: "always",
    fullscreenCopyOnSelect: false,
    fullscreenWheelScrollLines: 1,
  });
  assert.equal(existsSync(join(env.home, ".pi")), false);
  assert.equal(existsSync(join(env.project, ".pi")), false);
  assert.equal(existsSync(join(env.root, ".pi")), false);

  const restarted = env.run([
    ["waitReady"], ["mark", "start"],
    ["type", "/settings"], ["key", "enter"], ["waitFor", "Type to search"],
    ...Array.from({ length: SHOWN.length - 1 }, () => ["key", "down"]),
    ["waitFor", `(${SHOWN.length}/${SHOWN.length})`], ["mark", "walked"],
    ["key", "esc"], ["wait", 100], ...quit,
  ]);
  const list = after(restarted.marks, "start", "walked");
  for (const [label, value] of [
    ["Auto-compact", "false"], ["Block images", "true"], ["Steering mode", "all"], ["Transport", "sse"],
    ["HTTP idle timeout", "disabled"], ["Cache warming", "idle"], ["Tree filter mode", "no-tools"],
    ["Fullscreen copy on select", "false"], ["Fullscreen wheel scrolling", "1"],
  ]) assert.match(list, new RegExp(`→ ${label} +${value}`), label);
});

test("a Pi-core item changed in /settings takes effect at once: /tree opens with the new filter", (t) => {
  const env = makeEnv(t);
  const { marks } = env.run([
    ["waitReady"], ["type", "hi"], ["key", "enter"], ["wait", 600],
    ["type", "/tree"], ["key", "enter"], ["waitFor", "Session Tree"], ["mark", "before"], ["key", "esc"], ["wait", 150],
    ...change("Tree filter mode"), ["mark", "changed"],
    ["type", "/tree"], ["key", "enter"], ["waitFor", "Session Tree"], ["mark", "after"], ["key", "esc"], ["wait", 150],
    ...quit,
  ]);
  // Pi's tree selector tags the count with the filter, except for "default".
  assert.match(marks.before, /\(3\/3\)\s/);
  assert.doesNotMatch(marks.before, /\[no-tools\]/);
  assert.match(after(marks, "changed", "after"), /\(\d+\/\d+\) \[no-tools\]/);
});

test("Autocomplete max items applies at once and at the next start", (t) => {
  const env = makeEnv(t);
  // `/` lists login, logout, model, new, quit, compact, resume, … : row 6 only shows at 7 or more.
  const { marks } = env.run([
    ["waitReady"], ["mark", "start"],
    ["type", "/"], ["waitFor", "Quit MMP"], ["mark", "default"], ["key", "esc"], ["key", "ctrl+c"], ["wait", 150],
    ...change("Autocomplete max items"), ["mark", "changed"],
    ["type", "/"], ["waitFor", "Resume a different session"], ["mark", "seven"], ["key", "esc"],
    ...quit,
  ]);
  assert.doesNotMatch(after(marks, "start", "default"), /Compact the session context/);
  assert.match(after(marks, "changed", "seven"), /Compact the session context/);
  assert.doesNotMatch(after(marks, "changed", "seven"), /Set thinking level/);

  const restarted = env.run([
    ["waitReady"], ["type", "/"], ["waitFor", "Resume a different session"], ["mark", "seven"], ["key", "esc"], ...quit,
  ]);
  assert.match(restarted.marks.seven, /Compact the session context/);
});

test("Skill commands off drops /skill: suggestions at once", (t) => {
  const env = makeEnv(t);
  const skill = join(env.home, ".agents", "skills", "settings-probe");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: settings-probe\ndescription: SETTINGS-PROBE-SKILL\n---\nbody\n");
  const { marks } = env.run([
    ["waitReady"],
    ["type", "/skill:"], ["waitFor", "SETTINGS-PROBE-SKILL"], ["mark", "on"], ["key", "esc"], ["key", "ctrl+c"], ["wait", 150],
    ...change("Skill commands"), ["mark", "changed"],
    ["type", "/skill:"], ["wait", 400], ["mark", "off"], ["key", "esc"],
    ...quit,
  ]);
  assert.match(marks.on, /skill:settings-probe/);
  assert.doesNotMatch(after(marks, "changed", "off"), /SETTINGS-PROBE-SKILL/);
});

// Review 1 F1: applyRuntimeSettings re-runs configureHttp on every bind, /reload and /settings change.
test("an extension's own globalThis.fetch survives startup, /settings, /new and /reload (Pi's shouldInstallGlobals)", (t) => {
  const env = makeEnv(t, { extension: "settings-ext-fetch.mjs" });
  const check = (mark, n) => [["type", "/fcheck"], ["key", "enter"], ["waitFor", { regex: `FETCH_OVERRIDE_\\w+#${n}\\b` }], ["mark", mark]];
  const { marks } = env.run([
    ["waitReady"], ...check("startup", 1),
    ...change("Fullscreen scrollbar"), ...check("settings", 2),
    ["type", "/new"], ["key", "enter"], ["wait", 800], ...check("new", 3),
    ["type", "/reload"], ["key", "enter"], ["wait", 800], ...check("reloaded", 4),
    ...quit,
  ]);
  ["startup", "settings", "new", "reloaded"].forEach((mark, index) =>
    assert.match(marks[mark], new RegExp(`FETCH_OVERRIDE_KEPT#${index + 1}\\b`), `after ${mark}`));
  assert.doesNotMatch(marks.reloaded, /FETCH_OVERRIDE_LOST/);
});

// Review 1 F2: Pi keeps ctx.ui.addAutocompleteProvider wrappers across rebuilds and clears them only
// with the rest of the extension UI (resetExtensionUI: before a session switch, and on /reload).
test("extension autocomplete providers survive /settings and rebuilds, and are cleared like Pi's on /reload", (t) => {
  const env = makeEnv(t, { extension: "settings-ext-autocomplete.mjs" });
  const probe = (text, tag, mark) => [["type", text], ["wait", 400], ["mark", mark], ["key", "esc"], ["key", "ctrl+c"], ["wait", 150]];
  const { marks } = env.run([
    ["waitReady"], ...probe("/zy", "EXTSTART", "startup"),
    ["type", "/acadd"], ["key", "enter"], ["wait", 300], ["mark", "added"], ...probe("/zz", "EXTCMD", "cmd"),
    ...change("Fullscreen scrollbar"), ["mark", "scrollbar"], ...probe("/zz", "EXTCMD", "afterScrollbar"),
    ...change("Skill commands"), ["mark", "skills"], ...probe("/zz", "EXTCMD", "afterSkills"),
    ["type", "/reload"], ["key", "enter"], ["wait", 800], ["mark", "reloaded"],
    ...probe("/zy", "EXTSTART", "reloadStart"), ...probe("/zz", "EXTCMD", "reloadCmd"),
    ...quit,
  ]);
  assert.match(marks.startup, /EXTSTART/, "a provider added in session_start is there after startup");
  assert.match(after(marks, "added", "cmd"), /EXTCMD/);
  assert.match(after(marks, "scrollbar", "afterScrollbar"), /EXTCMD/, "a /settings change keeps it");
  assert.match(after(marks, "skills", "afterSkills"), /EXTCMD/, "the skill-commands rebuild re-applies it");
  assert.match(after(marks, "reloaded", "reloadStart"), /EXTSTART/, "session_start adds it again after /reload");
  assert.doesNotMatch(after(marks, "reloadStart", "reloadCmd"), /EXTCMD/, "/reload clears the command's, like Pi's resetExtensionUI");
});

test("Fullscreen scrollbar 'always' shows the bar at once, from settings.json at startup, and after /reload", (t) => {
  // "┃" is the scrollbar thumb; MMP draws it nowhere else, and in "auto" it only shows while scrolling.
  const live = makeEnv(t);
  const { marks } = live.run([
    ["waitReady"], ["mark", "start"], ...change("Fullscreen scrollbar"), ["mark", "changed"], ...quit,
  ]);
  assert.doesNotMatch(marks.start, /┃/);
  assert.match(after(marks, "start", "changed"), /┃/);

  const startup = makeEnv(t, { settings: { fullscreenScrollbar: "always" } });
  assert.match(startup.run([["waitReady"], ["mark", "start"], ...quit]).marks.start, /┃/);

  const reload = makeEnv(t);
  const reloaded = reload.run([
    ["waitReady"], ["mark", "start"],
    ["writeFile", { path: reload.settingsFile, content: JSON.stringify({ fullscreenScrollbar: "always" }) }],
    ["type", "/reload"], ["key", "enter"], ["wait", 800], ["mark", "reloaded"], ...quit,
  ]).marks;
  assert.doesNotMatch(reloaded.start, /┃/);
  assert.match(after(reloaded, "start", "reloaded"), /┃/);
});

test("Show hardware cursor turns the terminal cursor on at once and at startup", (t) => {
  const SHOW = "\x1b[?25h";
  const live = makeEnv(t);
  const { marks } = live.run([
    ["waitReady"], ["rawMark", "start"], ...change("Show hardware cursor"), ["type", "x"], ["wait", 100], ["rawMark", "changed"], ...quit,
  ]);
  assert.equal(marks.start.includes(SHOW), false);
  assert.equal(after(marks, "start", "changed").includes(SHOW), true);

  const startup = makeEnv(t, { settings: { showHardwareCursor: true } });
  assert.equal(startup.run([["waitReady"], ["rawMark", "start"], ...quit]).marks.start.includes(SHOW), true);
});

test("Show hardware cursor ignores Pi's PI_HARDWARE_CURSOR: unset in settings.json means off, and /settings says false", (t) => {
  // Pi's getter falls back to PI_HARDWARE_CURSOR=1; MMP does not honour a user's Pi environment
  // (the MMP_SESSION_DIR precedent, docs/cli-design.md).
  const env = makeEnv(t);
  const { marks } = env.run([
    ["waitReady"], ["type", "x"], ["wait", 100], ["rawMark", "typed"], ["key", "ctrl+c"], ["wait", 100],
    ["type", "/settings"], ["key", "enter"], ["waitFor", "Type to search"], ["type", "Show hardware cursor"], ["wait", 100],
    ["mark", "shown"], ["key", "esc"], ["wait", 100], ...quit,
  ], { env: { PI_HARDWARE_CURSOR: "1" } });
  assert.equal(marks.typed.includes("\x1b[?25h"), false);
  assert.match(marks.shown, /→ Show hardware cursor +false/);
  assert.doesNotMatch(marks.shown, /→ Show hardware cursor +true/);
});

test("Fullscreen copy on select: on when unset (decision T3), off at once from /settings, off from settings.json", (t) => {
  const OSC52 = "\x1b]52;c;";
  // Drag across the startup page's first line: press, move with the button held, release.
  const drag = [["raw", "\x1b[<0;5;4M"], ["raw", "\x1b[<32;30;4M"], ["raw", "\x1b[<0;30;4m"], ["wait", 300]];
  const count = (text) => text.split(OSC52).length - 1;

  const live = makeEnv(t);
  const { marks } = live.run([
    ["waitReady"], ...drag, ["rawMark", "first"],
    ...change("Fullscreen copy on select"), ["rawMark", "changed"], ...drag, ["rawMark", "second"], ...quit,
  ]);
  assert.equal(count(marks.first), 1, "unset copy-on-select copies (T3)");
  assert.equal(count(after(marks, "changed", "second")), 0);
  assert.equal(live.readSettings().fullscreenCopyOnSelect, false);

  const startup = makeEnv(t, { settings: { fullscreenCopyOnSelect: false } });
  assert.equal(count(startup.run([["waitReady"], ...drag, ["rawMark", "end"], ...quit]).marks.end), 0);
});

test("Fullscreen wheel scrolling sets lines per wheel event at once and at startup", (t) => {
  // One wheel-up over a long /hotkeys block in a 20-row terminal: "Submit input" is about 10 lines
  // above the bottom, so only a 10-line step brings it back into view.
  const wheel = [["type", "/hotkeys"], ["key", "enter"], ["wait", 500], ["mark", "before"], ["raw", "\x1b[<64;20;5M"], ["wait", 300], ["mark", "wheeled"]];

  const live = makeEnv(t);
  const { marks } = live.run([
    ["waitReady"], ...wheel.map((step) => (step[0] === "mark" ? ["mark", `default-${step[1]}`] : step)),
    ...change("Fullscreen wheel scrolling", 5), // auto → 1 → 2 → 3 → 5 → 10
    ...wheel, ...quit,
  ], { rows: 20 });
  assert.equal(live.readSettings().fullscreenWheelScrollLines, 10);
  assert.doesNotMatch(after(marks, "default-before", "default-wheeled"), /Submit input/);
  assert.match(after(marks, "before", "wheeled"), /Submit input/);

  const startup = makeEnv(t, { settings: { fullscreenWheelScrollLines: 10 } });
  const started = startup.run([["waitReady"], ...wheel, ...quit], { rows: 20 }).marks;
  assert.match(after(started, "before", "wheeled"), /Submit input/);
});

test("MMP's items match Pi's SettingsSelectorComponent: same order, labels, descriptions and values", async (t) => {
  // Pi's modules find their theme files under PI_CODING_AGENT_DIR; never let them look in ~/.pi.
  const agentDir = mkdtempSync(join(tmpdir(), "mmp-settings-drift-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Pi's getShowHardwareCursor reads PI_HARDWARE_CURSOR, MMP's value never does; compare the two
  // with it unset so the developer's environment can't make them differ.
  const hardwareCursorEnv = process.env.PI_HARDWARE_CURSOR;
  delete process.env.PI_HARDWARE_CURSOR;
  t.after(() => { if (hardwareCursorEnv !== undefined) process.env.PI_HARDWARE_CURSOR = hardwareCursorEnv; });
  const { SettingsManager, SettingsSelectorComponent } = await import("@earendil-works/pi-coding-agent");
  const { installMmpTheme } = await import("../dist/tui/theme.js");
  const { settingsItems } = await import("../dist/tui/settings-command.js");
  installMmpTheme(agentDir, "dark");

  const settings = SettingsManager.inMemory();
  const config = {
    autoCompact: settings.getCompactionEnabled(), defaultModel: "not set", availableDefaultModels: [],
    showImages: settings.getShowImages(), imageWidthCells: settings.getImageWidthCells(),
    autoResizeImages: settings.getImageAutoResize(), blockImages: settings.getBlockImages(),
    enableSkillCommands: settings.getEnableSkillCommands(), steeringMode: settings.getSteeringMode(),
    followUpMode: settings.getFollowUpMode(), transport: settings.getTransport(),
    httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(), cacheWarmingMode: settings.getCacheWarmingMode(),
    thinkingLevel: "medium", availableThinkingLevels: ["off", "medium"], modelThinkingLevels: {},
    currentTheme: "dark", availableThemes: ["dark"], hideThinkingBlock: false,
    mermaidRenderingMode: settings.getMermaidRenderingMode(), showCacheMissNotices: settings.getShowCacheMissNotices(),
    collapseChangelog: settings.getCollapseChangelog(), enableInstallTelemetry: settings.getEnableInstallTelemetry(),
    doubleEscapeAction: settings.getDoubleEscapeAction(), treeFilterMode: settings.getTreeFilterMode(),
    showHardwareCursor: settings.getShowHardwareCursor(), editorPaddingX: settings.getEditorPaddingX(),
    outputPad: settings.getOutputPad(), autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
    quietStartup: settings.getQuietStartup(), defaultProjectTrust: settings.getDefaultProjectTrust(),
    clearOnShrink: settings.getClearOnShrink(), showTerminalProgress: settings.getShowTerminalProgress(),
    tuiMode: "fullscreen", fullscreenExitOutput: settings.getFullscreenExitOutput(),
    fullscreenScrollbar: settings.getFullscreenScrollbar(), fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
    fullscreenWheelScrollLines: settings.getFullscreenWheelScrollLines(), warnings: settings.getWarnings(),
  };
  const noop = new Proxy({}, { get: () => () => {} });
  const strip = (text) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");
  /** The selected row's label and value, and the description shown under the list. */
  const read = (selector) => {
    const lines = selector.render(400).map((line) => strip(line).trimEnd());
    const row = lines.find((line) => line.trimStart().startsWith("→ "));
    // The `(i/N)` counter only shows when the list is longer than its 10 rows.
    const counter = lines.find((line) => /^\s*\(\d+\/\d+\)$/.test(line));
    const hint = lines.findIndex((line) => line.includes("Type to search"));
    assert.ok(row !== undefined && hint !== -1, `unexpected Pi settings render:\n${lines.join("\n")}`);
    // An item whose value is empty has no gap left after trimEnd().
    const [, label, value = ""] = /→ (.+?)(?: {2,}(.*))?$/.exec(row);
    return { label, value, description: lines[hint - 2].trim(), total: counter === undefined ? undefined : Number(/\/(\d+)\)/.exec(counter)[1]) };
  };
  const pi = () => new SettingsSelectorComponent(config, noop);
  const DOWN = "\x1b[B";

  // Pi's whole list, in order.
  const walk = pi();
  const piItems = [];
  for (let index = 0, total = 1; index < total; index += 1) {
    const current = read(walk);
    total = current.total;
    piItems.push(current);
    walk.getSettingsList().handleInput(DOWN);
  }

  const session = {
    settingsManager: settings,
    autoCompactionEnabled: settings.getCompactionEnabled(),
    steeringMode: settings.getSteeringMode(),
    followUpMode: settings.getFollowUpMode(),
  };
  const mmp = settingsItems({ session: () => session }).map((setting) => setting.item);
  const piLabels = piItems.map((item) => item.label);
  assert.deepEqual(mmp.map((item) => item.label), piLabels.filter((label) => mmp.some((item) => item.label === label)),
    "MMP keeps Pi's order");
  assert.deepEqual(mmp.map((item) => item.label), SHOWN);
  const left = piLabels.filter((label) => !SHOWN.includes(label));
  assert.deepEqual(left.filter((label) => !HIDDEN.includes(label)), [],
    "Pi has an item MMP neither shows nor lists as hidden: decide (docs/tui-design.md 4.6)");
  assert.deepEqual(HIDDEN.filter((label) => !left.includes(label) && label !== "Show images" && label !== "Image width"), [],
    "an item listed as hidden is gone from Pi");

  for (const item of mmp) {
    const piItem = piItems.find((candidate) => candidate.label === item.label);
    assert.equal(item.currentValue, piItem.value, `${item.id}: current value`);
    if (!OWN_DESCRIPTION.has(item.id)) assert.equal(item.description, piItem.description, `${item.id}: description`);
    // Pi's values, in order: search the item, press Enter through every value.
    const selector = pi();
    for (const char of item.label) selector.getSettingsList().handleInput(char);
    assert.equal(read(selector).label, item.label);
    const piCycle = [];
    for (let press = 0; press < item.values.length; press += 1) {
      selector.getSettingsList().handleInput("\r");
      piCycle.push(read(selector).value);
    }
    const start = item.values.indexOf(item.currentValue);
    const mmpCycle = item.values.map((_, offset) => item.values[(start + 1 + offset) % item.values.length]);
    assert.deepEqual(mmpCycle, piCycle, `${item.id}: values`);
  }

  // Review 1 F4: the milliseconds behind MMP's copy of HTTP_IDLE_TIMEOUT_CHOICES. Save each label
  // through MMP's item, then check Pi's selector shows the same label for the saved value.
  const timeout = settingsItems({ session: () => session, applySettings() {}, notice() {} })
    .find((setting) => setting.item.id === "http-idle-timeout");
  for (const label of timeout.item.values) {
    timeout.apply(label);
    const selector = new SettingsSelectorComponent({ ...config, httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs() }, noop);
    for (const char of timeout.item.label) selector.getSettingsList().handleInput(char);
    assert.equal(read(selector).value, label, `http-idle-timeout: Pi's label for ${settings.getHttpIdleTimeoutMs()} ms`);
  }
});
