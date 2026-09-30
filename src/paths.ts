import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import { MmpConfigError } from "./errors.js";

export interface MmpPaths {
  mmpHome: string;
  agentDir: string;
  globalManifest: string;
}

/** The one home-directory resolution MMP uses everywhere it needs `~` (this file's own `~/.mmp`
 * default and skill-discovery.ts's fixed `~/.agents/skills` root): `environment.HOME` when set,
 * otherwise the real `os.homedir()`. A test that injects a fake HOME (never the real user's) then
 * gets a consistent `~/.mmp` default and `~/.agents/skills` root, not one real and one fake. In
 * production `environment` is `process.env`, where this is identical to calling `homedir()`
 * directly (it already reads `process.env.HOME` on POSIX). */
export function resolveHomeDir(environment: NodeJS.ProcessEnv): string {
  const configured = environment.HOME;
  return configured !== undefined && configured.length > 0 ? configured : homedir();
}

export function resolveMmpPaths(
  environment: NodeJS.ProcessEnv = process.env,
): MmpPaths {
  const configuredHome = environment.MMP_HOME;
  const mmpHome = configuredHome ?? join(resolveHomeDir(environment), ".mmp");

  if (mmpHome.length === 0 || !isAbsolute(mmpHome)) {
    throw new MmpConfigError("MMP_HOME must be an absolute path");
  }

  const normalizedHome = normalize(mmpHome);
  return {
    mmpHome: normalizedHome,
    agentDir: join(normalizedHome, "pi"),
    globalManifest: join(normalizedHome, "mmp.json"),
  };
}
