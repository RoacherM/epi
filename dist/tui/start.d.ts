import { type AgentSessionRuntime, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PreparedMmpRun } from "../host.js";
import type { ProjectIdentity } from "./project-guard.js";
/** Same Manifest assembly as the piMain path, handed to the SDK instead of Pi's CLI. */
export declare function createRuntimeFromPrepared(prepared: PreparedMmpRun, cwd: string, extensionFactories?: InlineExtension[]): Promise<AgentSessionRuntime>;
/** The project this process assembled its manifest from (project-guard.ts): fixed for the whole
 * run, since manifest extensions cannot be hot-loaded (DEVELOPMENT.md §8.2).
 *
 * `root` is recomputed from `cwd` directly, independent of `--no-project`/trust: with
 * `--no-project` (or an untrusted/missing manifest), `prepared.assembly.projectManifest` is
 * undefined even when a `.mmp/mmp.json` really does exist above `cwd`, which made a session
 * started in that very folder look like "a different project" to project-guard.ts. */
export declare function projectIdentityFromPrepared(prepared: PreparedMmpRun, cwd: string): ProjectIdentity;
export interface TuiStartupOptions {
    /** Pi CLI positional messages (services.ts's TUI_V2 argument table), sent as the initial prompts
     * once the app is up. `@file` arguments are rejected earlier as unsupported, so only plain text
     * messages ever end up here. */
    initialMessages: string[];
    /** `--resume`: app.ts opens the same session selector `/resume` uses, right after startup, as
     * Pi's own `--resume` does. Only when no other flag already picked a session -- services.ts's
     * `buildSessionManager` gives `--session`/`--continue`/`--no-session` precedence over `--resume`
     * exactly like Pi's own `createSessionManager` (dist/main.js) does. */
    resumeOnStart: boolean;
}
export declare function startupOptionsFromPiArgs(piArgs: readonly string[]): TuiStartupOptions;
export declare function runTuiV2(prepared: PreparedMmpRun, extensionFactories: InlineExtension[]): Promise<number>;
//# sourceMappingURL=start.d.ts.map