import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEpiTheme, detectAppearance } from "../dist/tui/theme.js";

test("both grok palettes construct a complete Pi Theme", () => {
  // Theme's constructor throws on a missing required token; initTheme would silently fall back instead.
  for (const appearance of ["dark", "light"]) {
    assert.equal(createEpiTheme(appearance).name, appearance === "dark" ? "epi-grok-night" : "epi-grok-day");
  }
});

test("appearance follows COLORFGBG and defaults to dark", () => {
  assert.equal(detectAppearance({}), "dark");
  assert.equal(detectAppearance({ COLORFGBG: "15;0" }), "dark");
  assert.equal(detectAppearance({ COLORFGBG: "0;15" }), "light");
  assert.equal(detectAppearance({ COLORFGBG: "0;default" }), "dark");
});

test("Pi's components and Epi's own Theme instance draw identical colors", (t) => {
  // Pi components read the global theme that initTheme loads from the JSON files Epi writes.
  const agentDir = mkdtempSync(join(tmpdir(), "epi-theme-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const script = `
    import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
    import { installEpiTheme } from "./dist/tui/theme.js";
    const mine = installEpiTheme(${JSON.stringify(agentDir)}, "dark");
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
  for (const [fromPi, fromEpi] of JSON.parse(result.stdout)) {
    assert.equal(fromPi, fromEpi);
  }
});

// docs/tui-transcript-layout-design.md R5: inline code, unhighlighted code blocks and list bullets
// are toned down to sit next to body text, in both palettes.
test("markdown code and list bullets use the toned-down colors", () => {
  const hex = (color) => `#${[color.r, color.g, color.b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  const expected = {
    dark: { mdCode: "#8fb3c0", mdCodeBlock: "#b8c0cc", mdListBullet: "#6c6c6c" },
    light: { mdCode: "#4f6f7a", mdCodeBlock: "#5c6b77", mdListBullet: "#767676" },
  };
  for (const [appearance, tokens] of Object.entries(expected)) {
    const { colors } = createEpiTheme(appearance);
    for (const [token, value] of Object.entries(tokens)) assert.equal(hex(colors[token]), value, `${appearance} ${token}`);
  }
});
