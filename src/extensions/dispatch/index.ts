// Dispatch: async bash, subagents, named peers on a shared board, timers and an outbox as one
// portable Pi extension (docs/dispatch-design.md). Two entries:
//  - `export default` for `pi -e dist/extensions/dispatch/index.js`: zero configuration; the
//    runtime is kept on `globalThis` per agent dir, so `/reload` finds the children it owns.
//  - `createDispatchExtension(host)` for a host (Epi) that injects its state dir, worker
//    bootstrap, hook bridge and policies.
import { getAgentDir, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { DispatchRuntime } from "./runtime.js";
import { DISPATCH_RUNTIME_SYMBOL, type DispatchHostAdapter } from "./types.js";

export { DISPATCH_EXT_VERSION } from "./types.js";
export type { DispatchHostAdapter, DispatchRole } from "./types.js";
export { enqueueExternalEvent } from "./inbox-spool.js";

export function createDispatchExtension(host: DispatchHostAdapter = {}): ExtensionFactory {
  let runtime: DispatchRuntime | undefined;
  return (pi) => {
    runtime ??= new DispatchRuntime(host, "root");
    runtime.mount(pi);
  };
}

type RuntimeStore = Map<string, DispatchRuntime>;

export default function dispatchExtension(pi: ExtensionAPI): void {
  const global = globalThis as { [DISPATCH_RUNTIME_SYMBOL]?: RuntimeStore };
  const store = (global[DISPATCH_RUNTIME_SYMBOL] ??= new Map());
  const key = getAgentDir();
  let runtime = store.get(key);
  if (runtime === undefined) {
    runtime = new DispatchRuntime({}, "root");
    store.set(key, runtime);
  }
  runtime.mount(pi);
}
