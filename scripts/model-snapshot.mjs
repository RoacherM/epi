#!/usr/bin/env node
// Model-visible snapshot (docs/pi-upgrade-design.md 3, "模型可见内容快照"): builds Epi's standard
// offline assembly -- rules, skills, and the epi:task/epi:mcp/epi:hooks built-in extensions, all
// loading fully offline -- points it at a faux model, and captures exactly what a real provider
// would receive: the leading system message's text and tool declarations. Report-only: this never
// judges pass/fail on its own (a real model-visible change needs a human decision on whether to
// rerun the paid benchmark baseline, docs/pi-upgrade-design.md 2); `--diff` always exits 0.
//
// Contract another agent (scripts/pi-upgrade.mjs) depends on -- keep this exact:
//   node scripts/model-snapshot.mjs [--out <file>]
//     -> stdout or <file>: { "piVersion": string, "systemPrompt": string, "tools": [{name, description, parameters}, ...] }
//     (tools sorted by name; paths/cwd/dates normalized to $TMP/$PI_PACKAGE_DIR/$CWD/$DATE tokens so
//     two runs are byte-identical)
//   node scripts/model-snapshot.mjs --diff <baseline.json>
//     -> stdout: a unified-style diff of systemPrompt and/or tools against <baseline.json> (a section
//        that did not change prints "<section>: unchanged" instead of an empty patch), or the
//        exact line "NO MODEL-VISIBLE CHANGES" when identical. Always exits 0.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { EPI_VERSION } from "../dist/host.js";
import { canonicalize } from "./normalize-snapshot.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(root, "test", "fixtures", "sdk-path-runner.mjs");
const driver = join(root, "scripts", "model-snapshot-driver.mjs");
const bundleTemplate = join(root, "test", "fixtures", "full-runtime");
// Pi's base system prompt's <docs> section embeds this package's own install location (its
// README/docs/examples paths), which npm resolves through node_modules -- realpathSync follows any
// symlink (e.g. a worktree's node_modules) to the actual on-disk path that ends up in the prompt.
const piPackageDir = realpathSync(dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))));

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") {
      options.out = argv[(index += 1)];
    } else if (argument === "--diff") {
      options.diff = argv[(index += 1)];
    } else {
      throw new Error(`model-snapshot: unknown argument ${JSON.stringify(argument)}`);
    }
  }
  return options;
}

/** Builds the fixed offline manifest (test/fixtures/full-runtime, plus this script's faux driver)
 * under a fresh temp EPI_HOME, runs one prompt through the SDK path, and returns the raw
 * `{ systemPrompt, tools }` the faux model received -- before any path/date normalization. */
function captureModelVisibleContent() {
  const work = mkdtempSync(join(tmpdir(), "epi-model-snapshot-"));
  try {
    const home = join(work, "home");
    const epiHome = join(home, ".epi");
    const captureFile = join(work, "capture.json");
    cpSync(bundleTemplate, epiHome, { recursive: true });

    const manifestPath = join(epiHome, "epi.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.extensions = [...manifest.extensions, driver];
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const hookLog = join(work, "hook-acceptance.log");
    const options = { args: ["--no-project", "--no-session"], prompt: "Describe your capabilities." };
    // cwd is the repo root, not an empty temp dir: full-runtime's hooks.json spawns
    // `node test/fixtures/...` with that relative path resolved against the session's cwd (only a
    // handler's own `command`, if it starts with "/", resolves against hooks.json's directory --
    // src/hooks-config.ts's resolveCommandPath -- args do not). --no-project still disables all
    // project-level manifest/resource discovery at this cwd, so this stays fully offline and fixed.
    // full-runtime declares "epi:mcp" but has no mcp.json of its own, so this always sees zero
    // configured servers -- the point is a clean "adapter tools go away" diff (docs/mcp-design.md
    // §5), not exercising native MCP itself (test/mcp.test.mjs does that).
    const result = spawnSync(process.execPath, [runner], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        EPI_HOME: epiHome,
        EPI_OFFLINE: "1",
        HOOK_ACCEPTANCE_LOG: hookLog,
        EPI_MODEL_SNAPSHOT_OUT: captureFile,
        EPI_SDK_RUNNER: JSON.stringify(options),
      },
    });
    if (result.status !== 0) {
      throw new Error(`model-snapshot: offline assembly failed to run (exit ${result.status})\n${result.stdout}${result.stderr}`);
    }
    const captured = JSON.parse(readFileSync(captureFile, "utf8"));
    // Both the mkdtempSync form and its realpath: macOS resolves /var -> /private/var, and Pi
    // canonicalizes some recorded paths (skill locations) but not others (declaredIn), so both
    // forms of the same temp dir show up depending which field it's embedded in.
    const roots = [
      [work, "$TMP"],
      [realpathSync(work), "$TMP"],
      [piPackageDir, "$PI_PACKAGE_DIR"],
      [root, "$CWD"],
    ];
    // epi:runtime's inventory embeds both versions verbatim (engineVersion, runtime.version): left
    // unnormalized, --diff would report a change on every Epi release and every Pi bump even when
    // nothing else about the prompt or tools moved -- exactly the false positive this snapshot
    // exists to avoid (docs/pi-upgrade-design.md 2). The top-level piVersion field still records the
    // real value. Boundary-checked (unlike the plain paths above): a bare substring replace of a
    // short version string like "0.1.4" could also match inside an unrelated longer number.
    const versionRoots = [
      [PI_VERSION, "$PI_VERSION"],
      [EPI_VERSION, "$EPI_VERSION"],
    ];
    return { ...captured, roots, versionRoots };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces every occurrence of each root path anywhere in `value`'s strings (not just a whole
 * value that equals or starts with one, like scripts/normalize-snapshot.mjs's helpers do for JSON
 * field values) -- a system prompt is free-form prose with paths embedded mid-sentence, not a
 * structured record of path-valued fields. Longest roots first, so a nested one (the temp dir under
 * itself, after resolving symlinks) is substituted before its own prefix would otherwise shadow it.
 * `versionRoots` entries are matched with digit/dot boundaries so a short version string like
 * "0.1.4" doesn't also match inside an unrelated longer number (e.g. "10.1.4"). */
