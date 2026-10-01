import { Theme } from "@earendil-works/pi-coding-agent";
export type ThemeAppearance = "dark" | "light";
/** v1: COLORFGBG when the terminal sets it, otherwise dark. Querying the terminal is spike S7. */
export declare function detectAppearance(environment: NodeJS.ProcessEnv): ThemeAppearance;
export declare function createMmpTheme(appearance: ThemeAppearance): Theme;
/**
 * Pi's exported components read a process-wide theme that only `initTheme(name)` can set. It loads
 * `<getAgentDir()>/themes/<name>.json`, where getAgentDir reads PI_CODING_AGENT_DIR (without it Pi
 * would look in ~/.pi/agent), and it silently falls back to Pi's own theme when anything is off.
 * So this sets the directory itself and then checks that the global theme really is MMP's.
 */
export declare function installMmpTheme(agentDir: string, appearance: ThemeAppearance): Theme;
//# sourceMappingURL=theme.d.ts.map