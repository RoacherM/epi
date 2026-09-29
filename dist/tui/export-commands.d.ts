import type { CommandHost } from "./command-host.js";
/** `/export [path]`: `.jsonl` exports the current branch as JSONL, otherwise HTML (Pi's default). */
export declare function runExport(host: CommandHost, args: string): Promise<void>;
/** `/import <path>`: confirm, then replace the current session (Pi's handleImportCommand).
 * Refuses a session whose cwd belongs to a different MMP project, like /resume
 * (src/tui/project-guard.ts): manifest extensions are fixed for this process at launch. */
export declare function runImport(host: CommandHost, args: string): Promise<void>;
//# sourceMappingURL=export-commands.d.ts.map