function substituteRoots(value, roots, versionRoots = []) {
  if (typeof value === "string") {
    const sortedRoots = [...roots].sort((a, b) => b[0].length - a[0].length);
    let result = value;
    for (const [path, token] of sortedRoots) {
      result = result.replace(new RegExp(escapeRegExp(path), "g"), token);
    }
    for (const [version, token] of versionRoots) {
      result = result.replace(new RegExp(`(?<![\\d.])${escapeRegExp(version)}(?![\\d.])`, "g"), token);
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteRoots(item, roots, versionRoots));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteRoots(item, roots, versionRoots)]));
  }
  return value;
}

function normalizeDates(value) {
  if (typeof value === "string") return value.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "$DATE");
  if (Array.isArray(value)) return value.map(normalizeDates);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeDates(item)]));
  }
  return value;
}

function buildSnapshot() {
  const { systemPrompt, tools, roots, versionRoots } = captureModelVisibleContent();
  const normalizedPrompt = normalizeDates(substituteRoots(systemPrompt, roots, versionRoots));
  const normalizedTools = canonicalize(normalizeDates(substituteRoots(tools, roots, versionRoots)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { piVersion: PI_VERSION, systemPrompt: normalizedPrompt, tools: normalizedTools };
}

/** Pi's own `diff` install (dependency of pi-coding-agent, not a direct Epi dependency); registered
 * as a Pi-internals row like the other nested-dep reaches (docs/pi-internals.md). */
async function loadDiff() {
  const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const diffPath = createRequire(piEntry).resolve("diff");
  return import(diffPath);
}

async function printDiff(baselinePath, current) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const promptChanged = JSON.stringify(baseline.systemPrompt) !== JSON.stringify(current.systemPrompt);
  const toolsChanged = JSON.stringify(baseline.tools) !== JSON.stringify(current.tools);
  if (!promptChanged && !toolsChanged) {
    process.stdout.write("NO MODEL-VISIBLE CHANGES\n");
    return;
  }
  // An unchanged section gets one explicit line rather than an empty patch: the Pi 1.0 gate report
  // printed a bare "--- tools (baseline) / +++ tools (current)" header with no hunks, which read as
  // "the tools changed" when they were byte-identical.
  const { createTwoFilesPatch } = await loadDiff();
  const promptSection = promptChanged
    ? createTwoFilesPatch(
      "systemPrompt (baseline)", "systemPrompt (current)",
      `${baseline.systemPrompt}\n`, `${current.systemPrompt}\n`, "", "",
    )
    : "systemPrompt: unchanged\n";
  const toolsSection = toolsChanged
    ? createTwoFilesPatch(
      "tools (baseline)", "tools (current)",
      `${JSON.stringify(baseline.tools, null, 2)}\n`, `${JSON.stringify(current.tools, null, 2)}\n`, "", "",
    )
    : "tools: unchanged\n";
  process.stdout.write(`${promptSection}\n${toolsSection}\n`);
}

async function main(argv) {
  const options = parseArgs(argv);
  const snapshot = buildSnapshot();
  if (options.diff !== undefined) {
    await printDiff(options.diff, snapshot);
    return;
  }
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (options.out !== undefined) {
    writeFileSync(options.out, text);
  } else {
    process.stdout.write(text);
  }
}

await main(process.argv.slice(2));
