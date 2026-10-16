// The current git branch, read from HEAD without invoking git (used by the app header and /trace).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
export function readGitBranch(cwd) {
    for (let dir = cwd;; dir = dirname(dir)) {
        try {
            const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
            return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head.slice(0, 7);
        }
        catch {
            if (dirname(dir) === dir)
                return undefined;
        }
    }
}
//# sourceMappingURL=git-branch.js.map