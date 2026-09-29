import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

import {
  askProjectTrust,
  projectTrustOptions,
  saveProjectTrustChoice,
  shouldAskProjectTrust,
} from "../dist/trust-prompt.js";

// Same fake Terminal shape as test/fixtures/tui-harness.mjs, used here in-process (askProjectTrust
// has no session/model/env state to isolate, unlike the full TUI app) rather than over a real pty.
const KEYS = { enter: "\r", esc: "\x1b", "ctrl+c": "\x03", down: "\x1b[B", up: "\x1b[A" };
const stripAnsi = (text) =>
  text.replace(/\x1b\[[0-9;?<>=:]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g, "");
function fakeTerminal() {
  let onInput = () => {};
  let output = "";
  return {
    terminal: {
      start(input) { onInput = input; },
      stop() {},
      async drainInput() {},
      write(data) { output += data; },
      get columns() { return 120; },
      get rows() { return 40; },
      get kittyProtocolActive() { return false; },
      moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
      setTitle() {}, setProgress() {},
    },
    press: (key) => onInput(KEYS[key]),
    output: () => stripAnsi(output),
  };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE = {
  interactive: true,
  dryRun: false,
  noProject: false,
  trustOverride: undefined,
  projectRoot: "/repo",
  savedDecision: null,
};

test("shouldAskProjectTrust: asks only when interactive, undecided, and not overridden", () => {
  assert.equal(shouldAskProjectTrust(BASE), true);
});

test("shouldAskProjectTrust: not interactive", () => {
  assert.equal(shouldAskProjectTrust({ ...BASE, interactive: false }), false);
});

test("shouldAskProjectTrust: --dry-run never asks", () => {
  assert.equal(shouldAskProjectTrust({ ...BASE, dryRun: true }), false);
});

test("shouldAskProjectTrust: --no-project never asks", () => {
  assert.equal(shouldAskProjectTrust({ ...BASE, noProject: true }), false);
});

test("shouldAskProjectTrust: an existing --approve/--no-approve override skips the prompt", () => {
  assert.equal(shouldAskProjectTrust({ ...BASE, trustOverride: true }), false);
  assert.equal(shouldAskProjectTrust({ ...BASE, trustOverride: false }), false);
});

test("shouldAskProjectTrust: no project found", () => {
  assert.equal(shouldAskProjectTrust({ ...BASE, projectRoot: undefined }), false);
});

test("shouldAskProjectTrust: an already-saved decision (trusted or not) skips the prompt", () => {
  assert.equal(shouldAskProjectTrust({ ...BASE, savedDecision: true }), false);
  assert.equal(shouldAskProjectTrust({ ...BASE, savedDecision: false }), false);
});

test("projectTrustOptions: mirrors Pi's options plus this-run-only choices", () => {
  const options = projectTrustOptions("/repo/project");
  assert.deepEqual(options.map((option) => option.label), [
    "Trust",
    "Trust parent folder (/repo)",
    "Trust (this run only)",
    "Do not trust",
    "Do not trust (this run only)",
  ]);
  assert.deepEqual(options[0], { label: "Trust", trusted: true, updates: [{ path: "/repo/project", decision: true }] });
  assert.deepEqual(options[1], {
    label: "Trust parent folder (/repo)",
    trusted: true,
    updates: [{ path: "/repo", decision: true }, { path: "/repo/project", decision: null }],
  });
  assert.deepEqual(options[2], { label: "Trust (this run only)", trusted: true, updates: [] });
  assert.deepEqual(options[3], { label: "Do not trust", trusted: false, updates: [{ path: "/repo/project", decision: false }] });
  assert.deepEqual(options[4], { label: "Do not trust (this run only)", trusted: false, updates: [] });
});

test("projectTrustOptions: no parent-folder option at the filesystem root", () => {
  const options = projectTrustOptions("/");
  assert.deepEqual(options.map((option) => option.label), [
    "Trust",
    "Trust (this run only)",
    "Do not trust",
    "Do not trust (this run only)",
  ]);
});

function tempAgentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "mmp-trust-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("saveProjectTrustChoice: Trust persists root=true", (t) => {
  const agentDir = tempAgentDir(t);
  const root = "/repo/project";
  saveProjectTrustChoice(agentDir, projectTrustOptions(root)[0]);
  assert.equal(new ProjectTrustStore(agentDir).get(root), true);
});

