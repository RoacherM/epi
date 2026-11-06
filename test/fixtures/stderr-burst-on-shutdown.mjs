// Test-only (dogfood D64): writes a 4 MiB burst to stderr from session_shutdown, framed by markers,
// so a test can tell whether the process exited before an async stderr pipe was drained.
export default function (pi) {
  pi.on("session_shutdown", () => {
    process.stderr.write(`D64-BEGIN\n${"E".repeat(4 * 1024 * 1024)}\nD64-END\n`);
  });
}
