// Pi interface inventory (docs/pi-upgrade-design.md 3, "Pi 接口清单"): statically collects every
// name MMP imports from Pi's three pinned packages and asserts each still exists in the installed
// package. A Pi upgrade that deletes or renames one of these (as 0.84 did to pi-ai's `complete`)
// fails here with the exact symbol and the file that imports it, instead of surfacing as a build
// error or a runtime crash somewhere else.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src");

const PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai"];

function listSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

/** Every name MMP statically imports from one of PACKAGES: `{ file, pkg, name, typeOnly }`.
 * A namespace import (`import * as ns from pkg`) has no per-symbol name to check and is skipped --
 * `ns.whatever` is checked at runtime by whatever calls it, same as any other property access. */
function collectImports() {
  const results = [];
  for (const file of listSourceFiles(srcDir)) {
    const text = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const pkg = statement.moduleSpecifier.text;
      if (!PACKAGES.includes(pkg)) continue;
      const clause = statement.importClause;
      if (!clause) continue; // side-effect-only import: `import "pkg"`
      const declarationTypeOnly = clause.isTypeOnly === true;
      if (clause.name) {
        results.push({ file, pkg, name: "default", typeOnly: declarationTypeOnly });
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          results.push({ file, pkg, name: importedName, typeOnly: declarationTypeOnly || element.isTypeOnly === true });
        }
      }
    }
  }
  return results;
}

/** The installed package's runtime-visible export names (`Object.keys` of its evaluated entry
 * module), for value imports. */
async function runtimeExportNames(pkg) {
  const mod = await import(pkg);
  return new Set(Object.keys(mod));
}

/** The installed package's type-level export names, read from its entry `.d.ts` with the
 * TypeScript compiler API -- covers `type`/`interface` exports that value imports (and thus
 * `runtimeExportNames`) never see, since they're erased at build time. */
function typeExportNames(pkg) {
  const entry = new URL(import.meta.resolve(pkg));
  const dtsPath = join(dirname(fileURLToPath(entry)), "index.d.ts");
  const program = ts.createProgram([dtsPath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    allowJs: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(dtsPath);
  if (!sourceFile) {
    throw new Error(`pi-interface-inventory: could not load ${pkg}'s entry .d.ts at ${dtsPath}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(`pi-interface-inventory: ${dtsPath} has no resolvable module symbol -- Pi changed its .d.ts shape.`);
  }
  return new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name));
}

test("every name MMP imports from Pi's three pinned packages exists in the installed package", async () => {
  const imports = collectImports();
  assert.ok(imports.length > 50, `expected many Pi imports across src/, found ${imports.length} -- collectImports() likely broke`);

  const runtimeNames = new Map();
  const typeNames = new Map();
  for (const pkg of PACKAGES) {
    runtimeNames.set(pkg, await runtimeExportNames(pkg));
    typeNames.set(pkg, typeExportNames(pkg));
  }

  // tsconfig.json's verbatimModuleSyntax makes this exact: a non-type-only import is emitted
  // verbatim into dist/, so tsc would already refuse to build it as anything but a real runtime
  // binding (a pure-type name must be marked `type`, or tsc raises TS1484). So a value import is
  // checked only against the runtime module, a type-only one only against the .d.ts's exports.
  const missing = [];
  for (const { file, pkg, name, typeOnly } of imports) {
    const available = typeOnly ? typeNames.get(pkg) : runtimeNames.get(pkg);
    if (!available.has(name)) {
      missing.push(`${name} (${typeOnly ? "type" : "value"} import of ${pkg} in ${file.slice(root.length + 1)})`);
    }
  }
  assert.deepEqual(missing, [], `Pi no longer exports:\n${missing.join("\n")}`);
});
