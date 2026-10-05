import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The product was renamed to Epi (decisions NM1, NM2). The old name may only stay in dated history.
// Patterns spell it with a character class ("[m]mp") so this file never contains the old name itself.
const OLD_NAME = /[m]mp/i;

/** Each entry: which files, which lines (omit `line` for the whole file), and why. */
const ALLOWED = [
  { file: /^docs\/dogfood-issues\.md$/, reason: "dated issue log, entries keep the name they were filed under" },
  { file: /^docs\/notes\//, reason: "dated research notes" },
  { file: /^docs\/decisions\.md$/, line: /^\| 20\d\d-/, reason: "dated decision rows" },
  { file: /\.md$/, line: /formerly [M]MP/, reason: "current docs naming the old name on purpose" },
  {
    file: /^docs\/development\.md$/,
    line: /reports\/benchmark-adapter\/[m]mp-full-smoke-2026-08-02\//,
    reason: "dated local benchmark output, the directory really has this name",
  },
  { file: /^package-lock\.json$/, line: /^\s*"integrity": "sha512-/, reason: "a dependency hash that happens to contain the letters" },
];

const root = fileURLToPath(new URL("..", import.meta.url));

function allowed(file, line) {
  return ALLOWED.some((entry) => entry.file.test(file) && (entry.line === undefined || entry.line.test(line)));
}

test("no tracked file name or line uses the old product name outside the allow-list", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  assert.ok(files.length > 100, `git ls-files listed only ${files.length} files`);

  const offenders = [];
  for (const file of files) {
    if (OLD_NAME.test(file) && !allowed(file, "")) {
      offenders.push(`${file}: file name`);
    }
    const lines = readFileSync(`${root}/${file}`, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (OLD_NAME.test(line) && !allowed(file, line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} line(s) still use the old name:\n${offenders.slice(0, 40).join("\n")}`,
  );
});
