import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

const harness = fileURLToPath(new URL("./fixtures/tui-harness.mjs", import.meta.url));

function runAppInProject(t, steps) {
  const root = mkdtempSync(join(tmpdir(), "epi-tui-trust-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".epi"), { recursive: true });
  mkdirSync(join(project, ".epi"), { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1 }));
  writeFileSync(join(project, ".epi", "epi.json"), JSON.stringify({ version: 1 }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      EPI_HOME: join(home, ".epi"),
      EPI_OFFLINE: "1",
      EPI_TUI_HARNESS: JSON.stringify({ steps }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const trustPath = join(home, ".epi", "pi", "trust.json");
  return {
    ...JSON.parse(result.stdout),
    projectRoot: realpathSync(project),
    trustDecision: existsSync(trustPath) ? new ProjectTrustStore(join(home, ".epi", "pi")).get(realpathSync(project)) : null,
    trustFile: existsSync(trustPath) ? JSON.parse(readFileSync(trustPath, "utf8")) : undefined,
  };
}

test("/trust saves a decision and notices it needs a restart", (t) => {
  const { output, trustDecision } = runAppInProject(t, [
    ["waitReady"],
    ["type", "/trust"],
    ["key", "enter"],
    ["wait", 300],
    ["key", "enter"], // first option: "Trust"
    ["wait", 300],
    ["key", "ctrl+d"],
  ]);
  assert.match(output, /Saved: Trust\. Takes effect after restarting epi/);
  assert.equal(trustDecision, true);
});

test("/trust asks under its own title and gives the editor back once a choice is made", (t) => {
  const { screens } = runAppInProject(t, [
    ["waitReady"],
    ["type", "/trust"],
    ["key", "enter"],
    ["wait", 300],
    ["screen", "dialog"],
    ["key", "enter"], // first option: "Trust"
    ["wait", 300],
    ["type", "hello-after"],
    ["wait", 300],
    ["screen", "afterType"],
    ["detach"], // Ctrl+D would not quit: the editor holds "hello-after"
  ]);
  assert.match(screens.dialog.join("\n"), /Trust project folder\?/);
  assert.match(screens.afterType.join("\n"), /hello-after/);
});

test("/trust: Do not trust persists root=false", (t) => {
  const { output, trustDecision } = runAppInProject(t, [
    ["waitReady"],
    ["type", "/trust"],
    ["key", "enter"],
    ["wait", 300],
    ["key", "down"], ["key", "down"], ["key", "down"], // Trust, Trust parent, this-run-only, Do not trust
    ["key", "enter"],
    ["wait", 300],
    ["key", "ctrl+d"],
  ]);
  assert.match(output, /Saved: Do not trust\. Takes effect after restarting epi/);
  assert.equal(trustDecision, false);
});

test("/trust: no project found from the current directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "epi-tui-trust-none-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(join(home, ".epi"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, ".epi", "epi.json"), JSON.stringify({ version: 1 }));
  const result = spawnSync(process.execPath, [harness], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      EPI_HOME: join(home, ".epi"),
      EPI_OFFLINE: "1",
      EPI_TUI_HARNESS: JSON.stringify({
        steps: [
          ["waitReady"],
          ["type", "/trust"],
          ["key", "enter"],
          ["wait", 300],
          ["key", "ctrl+d"],
        ],
      }),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { output } = JSON.parse(result.stdout);
  assert.match(output, /No \.epi\/epi\.json project found/);
});
