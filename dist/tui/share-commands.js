// /share, /bug, /changelog (docs/tui-design.md 4.6); registered in builtins.ts.
//
// /share mirrors Pi's shareSession (modes/interactive/session-share.js, not exported): same
// cancelable-`gh gist create` flow and the same external requirement (a logged-in `gh`), built
// from BorderedLoader (exported) and the public `session.exportToHtml`. Deviations: no Radius
// upload (Pi's own hosted service; MMP has no Radius identity to share through) and a plain gist
// URL instead of Pi's `getShareViewerUrl` preview page (internal, not exported).
//
// /bug and /changelog are NOT Pi's (docs/tui-design.md 4.6 P1 note): Pi's `/bug` uploads to the Pi
// developers and `/changelog` reads Pi's own bundled changelog file, neither of which is right for
// MMP. Both instead use MMP's own GitHub repo, the same one src/update.ts already names.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BorderedLoader, ExtensionEditorComponent, ExtensionSelectorComponent, VERSION as PI_VERSION, } from "@earendil-works/pi-coding-agent";
import { MMP_VERSION } from "../host.js";
import { MMP_REPO } from "../update.js";
import { errorText } from "./errors.js";
import { piTui } from "./pi-tui.js";
// ── small local dialog helpers (same shape as commands.ts, session-tree-commands.ts) ──────────
function confirm(host, title, message) {
    return new Promise((resolve) => {
        let restore = () => { };
        const selector = new ExtensionSelectorComponent(`${title}\n${message}`, ["Yes", "No"], (choice) => {
            restore();
            resolve(choice === "Yes");
        }, () => {
            restore();
            resolve(false);
        });
        restore = host.takeEditorSlot(selector);
    });
}
function editorInput(host, title, prefill) {
    return new Promise((resolve) => {
        let restore = () => { };
        const editor = new ExtensionEditorComponent(host.tui, piTui.getKeybindings(), title, prefill, (value) => {
            restore();
            resolve(value);
        }, () => {
            restore();
            resolve(undefined);
        });
        restore = host.takeEditorSlot(editor);
    });
}
// ── /share ──────────────────────────────────────────────────────────────────
/** `/share`: export the session to HTML and create a private gist from it with `gh`. Like Pi,
 * there is no confirmation dialog -- only the loader's own Esc-to-cancel, which is what Pi calls
 * its "consent/cancel flow" for share (session-share.js has no confirm() call either). */
export async function runShare(host) {
    const tempDir = mkdtempSync(join(tmpdir(), "mmp-share-"));
    const htmlFile = join(tempDir, "session.html");
    try {
        try {
            await host.session().exportToHtml(htmlFile, { ...(host.theme.name === undefined ? {} : { themeName: host.theme.name }) });
        }
        catch (error) {
            host.notice(`Failed to export session: ${errorText(error)}`, "error");
            return;
        }
        const authCheck = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
        if (authCheck.error !== undefined) {
            host.notice("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/", "error");
            return;
        }
        if (authCheck.status !== 0) {
            host.notice("GitHub CLI is not logged in. Run 'gh auth login' first.", "error");
            return;
        }
        await shareViaGist(host, htmlFile);
    }
    finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}
async function shareViaGist(host, filePath) {
    const loader = new BorderedLoader(host.tui, host.theme, "Creating gist...");
    const restore = host.takeEditorSlot(loader);
    let proc;
    loader.onAbort = () => {
        proc?.kill();
        loader.dispose();
        restore();
        host.notice("Share cancelled.");
    };
    try {
        const result = await new Promise((resolve) => {
            proc = spawn("gh", ["gist", "create", "--public=false", filePath]);
            let stdout = "";
            let stderr = "";
            proc.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
            proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
            proc.on("error", (error) => resolve({ stdout, stderr: error.message, code: -1 }));
            proc.on("close", (code) => resolve({ stdout, stderr, code }));
        });
        if (loader.signal.aborted)
            return;
        loader.dispose();
        restore();
        if (result.code !== 0) {
            host.notice(`Failed to create gist: ${result.stderr.trim() || "Unknown error"}`, "error");
            return;
        }
        host.notice(`Share URL: ${result.stdout.trim()}`);
    }
    catch (error) {
        if (!loader.signal.aborted) {
            loader.dispose();
            restore();
            host.notice(`Failed to create gist: ${errorText(error)}`, "error");
        }
    }
}
// ── /bug ────────────────────────────────────────────────────────────────────
/** Best-effort: the URL is always printed first, so a failed or unavailable opener loses nothing.
 * Gated on PI_OFFLINE (the same env var the whole test suite sets) so tests never pop a real
 * browser tab; `.on("error", ...)` swallows a missing `open`/`xdg-open`/`start` instead of letting
 * an unhandled child 'error' event hit app.ts's uncaughtException handler. */
