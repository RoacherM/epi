import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMmpTheme, detectAppearance } from "../dist/tui/theme.js";

test("both grok palettes construct a complete Pi Theme", () => {
  // Theme's constructor throws on a missing required token; initTheme would silently fall back instead.
  for (const appearance of ["dark", "light"]) {
    assert.equal(createMmpTheme(appearance).name, appearance === "dark" ? "mmp-grok-night" : "mmp-grok-day");
  }
});

test("appearance follows COLORFGBG and defaults to dark", () => {
  assert.equal(detectAppearance({}), "dark");
  assert.equal(detectAppearance({ COLORFGBG: "15;0" }), "dark");
  assert.equal(detectAppearance({ COLORFGBG: "0;15" }), "light");
  assert.equal(detectAppearance({ COLORFGBG: "0;default" }), "dark");
});

test("Pi's components and MMP's own Theme instance draw identical colors", (t) => {
  // Pi components read the global theme that initTheme loads from the JSON files MMP writes.
  const agentDir = mkdtempSync(join(tmpdir(), "mmp-theme-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const script = `
    import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
    import { installMmpTheme } from "./dist/tui/theme.js";
    const mine = installMmpTheme(${JSON.stringify(agentDir)}, "dark");
    const global = getMarkdownTheme();
    const pairs = [["heading", "mdHeading"], ["link", "mdLink"], ["code", "mdCode"], ["quote", "mdQuote"], ["listBullet", "mdListBullet"]];
    process.stdout.write(JSON.stringify(pairs.map(([fn, token]) => [global[fn]("x"), mine.fg(token, "x")])));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, COLORTERM: "truecolor" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  for (const [fromPi, fromMmp] of JSON.parse(result.stdout)) {
    assert.equal(fromPi, fromMmp);
  }
});
