import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import { MmpConfigError } from "./errors.js";

export interface MmpPaths {
  mmpHome: string;
  agentDir: string;
  globalManifest: string;
}

export function resolveMmpPaths(
  environment: NodeJS.ProcessEnv = process.env,
): MmpPaths {
  const configuredHome = environment.MMP_HOME;
  const mmpHome = configuredHome ?? join(homedir(), ".mmp");

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
