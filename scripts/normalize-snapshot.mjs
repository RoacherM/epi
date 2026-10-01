// Shared by scripts/benchmark-adapter.mjs and scripts/model-snapshot.mjs: makes a JSON-ish value
// byte-identical across two otherwise-equivalent runs by sorting object keys and rewriting absolute
// paths (temp dirs, cwd) to fixed tokens. A plain module (no top-level execution), so importing it
// never runs anything -- unlike importing a CLI script directly for its helpers would.
import { relative, sep } from "node:path";

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function normalizePathString(value, roots) {
  for (const [rootPath, token] of roots) {
    if (value === rootPath) {
      return token;
    }
    if (value.startsWith(`${rootPath}${sep}`)) {
      return `${token}/${relative(rootPath, value).split(sep).join("/")}`;
    }
  }
  return value;
}

export function normalizeSnapshot(value, roots) {
  if (typeof value === "string") {
    return normalizePathString(value, roots);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSnapshot(item, roots));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeSnapshot(item, roots),
      ]),
    );
  }
  return value;
}
