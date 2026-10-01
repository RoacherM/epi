import type { CommandHost } from "./command-host.js";
/** `/share`: export the session to HTML and create a private gist from it with `gh`. Like Pi,
 * there is no confirmation dialog -- only the loader's own Esc-to-cancel, which is what Pi calls
 * its "consent/cancel flow" for share (session-share.js has no confirm() call either). */
export declare function runShare(host: CommandHost): Promise<void>;
export declare const MAX_ISSUE_URL_LENGTH = 8000;
/** Cuts the body (never the title) until the whole URL fits `MAX_ISSUE_URL_LENGTH`, noting the cut
 * so the reporter knows the issue page doesn't have everything that was written. Exported for
 * direct unit testing (test/tui-commands-share.test.mjs), same reason as info-commands.ts's
 * usageBreakdown. */
export declare function fitIssueBody(title: string, body: string): string;
/** `/bug [description]`: consent, optional description, optional model-written summary, then a
 * prefilled "new issue" URL on MMP's own GitHub repo -- never Pi's upload. The URL is always
 * printed (it's the actual deliverable in a headless run); opening a browser is best-effort. */
export declare function runBug(host: CommandHost, args: string): Promise<void>;
export interface ReleaseNote {
    version: string;
    body: string;
}
/** Pure and unit-testable without a subprocess, like src/update.ts's own fetch functions
 * (test/update.test.mjs): takes an injectable `fetch` instead of adding a new env-var seam. */
export declare function fetchReleaseNotes(fetchImpl?: typeof fetch): Promise<ReleaseNote[]>;
/** `/changelog`: MMP's own GitHub releases (not Pi's bundled changelog file). */
export declare function runChangelog(host: CommandHost): Promise<void>;
//# sourceMappingURL=share-commands.d.ts.map