import { confirmInEditorSlot } from "./dialogs.js";
import { errorText } from "./errors.js";
import { crossProjectRefusal } from "./project-guard.js";
/** Pi's getPathCommandArgument, simplified: MMP only needs the whole remainder, optionally quoted
 * (so a path with spaces can be typed as `/export "my file.html"`), not partial-token parsing. */
function pathArgument(args) {
    const trimmed = args.trim();
    if (trimmed === "")
        return undefined;
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length > 1) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
/** `/export [path]`: `.jsonl` exports the current branch as JSONL, otherwise HTML (Pi's default). */
export async function runExport(host, args) {
    const outputPath = pathArgument(args);
    try {
        if (outputPath?.endsWith(".jsonl")) {
            const filePath = host.session().exportToJsonl(outputPath);
            host.notice(`Session exported to: ${filePath}`);
        }
        else {
            const filePath = await host.session().exportToHtml(outputPath, { ...(host.theme.name === undefined ? {} : { themeName: host.theme.name }) });
            host.notice(`Session exported to: ${filePath}`);
        }
    }
    catch (error) {
        host.notice(`Failed to export session: ${errorText(error)}`, "error");
    }
}
/** `/import <path>`: confirm, then replace the current session (Pi's handleImportCommand).
 * Refuses a session whose cwd belongs to a different MMP project, like /resume
 * (src/tui/project-guard.ts): manifest extensions are fixed for this process at launch. */
export async function runImport(host, args) {
    const inputPath = pathArgument(args);
    if (inputPath === undefined) {
        host.notice("Usage: /import <path.jsonl>", "error");
        return;
    }
    const confirmed = await confirmInEditorSlot(host, "Import session", `Replace current session with ${inputPath}?`);
    if (!confirmed) {
        host.notice("Import cancelled.");
        return;
    }
    let refusal;
    try {
        refusal = crossProjectRefusal(inputPath, host.projectIdentity);
    }
    catch (error) {
        // A missing or unparsable file surfaces the same way `importFromJsonl` itself would.
        host.notice(`Failed to import session: ${errorText(error)}`, "error");
        return;
    }
    if (refusal !== undefined) {
        host.notice(refusal, "warning");
        return;
    }
    try {
        const result = await host.runtime.importFromJsonl(inputPath);
        if (result.cancelled) {
            host.notice("Import cancelled.");
            return;
        }
        host.notice(`Session imported from: ${inputPath}`);
    }
    catch (error) {
        host.notice(`Failed to import session: ${errorText(error)}`, "error");
    }
}
//# sourceMappingURL=export-commands.js.map