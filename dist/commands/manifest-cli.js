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
/**
 * Validates the source before it's ever written to the Manifest (docs/cli-design.md §3), and
 * returns the value to actually store. An `npm:`/`git:` source needs a non-empty package spec and
 * is stored as-is. A local path is resolved against the current directory -- where the user typing
 * `mmp install ./ext.mjs` is standing, same as Pi's own `install` -- not against the Manifest's own
 * directory (`~/.mmp/` for a global install, or the project root with `-l`, neither of which is
 * where a relative path on the command line means anything); the absolute result is stored, so
 * manifest.ts's own manifest-relative resolution never re-resolves it against the wrong base.
 */
function validateAndResolveSource(source) {
    if (source.startsWith("npm:") || source.startsWith("git:")) {
        if (source.slice(source.indexOf(":") + 1).length === 0) {
            throw new MmpArgumentError(`extension package source is empty: ${source}`);
        }
        return source;
    }
    const resolved = isAbsolute(source) ? source : resolve(process.cwd(), source);
    if (!existsSync(resolved)) {
        throw new MmpArgumentError(`extension path does not exist: ${resolved}`);
    }
    return resolved;
}
function parseSourceArgs(argv, commandName) {
    let source;
    let local = false;
    for (const argument of argv) {
        if (argument === "-l") {
            local = true;
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
    return { source, local };
}
export async function runInstallCommand(argv) {
    const { source: rawSource, local } = parseSourceArgs(argv, "install");
    const target = local ? projectTarget(process.cwd()) : globalTarget();
    const source = validateAndResolveSource(rawSource);
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
    const { source, local } = parseSourceArgs(argv, commandName);
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
    let local = false;
    for (const argument of argv) {
        if (argument === "-l") {
            local = true;
            continue;
        }
        throw new MmpArgumentError(`Unknown option for mmp config: ${argument}`);
    }
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