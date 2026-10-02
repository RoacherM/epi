// Independent oracle for MMP's own version. Deliberately reads package.json itself rather than
// importing MMP_VERSION from dist/version.js: these tests exist to verify version.ts reads package.json
// correctly, so the expected value must come from a source that doesn't share version.ts's own logic
// (comparing its computed value against itself would always pass even if that logic were wrong).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

export const MMP_PACKAGE_VERSION = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
