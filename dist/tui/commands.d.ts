import type { CommandHost } from "./command-host.js";
/** Like Pi: first the method (account or API key), then the providers offering it. */
export declare function runLogin(host: CommandHost, providerRef: string): Promise<void>;
export declare function runLogout(host: CommandHost): Promise<void>;
/** `/model [query]`: switch directly on an exact match, otherwise open the selector. */
export declare function runModel(host: CommandHost, query: string, options?: {
    persist?: boolean;
    title?: string;
}): Promise<void>;
//# sourceMappingURL=commands.d.ts.map