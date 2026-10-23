// Shared temporary-directory cleanup for tests. A child process (a fake media tool, say) can still
// be writing into the directory when the test ends, and a bare rmSync then races it with ENOTEMPTY
// (see 5e554c2: it hung the 0.1.24 review for 21 minutes). Retry instead of racing.
import { rmSync } from "node:fs";

export function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
