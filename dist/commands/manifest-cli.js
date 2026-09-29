// `mmp install/remove/uninstall/list/config` (docs/cli-design.md §3): every one of these reads or
// writes a Manifest (~/.mmp/mmp.json, or the project's .mmp/mmp.json with -l) through the existing
// manifest code (../manifest.ts), never through Pi's own settings.json or package manager --
// Rules/Skills/Extensions are declared by the Manifest alone (docs/cli-design.md §0).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { MmpArgumentError, MmpConfigError } from "../errors.js";
import { resolveManifest } from "../manifest.js";
import { resolveMmpPaths } from "../paths.js";
import { findNearestProjectManifest, readProjectTrustDecision } from "../project.js";
function globalTarget() {
    return { path: resolveMmpPaths(process.env).globalManifest, source: "global" };
}
/** `-l`: the project Manifest for the current directory. Unlike run-time discovery (project.ts),
 * this does not walk up to an ancestor -- "local" means "here", so `mmp install -l` can create a
 * project's first Manifest in the directory the user is standing in. */
function projectTarget(cwd) {
    return { path: join(cwd, ".mmp", "mmp.json"), source: "project" };
}
/**
 * A `-l` install/remove/config reads and writes the project Manifest the same way a real `mmp` run
 * would read it (through `resolveManifest`, which can execute declared Rules/Skills/Extensions'
 * side effects during resolution) -- exactly what `mmp list` refuses to do for an untrusted project
 * (DEVELOPMENT.md §8.2 rule 1). This mirrors that same check for these three commands, and Pi's own
 * requirement that project-scope package/config commands need `--approve` (package-manager-cli.js's
 * `writesProjectPackageConfig`/`isProjectTrusted` checks): an explicit `--approve`/`--no-approve`
 * overrides the saved decision for this run only (never persisted, same as `resolveProjectManifest`
 * in project.ts); otherwise the last decision from `mmp --approve`/`/trust` applies.
 */
