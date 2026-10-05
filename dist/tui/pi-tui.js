// pi-coding-agent ships an npm-shrinkwrap.json, so npm always installs its own pi-tui under
// pi-coding-agent/node_modules. pi-tui keeps module-level state (global keybindings) and uses
// `instanceof Container`, so the TUI must be built from the exact copy Pi's components use.
// Types still come from the top-level package, which is pinned to the same version.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const piTuiEntry = createRequire(piEntry).resolve("@earendil-works/pi-tui");
const topLevelEntry = createRequire(import.meta.url).resolve("@earendil-works/pi-tui");
function packageVersion(entry) {
    const manifest = join(dirname(dirname(entry)), "package.json");
    return JSON.parse(readFileSync(manifest, "utf8")).version;
}
const runtimeVersion = packageVersion(piTuiEntry);
const typesVersion = packageVersion(topLevelEntry);
if (runtimeVersion !== typesVersion) {
    throw new Error(`pi-tui version mismatch: Pi uses ${runtimeVersion} (${piTuiEntry}), ` +
        `Epi's types come from ${typesVersion} (${topLevelEntry})`);
}
export const piTui = (await import(pathToFileURL(piTuiEntry).href));
//# sourceMappingURL=pi-tui.js.map