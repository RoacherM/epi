// Shared diagnostic shape and the extension-load mapping. Pi's main.js adds extension load results
// to its diagnostics itself (~641-648); createAgentSessionServices leaves them out (dogfood D45).
// The TUI, -p/json/rpc and --list-models all need them, and they used to map the same errors by
// hand in two places -- the kind of drift that produced a dozen dogfood bugs across entry points.
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";

export type Diagnostic = { type: "error" | "warning" | "info"; message: string };

/** Extension load failures and package warnings, in Pi's order: errors, then warnings. */
export function extensionLoadDiagnostics(
  resourceLoader: Pick<ResourceLoader, "getExtensions">,
): Diagnostic[] {
  const extensions = resourceLoader.getExtensions();
  return [
    ...extensions.errors.map(({ path, error }): Diagnostic => ({
      type: "error",
      message: `Failed to load extension "${path}": ${error}`,
    })),
    ...(extensions.warnings ?? []).map(({ path, warning }): Diagnostic => ({
      type: "warning",
      message: `Extension package "${path}": ${warning}`,
    })),
  ];
}
