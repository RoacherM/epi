import type { InlineExtension } from "@earendil-works/pi-coding-agent";
/**
 * Makes `stream` treat a closed reader (`isClosedPipe`) as the end of its output: the error is
 * swallowed (no `error` crash, the write's callback succeeds), every later write is dropped, and
 * `onClosed` runs once. A socket reports it to the write's callback and then as `error`; a stream
 * whose `_write` throws reports it synchronously from `write`. Both are handled.
 */
export declare function endOnClosedPipe(stream: NodeJS.WriteStream, onClosed: () => void): void;
/**
 * Guards stdout and stderr (before piMain, so Pi's output guard binds the wrappers) and returns an
 * inline extension that aborts the run and skips further prompts once stdout's reader has gone. A
 * closed stderr (`2>&1 | head`) only stops MMP writing there: nothing could show an error anyway.
 * Print/json runs only: host.ts leaves `--mode rpc` to Pi.
 */
export declare function guardClosedStdout(): InlineExtension;
//# sourceMappingURL=closed-stdout.d.ts.map