test("saveProjectTrustChoice: Trust parent folder sets the parent and clears the root entry", (t) => {
  const agentDir = tempAgentDir(t);
  const root = "/repo/project";
  const parent = dirname(root);
  saveProjectTrustChoice(agentDir, projectTrustOptions(root)[1]);
  const store = new ProjectTrustStore(agentDir);
  assert.equal(store.get(parent), true);
  // The root key itself must be gone, not merely inherited from the parent.
  const raw = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8"));
  assert.equal(Object.hasOwn(raw, root), false);
  assert.equal(raw[parent], true);
});

test("saveProjectTrustChoice: Trust (this run only) saves nothing", (t) => {
  const agentDir = tempAgentDir(t);
  const root = "/repo/project";
  saveProjectTrustChoice(agentDir, projectTrustOptions(root)[2]);
  assert.equal(new ProjectTrustStore(agentDir).get(root), null);
});

test("saveProjectTrustChoice: Do not trust persists root=false", (t) => {
  const agentDir = tempAgentDir(t);
  const root = "/repo/project";
  saveProjectTrustChoice(agentDir, projectTrustOptions(root)[3]);
  assert.equal(new ProjectTrustStore(agentDir).get(root), false);
});

test("saveProjectTrustChoice: Do not trust (this run only) saves nothing", (t) => {
  const agentDir = tempAgentDir(t);
  const root = "/repo/project";
  saveProjectTrustChoice(agentDir, projectTrustOptions(root)[4]);
  assert.equal(new ProjectTrustStore(agentDir).get(root), null);
});

test("askProjectTrust: driving a fake terminal selects an option and saves it", async (t) => {
  const agentDir = tempAgentDir(t);
  const root = "/repo/project";
  const { terminal, press, output } = fakeTerminal();
  const resultPromise = askProjectTrust({ root, terminal });
  await sleep(50); // let the dynamic pi-tui import and tui.start() land
  const drawn = output();
  assert.match(drawn, /Trust project folder\?/);
  assert.match(drawn, /\/repo\/project/);
  assert.match(drawn, /rules, skills and extensions/);
  for (const label of projectTrustOptions(root).map((option) => option.label)) {
    assert.ok(drawn.includes(label), `missing option "${label}" in:\n${drawn}`);
  }
  press("down"); // Trust -> Trust parent folder (/repo)
  await sleep(20);
  press("enter");
  const choice = await resultPromise;
  assert.equal(choice.label, "Trust parent folder (/repo)");
  saveProjectTrustChoice(agentDir, choice);
  const store = new ProjectTrustStore(agentDir);
  assert.equal(store.get("/repo"), true);
  const raw = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8"));
  assert.equal(Object.hasOwn(raw, root), false);
});

test("askProjectTrust: Esc cancels without saving anything", async () => {
  const { terminal, press } = fakeTerminal();
  const resultPromise = askProjectTrust({ root: "/repo/project", terminal });
  await sleep(50);
  press("esc");
  const choice = await resultPromise;
  assert.equal(choice.trusted, false);
  assert.deepEqual(choice.updates, []);
});

test("askProjectTrust: Ctrl+C cancels without saving anything", async () => {
  const { terminal, press } = fakeTerminal();
  const resultPromise = askProjectTrust({ root: "/repo/project", terminal });
  await sleep(50);
  press("ctrl+c");
  const choice = await resultPromise;
  assert.equal(choice.trusted, false);
  assert.deepEqual(choice.updates, []);
});
