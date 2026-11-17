export const DISPATCH_EXT_VERSION = "0.1.0";
/** Process-wide registry key: the default `pi -e` entry keeps its process tables here so a
 * `/reload` (which re-runs the factory with a fresh `pi`) finds the children it already owns. */
export const DISPATCH_RUNTIME_SYMBOL = Symbol.for("pi.dispatch.runtime.v1");
/** Inherited by every worker and every command a worker runs; `>= 1` seals the single-layer
 * topology (docs/dispatch-design.md §2.2). */
export const DISPATCH_DEPTH_ENV = "PI_DISPATCH_DEPTH";
export const DISPATCH_INBOX_ENV = "PI_DISPATCH_INBOX";
/** The custom message type every dispatch notification uses. */
export const DISPATCH_NOTIFY_TYPE = "dispatch:notify";
export const DISPATCH_TIMER_ENTRY = "dispatch:timer";
export class DispatchConfigError extends Error {
    name = "DispatchConfigError";
}
//# sourceMappingURL=types.js.map