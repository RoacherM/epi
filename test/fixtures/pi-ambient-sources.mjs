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

function extractStringArray(filePath, declaration, sourceLabel) {
  const text = readFileSync(filePath, "utf8");
  const match = new RegExp(`${declaration}\\s*=\\s*\\[([^\\]]*)\\]`).exec(text);
  if (!match) {
    throw new Error(
      `pi-ambient-sources: could not find ${sourceLabel} in ${filePath}; Pi moved or renamed it -- ` +
      `update the regex in test/fixtures/pi-ambient-sources.mjs to match the new shape.`,
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
  return extractStringArray(
    join(piDist, "core", "trust-manager.js"),
    "const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES",
    "TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES",
  );
}

/** The context-file candidate names `loadContextFileFromDir` (core/resource-loader.js) looks for
 * in the global agent dir and in cwd and every ancestor directory (first match wins). */
export function contextFileCandidateNames() {
  return extractStringArray(
    join(piDist, "core", "resource-loader.js"),
    "const candidates",
    "loadContextFileFromDir's candidate list",
  );
}
