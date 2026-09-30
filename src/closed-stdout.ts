// Dogfood D54: `mmp -p hi | head -c1` (or `| true`) crashed with Node's unhandled EPIPE stack and
// exit 1, killing a session_shutdown handler half way. Pi's print mode writes stdout through
// core/output-guard.js, which binds `process.stdout.write` when piMain starts (`takeOverStdout`),
// retries only ENOBUFS/EAGAIN and otherwise calls process.exit(1); nothing listens for the stream's
// `error` event (docs/pi-internals.md `output-guard-stdout-write`).
//
// MMP treats a reader that has gone away as a normal end, like ripgrep or fd rather than a SIGPIPE
// kill: stop writing, stop the run (nobody reads the rest), let Pi dispose the session as usual so
// session_shutdown handlers finish, and exit with the run's own code, quietly. stderr gets the same
// treatment without stopping the run (`2>&1 | head -c1` closes both; MMP's own final flush in
// host.ts hit EPIPE there). Any other write error still fails loudly (hard rule 3).
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

type WriteCallback = (error?: Error | null) => void;

function isClosedPipe(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

/**
 * Makes `stream` treat a closed pipe as the end of its output: the EPIPE is swallowed (no `error`
 * crash, the write's callback succeeds), every later write is dropped, and `onClosed` runs once.
 */
function endOnClosedPipe(stream: NodeJS.WriteStream, onClosed: () => void): void {
  let closed = false;
  const markClosed = () => {
    if (closed) return;
    closed = true;
    onClosed();
  };
  stream.on("error", (error) => {
    if (!isClosedPipe(error)) throw error;
    markClosed();
  });
  const write = stream.write;
  stream.write = function (this: NodeJS.WriteStream, chunk: unknown, encoding?: unknown, callback?: unknown) {
    const done = (typeof encoding === "function" ? encoding : callback) as WriteCallback | undefined;
    if (closed) {
      if (done) process.nextTick(done);
      return true;
    }
    const wrapped: WriteCallback = (error) => {
      if (error && isClosedPipe(error)) {
        markClosed();
        done?.();
        return;
      }
      done?.(error);
    };
    return typeof encoding === "function"
      ? (write as (...args: unknown[]) => boolean).call(this, chunk, wrapped)
      : (write as (...args: unknown[]) => boolean).call(this, chunk, encoding, wrapped);
  } as typeof stream.write;
}

/**
 * Guards stdout and stderr (before piMain, so Pi's output guard binds the wrappers) and returns an
 * inline extension that aborts the run and skips further prompts once stdout's reader has gone. A
 * closed stderr (`2>&1 | head`) only stops MMP writing there: nothing could show an error anyway.
 */
export function guardClosedStdout(): InlineExtension {
  let stdoutClosed = false;
  const onStdoutClosed: Array<() => void> = [];
  endOnClosedPipe(process.stdout, () => {
    stdoutClosed = true;
    for (const listener of onStdoutClosed) listener();
  });
  endOnClosedPipe(process.stderr, () => {});

  return {
    name: "mmp:closed-stdout",
    factory(pi) {
      let abort: (() => void) | undefined;
      onStdoutClosed.push(() => abort?.());
      pi.on("session_start", (_event, ctx) => {
        abort = () => ctx.abort();
      });
      // `-p a b` prompts once per message; after the reader has gone the rest are skipped.
      pi.on("input", () => (stdoutClosed ? { action: "handled" as const } : { action: "continue" as const }));
    },
  };
}
