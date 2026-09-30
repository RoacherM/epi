import type { InlineExtension } from "@earendil-works/pi-coding-agent";
/**
 * Guards stdout and stderr (before piMain, so Pi's output guard binds the wrappers) and returns an
 * inline extension that aborts the run and skips further prompts once stdout's reader has gone. A
 * closed stderr (`2>&1 | head`) only stops MMP writing there: nothing could show an error anyway.
 */
export declare function guardClosedStdout(): InlineExtension;
//# sourceMappingURL=closed-stdout.d.ts.map