function assertProjectTrustedFor(cwd, approveOverride) {
    const agentDir = resolveMmpPaths(process.env).agentDir;
    const trusted = approveOverride ?? readProjectTrustDecision(agentDir, cwd) === true;
    if (trusted)
        return;
    const manifestPath = projectTarget(cwd).path;
    // Same line `mmp list` prints for an untrusted project Manifest (runListCommand, below).
    throw new MmpArgumentError(`Project (${manifestPath}): not trusted -- not read (mmp --approve or /trust)`);
}
function detectIndent(raw) {
    const match = /\n([ \t]+)\S/.exec(raw);
    return match ? match[1] : "  ";
}
function readManifestJson(path) {
    if (!existsSync(path)) {
        return { indent: "  ", json: { version: 1 } };
    }
    const raw = readFileSync(path, "utf8");
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new MmpConfigError(`${path}: invalid JSON: ${detail}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new MmpConfigError(`${path}: manifest must be a JSON object`);
    }
    return { indent: detectIndent(raw), json: parsed };
}
/** Writes the mutated manifest, preserving the file's existing indent, then re-validates it through
 * the real manifest loader (manifest.ts) -- the same checks every `mmp` run applies. An invalid
 * result is never left on disk: the previous content (or no file, if there wasn't one) is restored
 * and the validation error re-thrown. */
function writeManifest(target, mutate) {
    const before = existsSync(target.path) ? readFileSync(target.path, "utf8") : undefined;
    const { indent, json } = readManifestJson(target.path);
    const next = mutate(json);
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileSync(target.path, `${JSON.stringify(next, null, indent)}\n`);
    try {
        return resolveManifest(target.path, target.source);
    }
    catch (error) {
        if (before === undefined)
            rmSync(target.path, { force: true });
        else
            writeFileSync(target.path, before);
        throw error;
    }
}
function extensionsOf(json) {
    return Array.isArray(json.extensions) ? json.extensions.filter((entry) => typeof entry === "string") : [];
}
function runCommandSucceeds(command, args) {
    return new Promise((resolvePromise) => {
        const child = spawn(command, args, { stdio: "ignore" });
        child.on("error", () => resolvePromise(false));
        child.on("close", (code) => resolvePromise(code === 0));
    });
}
/** Mirrors Pi's own `isOfflineModeEnabled` (package-manager.js): PI_OFFLINE disables every
 * network-backed resolution Pi does, including this same kind of npm/git existence check, so
 * `mmp install` skips it here too instead of failing on a check nothing intends to satisfy. */
function isOffline() {
    const value = process.env.PI_OFFLINE;
    return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}
export async function defaultCheckSourceExists(source) {
    if (isOffline())
        return;
    if (source.type === "npm") {
        if (!(await runCommandSucceeds("npm", ["view", source.spec, "version"]))) {
            throw new MmpArgumentError(`npm package not found: ${source.spec}`);
        }
        return;
    }
    if (!(await runCommandSucceeds("git", ["ls-remote", source.url]))) {
        throw new MmpArgumentError(`git repository not reachable: ${source.url}`);
    }
}
/** `git:<spec>` stores a bare host/path (`github.com/user/repo`, docs/cli-design.md §3's example), an
 * already-schemed/SSH URL, or either of those with a `#ref` suffix pinning a branch/tag/commit (Pi's
 * own git source format, utils/git.js's `split.ref`). Only the repo itself needs to be reachable
 * (docs/cli-design.md §3), not that specific ref, so the `#ref` is dropped for the check. `git
 * ls-remote` needs a real URL, so a bare spec is given an `https://` scheme; anything that already
 * looks like one (a scheme, or `user@host:`) is left alone. */
function gitUrlForReachabilityCheck(spec) {
    const repo = spec.split("#")[0];
    return /^([a-z][a-z0-9+.-]*:\/\/|[^/@]+@)/i.test(repo) ? repo : `https://${repo}`;
}
/**
 * Validates the source before it's ever written to the Manifest (docs/cli-design.md §3), and
 * returns the value to actually store. An `npm:`/`git:` source needs a non-empty package spec that
 * actually resolves (checked via `checkSourceExists`); it's stored as-is. A local path is resolved
 * against the current directory -- where the user typing `mmp install ./ext.mjs` is standing, same
 * as Pi's own `install` -- not against the Manifest's own directory (`~/.mmp/` for a global install,
 * or the project root with `-l`, neither of which is where a relative path on the command line means
 * anything); the absolute result is stored, so manifest.ts's own manifest-relative resolution never
 * re-resolves it against the wrong base.
 */
async function validateAndResolveSource(source, checkSourceExists) {
    if (source.startsWith("npm:") || source.startsWith("git:")) {
        const spec = source.slice(source.indexOf(":") + 1);
        if (spec.length === 0) {
            throw new MmpArgumentError(`extension package source is empty: ${source}`);
        }
        await checkSourceExists(source.startsWith("npm:") ? { type: "npm", spec } : { type: "git", url: gitUrlForReachabilityCheck(spec) });
        return source;
    }
    const resolved = isAbsolute(source) ? source : resolve(process.cwd(), source);
    if (!existsSync(resolved)) {
        throw new MmpArgumentError(`extension path does not exist: ${resolved}`);
    }
    return resolved;
}
/** `-h`/`--help` anywhere in argv, matching Pi's own subcommand help check (dist/main.js's
 * `isAuthCommandHelp`, dist/package-manager-cli.js's `rest.includes("-h") || rest.includes("--help")`)
 * -- MMP's own `mmp auth --help` (auth-cli.ts) already works this way. */
function isHelpRequested(argv) {
    return argv.includes("-h") || argv.includes("--help");
}
/** Mirrors Pi's `printPackageCommandHelp("install")` (dist/package-manager-cli.js), in MMP's own
 * words: a Manifest instead of settings.json, no --approve/--no-approve (parseSourceArgs doesn't
 * accept them -- project trust for `mmp install -l` is decided once, at `mmp --approve`/`/trust`,
 * not per command). */
function renderInstallHelp() {
    return `Usage:
  mmp install <source> [-l] [--approve|--no-approve]

Add an extension source to the Manifest.

Options:
  -l                 Write the project Manifest (.mmp/mmp.json) instead of the global one (~/.mmp/mmp.json)
  -a, --approve      Trust the project Manifest for this -l write, even if the project isn't
                      otherwise trusted (this run only; does not persist -- use mmp --approve or
                      /trust to persist it)
  -na, --no-approve  Refuse an -l write even if the project is otherwise trusted

Examples:
  mmp install npm:@foo/bar
  mmp install git:github.com/user/repo
  mmp install ./local/path
`;
}
/** Mirrors Pi's `printPackageCommandHelp("remove")`. */
function renderRemoveHelp(commandName) {
    return `Usage:
  mmp ${commandName} <source> [-l] [--approve|--no-approve]

Remove an extension source from the Manifest.
Alias: mmp ${commandName === "remove" ? "uninstall" : "remove"} <source> [-l] [--approve|--no-approve]

Options:
  -l                 Remove from the project Manifest (.mmp/mmp.json) instead of the global one (~/.mmp/mmp.json)
  -a, --approve      Trust the project Manifest for this -l write, even if the project isn't
                      otherwise trusted (this run only; does not persist)
  -na, --no-approve  Refuse an -l write even if the project is otherwise trusted

Examples:
  mmp ${commandName} npm:@foo/bar
`;
}
/** Mirrors Pi's `printPackageCommandHelp("list")`. */
function renderListHelp() {
    return `Usage:
  mmp list

List the Rules, Skills, and Extensions declared by the global and project Manifest.
`;
}
/** Mirrors Pi's `printConfigCommandHelp` (dist/package-manager-cli.js). */
function renderConfigHelp() {
    return `Usage:
  mmp config [-l] [--approve|--no-approve]

Open the Manifest in $VISUAL or $EDITOR.
Without -l, edits the global Manifest (~/.mmp/mmp.json). Saved changes are re-validated; an
invalid result is discarded and the previous Manifest kept.

Options:
  -l                 Edit the project Manifest (.mmp/mmp.json) instead of the global one
  -a, --approve      Trust the project Manifest for this -l edit, even if the project isn't
                      otherwise trusted (this run only; does not persist)
  -na, --no-approve  Refuse an -l edit even if the project is otherwise trusted
`;
}
function parseSourceArgs(argv, commandName) {
    let source;
    let local = false;
    let approveOverride;
    for (const argument of argv) {
        if (argument === "-l") {
            local = true;
            continue;
        }
        if (argument === "-a" || argument === "--approve") {
            approveOverride = true;
            continue;
        }
        if (argument === "-na" || argument === "--no-approve") {
            approveOverride = false;
            continue;
        }
        if (argument.startsWith("-")) {
            throw new MmpArgumentError(`Unknown option for mmp ${commandName}: ${argument}`);
        }
        if (source !== undefined) {
            throw new MmpArgumentError(`mmp ${commandName} accepts exactly one source`);
        }
        source = argument;
    }
    if (source === undefined) {
        throw new MmpArgumentError(`mmp ${commandName} requires a source`);
    }
    return { source, local, approveOverride };
}
export async function runInstallCommand(argv, options) {
    if (isHelpRequested(argv)) {
        process.stdout.write(renderInstallHelp());
        return 0;
    }
    const { source: rawSource, local, approveOverride } = parseSourceArgs(argv, "install");
    if (local)
        assertProjectTrustedFor(process.cwd(), approveOverride);
    const target = local ? projectTarget(process.cwd()) : globalTarget();
    const source = await validateAndResolveSource(rawSource, options?.checkSourceExists ?? defaultCheckSourceExists);
    writeManifest(target, (json) => {
        const extensions = extensionsOf(json);
        if (!extensions.includes(source))
            extensions.push(source);
        return { ...json, version: 1, extensions };
    });
    process.stdout.write(`Installed ${source} into ${target.path}. Restart mmp for it to take effect.\n`);
    return 0;
}
export async function runRemoveCommand(argv, commandName) {
    if (isHelpRequested(argv)) {
        process.stdout.write(renderRemoveHelp(commandName));
        return 0;
    }
    const { source, local, approveOverride } = parseSourceArgs(argv, commandName);
    if (local)
        assertProjectTrustedFor(process.cwd(), approveOverride);
    const target = local ? projectTarget(process.cwd()) : globalTarget();
    let removed = false;
    writeManifest(target, (json) => {
        const before = extensionsOf(json);
        const extensions = before.filter((entry) => entry !== source);
        removed = extensions.length !== before.length;
        return { ...json, version: 1, extensions };
    });
    if (!removed) {
        process.stderr.write(`mmp: no matching extension source ${JSON.stringify(source)} in ${target.path}\n`);
        return 1;
    }
    process.stdout.write(`Removed ${source} from ${target.path}. Restart mmp for it to take effect.\n`);
    return 0;
}
function describeManifest(label, manifest, lines) {
    lines.push(`${label} (${manifest.path}):`);
    if (!manifest.loaded) {
        lines.push("  (not found)");
        return;
    }
    for (const rule of manifest.rules)
        lines.push(`  rule      ${rule.value}`);
    for (const skill of manifest.skills)
        lines.push(`  skill     ${skill.value}`);
    for (const extension of manifest.inlineExtensions)
        lines.push(`  extension ${extension.name} (built-in)`);
    for (const extension of manifest.externalExtensions)
        lines.push(`  extension ${extension.value}`);
    const total = manifest.rules.length + manifest.skills.length + manifest.inlineExtensions.length + manifest.externalExtensions.length;
    if (total === 0)
        lines.push("  (empty)");
}
export function runListCommand(argv) {
    if (isHelpRequested(argv)) {
        process.stdout.write(renderListHelp());
        return 0;
    }
    if (argv.length > 0) {
        throw new MmpArgumentError("mmp list takes no arguments");
    }
    const global = globalTarget();
    const lines = [];
    describeManifest("Global", resolveManifest(global.path, "global"), lines);
    const projectCandidate = findNearestProjectManifest(process.cwd(), global.path);
    if (projectCandidate === undefined) {
        lines.push("Project: (none found)");
    }
    else {
        // Same rule as every real run (DEVELOPMENT.md §8.2 rule 1): before a trust decision, at most
        // check the Manifest exists -- never read its declared Rules/Skills/Extensions.
        const agentDir = resolveMmpPaths(process.env).agentDir;
        const trusted = readProjectTrustDecision(agentDir, process.cwd()) === true;
        if (!trusted) {
            lines.push(`Project (${projectCandidate.manifestPath}): not trusted -- not read (mmp --approve or /trust)`);
        }
        else {
            describeManifest("Project", resolveManifest(projectCandidate.manifestPath, "project"), lines);
        }
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
}
export async function runConfigCommand(argv) {
    if (isHelpRequested(argv)) {
        process.stdout.write(renderConfigHelp());
        return 0;
    }
    let local = false;
    let approveOverride;
    for (const argument of argv) {
        if (argument === "-l") {
            local = true;
            continue;
        }
        if (argument === "-a" || argument === "--approve") {
            approveOverride = true;
            continue;
        }
        if (argument === "-na" || argument === "--no-approve") {
            approveOverride = false;
            continue;
        }
        throw new MmpArgumentError(`Unknown option for mmp config: ${argument}`);
    }
    if (local)
        assertProjectTrustedFor(process.cwd(), approveOverride);
    const target = local ? projectTarget(process.cwd()) : globalTarget();
    if (!existsSync(target.path)) {
        mkdirSync(dirname(target.path), { recursive: true });
        writeFileSync(target.path, `${JSON.stringify({ version: 1 }, null, 2)}\n`);
    }
    const before = readFileSync(target.path, "utf8");
    const editorCommand = process.env.VISUAL || process.env.EDITOR;
    if (!editorCommand) {
        throw new MmpConfigError("Set $VISUAL or $EDITOR to edit the Manifest with `mmp config`");
    }
    const [editor, ...editorArgs] = editorCommand.split(" ");
    const exitCode = await new Promise((resolvePromise) => {
        const child = spawn(editor, [...editorArgs, target.path], { stdio: "inherit" });
        child.on("error", () => resolvePromise(1));
        child.on("close", (code) => resolvePromise(code ?? 1));
    });
    if (exitCode !== 0) {
        process.stderr.write(`mmp: editor exited with status ${exitCode}; ${target.path} left unchanged\n`);
        return exitCode;
    }
    try {
        resolveManifest(target.path, target.source);
    }
    catch (error) {
        // Invalid result: restore the file exactly as it was before the edit (docs/cli-design.md §3).
        writeFileSync(target.path, before);
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`mmp: ${message}\n${target.path} left unchanged.\n`);
        return 2;
    }
    process.stdout.write(`Saved ${target.path}. Restart mmp for changes to take effect.\n`);
    return 0;
}
//# sourceMappingURL=manifest-cli.js.map