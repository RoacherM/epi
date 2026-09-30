function isClosedPipe(error) {
    const code = error?.code;
    return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}
/**
 * Makes `stream` treat a closed pipe as the end of its output: the EPIPE is swallowed (no `error`
 * crash, the write's callback succeeds), every later write is dropped, and `onClosed` runs once.
 */
function endOnClosedPipe(stream, onClosed) {
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
        return typeof encoding === "function"
            ? write.call(this, chunk, wrapped)
            : write.call(this, chunk, encoding, wrapped);
    };
}
/**
 * Guards stdout and stderr (before piMain, so Pi's output guard binds the wrappers) and returns an
 * inline extension that aborts the run and skips further prompts once stdout's reader has gone. A
 * closed stderr (`2>&1 | head`) only stops MMP writing there: nothing could show an error anyway.
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
    return {
        name: "mmp:closed-stdout",
        factory(pi) {
            let abort;
            onStdoutClosed.push(() => abort?.());
            pi.on("session_start", (_event, ctx) => {
                abort = () => ctx.abort();
            });
            // `-p a b` prompts once per message; after the reader has gone the rest are skipped.
            pi.on("input", () => (stdoutClosed ? { action: "handled" } : { action: "continue" }));
        },
    };
}
//# sourceMappingURL=closed-stdout.js.map