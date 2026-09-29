// Refuses to switch the running MMP process into a session from a different MMP project.
// Manifest extensions (rules, skills, `mmp:*` extensions) are fixed for this process at launch and
// cannot be hot-loaded (DEVELOPMENT.md §8.2): switching into a session whose cwd belongs to another
// project would run shell commands there while the model still saw the launch project's Rules, and
// the target project's Rules/skills would never load. Same-project sessions (e.g. one started in a
// subfolder of the same project) stay allowed. Shared by /resume (session-commands.ts), the
// extension `switchSession`/`fork` actions (app.ts), and startup's `--session`/`--fork` (services.ts).
// See docs/tui-design.md §15.
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { findNearestProjectManifest } from "../project.js";

export interface ProjectIdentity {
  /** The project root this process assembled its manifest from; undefined for no project. */
  readonly root: string | undefined;
  readonly globalManifestPath: string;
}

/**
 * Returns a user-facing refusal message when `targetCwd` belongs to a different project than
 * `identity`, or `undefined` when it's safe. Never throws for a missing/unreadable `targetCwd`;
 * the caller's own next step already reports that case (e.g. Pi's MissingSessionCwdError).
 */
export function refusalForCwd(targetCwd: string, identity: ProjectIdentity): string | undefined {
  let targetRoot: string | undefined;
  try {
    targetRoot = findNearestProjectManifest(targetCwd, identity.globalManifestPath)?.root;
  } catch {
    return undefined;
  }
  return targetRoot === identity.root
    ? undefined
    : `This session belongs to a different project (${targetCwd}).`;
}

/**
 * Same check, for a session file rather than a cwd already in hand. The message names the exact
 * command to open the session in its own project instead.
 */
export function crossProjectRefusal(sessionPath: string, identity: ProjectIdentity): string | undefined {
  const targetCwd = SessionManager.open(sessionPath).getCwd();
  if (refusalForCwd(targetCwd, identity) === undefined) {
    return undefined;
  }
  return `This session belongs to a different project. Open it there instead:\n  cd ${JSON.stringify(targetCwd)} && mmp --session ${JSON.stringify(sessionPath)}`;
}