function openInBrowser(url) {
    if (process.env.PI_OFFLINE !== undefined)
        return;
    const [command, args] = process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
            ? ["cmd", ["/c", "start", "", url]]
            : ["xdg-open", [url]];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => { });
    child.unref();
}
export const MAX_ISSUE_URL_LENGTH = 8_000;
function issueUrl(title, body) {
    return `https://github.com/${MMP_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
/** Cuts the body (never the title) until the whole URL fits `MAX_ISSUE_URL_LENGTH`, noting the cut
 * so the reporter knows the issue page doesn't have everything that was written. Exported for
 * direct unit testing (test/tui-commands-share.test.mjs), same reason as info-commands.ts's
 * usageBreakdown. */
export function fitIssueBody(title, body) {
    if (issueUrl(title, body).length <= MAX_ISSUE_URL_LENGTH)
        return body;
    const note = "\n\n[truncated to fit the URL length limit]";
    let cut = body;
    while (cut.length > 0 && issueUrl(title, `${cut}${note}`).length > MAX_ISSUE_URL_LENGTH) {
        cut = cut.slice(0, Math.max(0, cut.length - 500));
    }
    return `${cut}${note}`;
}
/** `/bug [description]`: consent, optional description, optional model-written summary, then a
 * prefilled "new issue" URL on MMP's own GitHub repo -- never Pi's upload. The URL is always
 * printed (it's the actual deliverable in a headless run); opening a browser is best-effort. */
export async function runBug(host, args) {
    const consent = await confirm(host, "Report a bug", "Opens a prefilled GitHub issue on MMP's repo with your description, the MMP and pinned Pi " +
        "versions, and, if you choose, a short summary of this session written by the current model. " +
        "Nothing is sent automatically -- review and submit it yourself in the browser.\n\nContinue?");
    if (!consent) {
        host.notice("Bug report cancelled.");
        return;
    }
    const hintInput = await editorInput(host, "Describe the bug (optional)", args.trim() || undefined);
    if (hintInput === undefined) {
        host.notice("Bug report cancelled.");
        return;
    }
    const hint = hintInput.trim();
    const session = host.session();
    let summary;
    const wantsSummary = await confirm(host, "Include a summary?", `Attach a short summary of this session written by ${session.model?.name ?? "the current model"}?`);
    if (wantsSummary) {
        const loader = new BorderedLoader(host.tui, host.theme, `Writing summary with ${session.model?.name ?? "the current model"}...`);
        const restore = host.takeEditorSlot(loader);
        try {
            summary = await session.summarizeForBugReport({ ...(hint === "" ? {} : { hint }), signal: loader.signal });
        }
        catch (error) {
            loader.dispose();
            restore();
            if (loader.signal.aborted) {
                host.notice("Bug report cancelled.");
            }
            else {
                host.notice(`Failed to write summary: ${errorText(error)}`, "error");
            }
            return;
        }
        loader.dispose();
        restore();
    }
    const title = hint === "" ? "Bug report" : hint.slice(0, 80);
    const sections = [
        hint === "" ? undefined : `## Description\n\n${hint}`,
        `## Versions\n\n- mmp: ${MMP_VERSION}\n- pi (pinned): ${PI_VERSION}`,
        summary === undefined ? undefined : `## Session summary\n\n${summary}`,
    ].filter((section) => section !== undefined);
    const body = fitIssueBody(title, sections.join("\n\n"));
    const url = issueUrl(title, body);
    host.notice(`Open this URL to file the report:\n${url}`);
    openInBrowser(url);
}
/** Pure and unit-testable without a subprocess, like src/update.ts's own fetch functions
 * (test/update.test.mjs): takes an injectable `fetch` instead of adding a new env-var seam. */
export async function fetchReleaseNotes(fetchImpl = fetch) {
    const response = await fetchImpl(`https://api.github.com/repos/${MMP_REPO}/releases`, {
        signal: AbortSignal.timeout(5_000),
        headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok)
        throw new Error(`GitHub releases API returned ${response.status}`);
    const releases = await response.json();
    return releases
        .filter((release) => typeof release.tag_name === "string")
        .map((release) => ({
        version: release.tag_name,
        body: typeof release.body === "string" && release.body.trim() !== "" ? release.body : "(no notes)",
    }));
}
/** `/changelog`: MMP's own GitHub releases (not Pi's bundled changelog file). */
export async function runChangelog(host) {
    if (process.env.PI_OFFLINE !== undefined) {
        host.notice("Offline: can't reach GitHub for the changelog. Run mmp update to check for a new release once online.", "warning");
        return;
    }
    let releases;
    try {
        releases = await fetchReleaseNotes();
    }
    catch (error) {
        host.notice(`Could not fetch the changelog: ${errorText(error)}`, "error");
        return;
    }
    if (releases.length === 0) {
        host.addBlock(new piTui.Text(host.theme.fg("dim", "No releases found."), 1, 0));
        return;
    }
    const theme = host.theme;
    const lines = releases.flatMap((release) => [theme.bold(release.version), "", release.body, ""]);
    host.addBlock(new piTui.Text(lines.join("\n").trimEnd(), 1, 0));
}
//# sourceMappingURL=share-commands.js.map