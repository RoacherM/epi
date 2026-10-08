/**
 * Write errors that mean the reader has gone (dogfood D60). EPIPE is the pipe case. Node's `spawn`
 * stdio are Unix socketpairs, where a write racing the peer's close can fail with ENOTCONN instead
 * (seen on macOS under load; Node's own `net` `_final` treats ENOTCONN from shutdown as already
 * finished), or ECONNRESET (a stream socket's peer closed with data unread). ERR_STREAM_DESTROYED is a write after Node destroyed the
 * stream for one of those. Anything else (EIO, EBADF, ...) is not a closed reader and stays loud.
 */
const CLOSED_READER_CODES = new Set(["EPIPE", "ENOTCONN", "ECONNRESET", "ERR_STREAM_DESTROYED"]);
function isClosedPipe(error) {
    const code = error?.code;
    return typeof code === "string" && CLOSED_READER_CODES.has(code);
}
/**
 * Makes `stream` treat a closed reader (`isClosedPipe`) as the end of its output: the error is
 * swallowed (no `error` crash, the write's callback succeeds), every later write is dropped, and
 * `onClosed` runs once. A socket reports it to the write's callback and then as `error`; a stream
 * whose `_write` throws reports it synchronously from `write`. Both are handled.
 */
export function endOnClosedPipe(stream, onClosed) {
    let closed = false;
    const markClosed = () => {
        if (closed)
            return;
        closed = true;
        onClosed();
    };
    stream.on("error", (error) => {
        if (!isClosedPipe(error))
            throw error;
        markClosed();
    });
    const write = stream.write;
    stream.write = function (chunk, encoding, callback) {
        const done = (typeof encoding === "function" ? encoding : callback);
        if (closed) {
            if (done)
                process.nextTick(done);
            return true;
        }
        const wrapped = (error) => {
            if (error && isClosedPipe(error)) {
                markClosed();
                done?.();
                return;
            }
            done?.(error);
        };
        try {
            return typeof encoding === "function"
                ? write.call(this, chunk, wrapped)
                : write.call(this, chunk, encoding, wrapped);
        }
        catch (error) {
            if (!isClosedPipe(error))
                throw error;
            markClosed();
            if (done)
                process.nextTick(done);
            return true;
        }
    };
}
/**
 * Guards stdout and stderr (before the takeover, so Pi's output guard binds the wrappers) and returns an
 * inline extension that aborts the run and skips further prompts once stdout's reader has gone, and
 * whether it has gone (an aborted run is then not a failure, noninteractive.ts). A closed stderr
 * (`2>&1 | head`) only stops Epi writing there: nothing could show an error anyway.
 * Print/json runs only: host.ts leaves `--mode rpc` to Pi.
 */
export function guardClosedStdout() {
    let stdoutClosed = false;
    const onStdoutClosed = [];
    endOnClosedPipe(process.stdout, () => {
        stdoutClosed = true;
        for (const listener of onStdoutClosed)
            listener();
    });
    endOnClosedPipe(process.stderr, () => { });
    const extension = {
        name: "epi:closed-stdout",
        factory(pi) {
            let abort;
            onStdoutClosed.push(() => abort?.());
            pi.on("session_start", (_event, ctx) => {
                abort = () => ctx.abort();
            });
            // Dogfood D82: Pi makes the ctx stale after session_shutdown (dispose, or a replaced session
            // whose factory registers anew), and its last flush can still find the reader gone; aborting
            // then threw from the write callback.
            pi.on("session_shutdown", () => {
                abort = undefined;
            });
            // `-p a b` prompts once per message; after the reader has gone the rest are skipped.
            pi.on("input", () => (stdoutClosed ? { action: "handled" } : { action: "continue" }));
        },
    };
    return { extension, isStdoutClosed: () => stdoutClosed };
}
//# sourceMappingURL=closed-stdout.js.map