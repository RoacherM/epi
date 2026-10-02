/**
 * Pi's own `PI_*` environment variables, isolated from the user's Pi environment (dogfood D63,
 * docs/cli-design.md §2.1). A value a user set for their Pi install must never change mmp (no shared
 * config, docs/dev-workflow.md §5): every `PI_*` name Pi reads is cleared at startup, and the
 * user-facing ones are re-set from MMP's own `MMP_*` name.
 *
 * The table covers every `PI_*` name Pi's runtime code mentions; test/pi-internals.test.mjs
 * (`pi-env-reads`) fails when a Pi upgrade adds or drops one, so a new knob gets classified here
 * instead of leaking through.
 */
export type PiEnvRule = 
/** User-facing knob: Pi's variable is set from MMP's own name, same value and semantics. */
{
    kind: "bridged";
    mmp: string;
}
/** MMP sets the variable itself later (agent dir, version-check opt-out). */
 | {
    kind: "mmp-owned";
}
/** Not reachable in mmp, or a Pi debug switch: only cleared, no MMP name. */
 | {
    kind: "cleared";
};
export declare const PI_ENV_RULES: Readonly<Record<string, PiEnvRule>>;
/**
 * `PI_*` names that appear in Pi's code but are not inputs Pi reads: Pi writes them for child
 * processes, or the name is not an environment variable at all. Listed so the pin test can tell
 * them apart from an unclassified read.
 */
export declare const PI_ENV_NOT_READ: readonly string[];
/**
 * Clears every `PI_*` variable in PI_ENV_RULES, then copies each bridged `MMP_*` variable that is
 * set (even to "") onto Pi's name, so Pi applies its own semantics to MMP's value. Must run before
 * any Pi module is evaluated: some read their variable at import time (`PI_PACKAGE_DIR` in
 * config.js, `PI_TIMING` in timings.js, `PI_OAUTH_CALLBACK_HOST` in two OAuth flows). Child
 * processes spawned with `process.env` (task workers, hooks, tools) inherit the result.
 *
 * `PI_CODING_AGENT_DIR` is set to MMP's own agent dir here too, not only later before each run:
 * Pi's utils/tools-manager.js fixes its managed fd/rg directory (`getBinDir()`) at import time, so
 * without this it would be `~/.pi/agent/bin`. An invalid MMP_HOME leaves it unset; the run then
 * fails on that error before any tool runs, while --help/--version still work.
 */
export declare function isolatePiEnvironment(env: NodeJS.ProcessEnv): void;
//# sourceMappingURL=pi-env.d.ts.map