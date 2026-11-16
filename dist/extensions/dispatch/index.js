// Dispatch: async bash, subagents, named peers on a shared board, timers and an outbox as one
// portable Pi extension (docs/dispatch-design.md). Two entries:
//  - `export default` for `pi -e dist/extensions/dispatch/index.js`: zero configuration; the
//    runtime is kept on `globalThis` per agent dir, so `/reload` finds the children it owns.
//  - `createDispatchExtension(host)` for a host (Epi) that injects its state dir, worker
//    bootstrap, hook bridge and policies.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DispatchRuntime } from "./runtime.js";
import { DISPATCH_RUNTIME_SYMBOL } from "./types.js";
export { DISPATCH_EXT_VERSION } from "./types.js";
export { enqueueExternalEvent } from "./inbox-spool.js";
export function createDispatchExtension(host = {}) {
    let runtime;
    return (pi) => {
        runtime ??= new DispatchRuntime(host, "root");
        runtime.mount(pi);
    };
}
export default function dispatchExtension(pi) {
    const global = globalThis;
    const store = (global[DISPATCH_RUNTIME_SYMBOL] ??= new Map());
    const key = getAgentDir();
    let runtime = store.get(key);
    if (runtime === undefined) {
        runtime = new DispatchRuntime({}, "root");
        store.set(key, runtime);
    }
    runtime.mount(pi);
}
//# sourceMappingURL=index.js.map