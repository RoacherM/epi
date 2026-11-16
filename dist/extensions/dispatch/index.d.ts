import { type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type DispatchHostAdapter } from "./types.js";
export { DISPATCH_EXT_VERSION } from "./types.js";
export type { DispatchHostAdapter, DispatchRole } from "./types.js";
export { enqueueExternalEvent } from "./inbox-spool.js";
export declare function createDispatchExtension(host?: DispatchHostAdapter): ExtensionFactory;
export default function dispatchExtension(pi: ExtensionAPI): void;
//# sourceMappingURL=index.d.ts.map