// Reads Pi's own ambient-discovery source lists out of the installed package, instead of
// hand-copying them into test/fixtures/ambient-plant.mjs. A Pi upgrade that adds a new
// trust-requiring project resource or a new context-file name then gets planted automatically,
// and one that moves or renames the source fails this module loudly (docs/pi-upgrade-design.md
// 3: "ambient 资源隔离" 现状 column).
//
// Neither list is part of pi-coding-agent's package "exports" map, so they can't be imported as
// values; both are read as text out of Pi's dist files and the array literal is extracted with a
// regex. `CONFIG_DIR_NAME` *is* exported (re-exported from dist/index.js), so it's a normal import.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));

/** Extracts a `const <declaration> = [...]` string array from `filePath`. When `anchor` is given,
 * the declaration is searched for only within `maxScan` characters after the first occurrence of
 * `anchor` -- needed for a declaration name generic enough (`candidates`) that it could otherwise
 * match some unrelated array Pi added elsewhere in the same file; a name as specific as
 * `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` doesn't need one. */
function extractStringArray(filePath, declaration, sourceLabel, { anchor, maxScan = 2000 } = {}) {
  const fullText = readFileSync(filePath, "utf8");
  let text = fullText;
  if (anchor !== undefined) {
    const anchorIndex = fullText.indexOf(anchor);
    if (anchorIndex === -1) {
      throw new Error(
        `pi-ambient-sources: could not find anchor ${JSON.stringify(anchor)} for ${sourceLabel} in ${filePath}; ` +
        `Pi moved or renamed it -- update the anchor in test/fixtures/pi-ambient-sources.mjs.`,
      );
    }
    text = fullText.slice(anchorIndex, anchorIndex + maxScan);
  }
  const match = new RegExp(`${declaration}\\s*=\\s*\\[([^\\]]*)\\]`).exec(text);
  if (!match) {
    throw new Error(
      `pi-ambient-sources: could not find ${sourceLabel} in ${filePath}${anchor !== undefined ? ` (within ${maxScan} chars of ${JSON.stringify(anchor)})` : ""}; ` +
      `Pi moved or renamed it -- update the regex in test/fixtures/pi-ambient-sources.mjs to match the new shape.`,
    );
  }
  const items = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (items.length === 0) {
    throw new Error(`pi-ambient-sources: ${sourceLabel} in ${filePath} matched but yielded no strings.`);
  }
  return items;
}

/** `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` (core/trust-manager.js): resource names under
 * `<cwd>/<CONFIG_DIR_NAME>/` whose presence requires project trust before Pi will read them. */
export function trustRequiringProjectConfigResources() {
  const items = extractStringArray(
    join(piDist, "core", "trust-manager.js"),
    "const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES",
    "TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES",
  );
  // Sanity check, not just "found something": a match that no longer includes the one entry every
  // past version of this list has had means the regex found the wrong array, not that Pi genuinely
  // stopped trust-gating extensions -- a silent "found but wrong" result would otherwise plant an
  // incomplete ambient world without any test noticing.
  if (!items.includes("extensions")) {
    throw new Error(
      `pi-ambient-sources: TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES no longer includes "extensions" ` +
      `(got ${JSON.stringify(items)}) -- the match likely found the wrong array; check core/trust-manager.js.`,
    );
  }
  return items;
}

/** The context-file candidate names `loadContextFileFromDir` (core/resource-loader.js) looks for
 * in the global agent dir and in cwd and every ancestor directory (first match wins). */
export function contextFileCandidateNames() {
  const items = extractStringArray(
    join(piDist, "core", "resource-loader.js"),
    "const candidates",
    "loadContextFileFromDir's candidate list",
    { anchor: "function loadContextFileFromDir(dir)" },
  );
  if (!items.includes("AGENTS.md")) {
    throw new Error(
      `pi-ambient-sources: loadContextFileFromDir's candidate list no longer includes "AGENTS.md" ` +
      `(got ${JSON.stringify(items)}) -- the match likely found the wrong array; check core/resource-loader.js.`,
    );
  }
  return items;
}
