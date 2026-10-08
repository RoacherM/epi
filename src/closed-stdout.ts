// Dogfood D54: `epi -p hi | head -c1` (or `| true`) crashed with Node's unhandled EPIPE stack and
// exit 1, killing a session_shutdown handler half way. Pi's print mode writes stdout through
// core/output-guard.js, which binds `process.stdout.write` when stdout is taken over (`takeOverStdout`),
// retries only ENOBUFS/EAGAIN and otherwise calls process.exit(1); nothing listens for the stream's
// `error` event (docs/pi-internals.md `output-guard-stdout-write`).
//
// Epi treats a reader that has gone away as a normal end, like ripgrep or fd rather than a SIGPIPE
// kill: stop writing, stop the run (nobody reads the rest), let Pi dispose the session as usual so
// session_shutdown handlers finish, and exit with the run's own code, quietly. stderr gets the same
// treatment without stopping the run (`2>&1 | head -c1` closes both; Epi's own final flush in
// host.ts hit EPIPE there). Any other write error still fails loudly (hard rule 3).
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

type WriteCallback = (error?: Error | null) => void;

/**
 * Write errors that mean the reader has gone (dogfood D60). EPIPE is the pipe case. Node's `spawn`
 * stdio are Unix socketpairs, where a write racing the peer's close can fail with ENOTCONN instead
 * (seen on macOS under load; Node's own `net` `_final` treats ENOTCONN from shutdown as already
 * finished), or ECONNRESET (a stream socket's peer closed with data unread). ERR_STREAM_DESTROYED is a write after Node destroyed the
 * stream for one of those. Anything else (EIO, EBADF, ...) is not a closed reader and stays loud.
 */
const CLOSED_READER_CODES = new Set(["EPIPE", "ENOTCONN", "ECONNRESET", "ERR_STREAM_DESTROYED"]);

function isClosedPipe(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && CLOSED_READER_CODES.has(code);
}

/**
 * Makes `stream` treat a closed reader (`isClosedPipe`) as the end of its output: the error is
 * swallowed (no `error` crash, the write's callback succeeds), every later write is dropped, and
 * `onClosed` runs once. A socket reports it to the write's callback and then as `error`; a stream
 * whose `_write` throws reports it synchronously from `write`. Both are handled.
 */
export function endOnClosedPipe(stream: NodeJS.WriteStream, onClosed: () => void): void {
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
    try {
      return typeof encoding === "function"
        ? (write as (...args: unknown[]) => boolean).call(this, chunk, wrapped)
        : (write as (...args: unknown[]) => boolean).call(this, chunk, encoding, wrapped);
    } catch (error) {
      if (!isClosedPipe(error)) throw error;
      markClosed();
      if (done) process.nextTick(done);
      return true;
    }
  } as typeof stream.write;
}

/**
 * Guards stdout and stderr (before the takeover, so Pi's output guard binds the wrappers) and returns an
 * inline extension that aborts the run and skips further prompts once stdout's reader has gone, and
 * whether it has gone (an aborted run is then not a failure, noninteractive.ts). A closed stderr
 * (`2>&1 | head`) only stops Epi writing there: nothing could show an error anyway.
 * Print/json runs only: host.ts leaves `--mode rpc` to Pi.
 */
export function guardClosedStdout(): { extension: InlineExtension; isStdoutClosed: () => boolean } {
  let stdoutClosed = false;
  const onStdoutClosed: Array<() => void> = [];
  endOnClosedPipe(process.stdout, () => {
    stdoutClosed = true;
    for (const listener of onStdoutClosed) listener();
  });
  endOnClosedPipe(process.stderr, () => {});

  const extension: InlineExtension = {
    name: "epi:closed-stdout",
    factory(pi) {
      let abort: (() => void) | undefined;
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
      pi.on("input", () => (stdoutClosed ? { action: "handled" as const } : { action: "continue" as const }));
    },
  };
  return { extension, isStdoutClosed: () => stdoutClosed };
}
