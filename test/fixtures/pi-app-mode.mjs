// Pi's own `resolveAppMode(parsed, stdinIsTTY, stdoutIsTTY)` out of the installed main.js, so
// test/interactive.test.mjs can check src/interactive.ts against Pi itself rather than a copy
// (dogfood D53; docs/pi-internals.md `resolve-app-mode`). The function isn't exported, so it is
// read as text and evaluated; a Pi upgrade that renames, moves or changes its signature fails here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mainPath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "main.js");
const mainText = readFileSync(mainPath, "utf8");

const match = /^function resolveAppMode\(parsed, stdinIsTTY, stdoutIsTTY\) \{\n([\s\S]*?)^\}$/m.exec(mainText);
if (!match) throw new Error(`pi-app-mode: ${mainPath} no longer defines resolveAppMode(parsed, stdinIsTTY, stdoutIsTTY)`);

/** Pi's resolveAppMode: "rpc" | "json" | "print" | "interactive". */
export const piResolveAppMode = new Function("parsed", "stdinIsTTY", "stdoutIsTTY", match[1]);

/** main.js's own text, for checks on how it uses the mode. */
export { mainPath, mainText };
