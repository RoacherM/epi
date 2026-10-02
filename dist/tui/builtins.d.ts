import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CommandHost } from "./command-host.js";
export interface BuiltinCommand {
    name: string;
    description: string;
    argumentHint?: string;
    run(host: CommandHost, args: string): Promise<void>;
}
export declare const BUILTIN_COMMANDS: BuiltinCommand[];
export declare function findBuiltin(name: string): BuiltinCommand | undefined;
export interface SlashCompletion {
    name: string;
    description?: string;
    argumentHint?: string;
}
/** Everything `/` can complete: built-ins, prompt templates, extension commands, skills. */
export declare function slashCompletions(session: AgentSession): SlashCompletion[];
//# sourceMappingURL=builtins.d.ts.map