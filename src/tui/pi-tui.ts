// pi-tui keeps module-level state (global keybindings, the theme its components read) and uses
// `instanceof Container`, so the TUI must be built from the exact copy Pi's own components use, and
// there must be only one. Since Pi 1.0.1 pi-coding-agent ships no npm-shrinkwrap, so npm hoists its
// pi-tui to the top level, where Epi's own (types and direct imports) resolves too; Epi's
// npm-shrinkwrap.json pins that layout. If a second copy appears (Pi nests its own again, or Epi's
// pinned version drifts from Pi's range), the two resolutions differ and startup fails here.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type * as PiTuiModule from "@earendil-works/pi-tui";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const piTuiEntry = createRequire(piEntry).resolve("@earendil-works/pi-tui");
const topLevelEntry = createRequire(import.meta.url).resolve("@earendil-works/pi-tui");

if (piTuiEntry !== topLevelEntry) {
  throw new Error(
    `Two copies of pi-tui are installed: Pi uses ${piTuiEntry}, Epi uses ${topLevelEntry}. ` +
    "Reinstall Epi so only one is installed.",
  );
}

export const piTui = (await import(pathToFileURL(piTuiEntry).href)) as typeof PiTuiModule;
