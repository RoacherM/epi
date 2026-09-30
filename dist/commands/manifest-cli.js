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
import { discoverSkillRoots } from "../skill-discovery.js";
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
 * The rule (DEVELOPMENT.md §8.2 rule 1, `mmp list`'s own check below): a project's `.mmp/mmp.json`
 * is only read when the project is trusted -- `resolveManifest` itself just resolves declared paths,
 * it doesn't execute any Rule/Skill/Extension, but reading an untrusted project's file at all (its
 * declared paths, its JSON) is exactly what an untrusted project must not get to influence. This
 * mirrors that same check for `-l` install/remove/config, and Pi's own requirement that
 * project-scope package/config commands need `--approve` (package-manager-cli.js's
 * `writesProjectPackageConfig`/`isProjectTrusted` checks): an explicit `--approve`/`--no-approve`
 * overrides the saved decision for this run only (never persisted, same as `resolveProjectManifest`
 * in project.ts); otherwise the last decision from `mmp --approve`/`/trust` applies.
 */
export function assertProjectTrustedFor(cwd, approveOverride) {
    const agentDir = resolveMmpPaths(process.env).agentDir;
    const trusted = approveOverride ?? readProjectTrustDecision(agentDir, cwd) === true;
    if (trusted)
        return;
    const manifestPath = projectTarget(cwd).path;
    if (approveOverride === false) {
        // The user just said --no-approve; suggesting "use --approve" here would be self-contradictory.
        throw new MmpArgumentError(`Project (${manifestPath}): refused by --no-approve`);
    }
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
/** Mirrors Pi's own NETWORK_TIMEOUT_MS (package-manager.js's getLatestNpmVersion): without a
 * timeout, a dead host or a private/blocked repo hangs the command for as long as the OS takes to
 * give up (routinely a minute or more), and there's no way to answer a credential prompt anyway. */
export const NETWORK_CHECK_TIMEOUT_MS = 10_000;
function runCheckCommand(command, args, timeoutMs) {
    return new Promise((resolvePromise) => {
        let settled = false;
        let stderr = "";
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolvePromise(result);
        };
        const child = spawn(command, [...args], {
            stdio: ["ignore", "ignore", "pipe"],
            // Without this, git prompting for credentials on a private or missing repo would hang until
            // the timeout below anyway, but with a dangling prompt nothing running non-interactively could
            // ever answer; npm's `view` has no equivalent prompt, so this is a no-op there.
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish({ ok: false, missing: false, stderr: `timed out after ${timeoutMs}ms waiting for ${command}` });
        }, timeoutMs);
        child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.on("error", (error) => finish({ ok: false, missing: error.code === "ENOENT", stderr: error.message }));
        child.on("close", (code) => finish({ ok: code === 0, missing: false, stderr: stderr.trim() }));
    });
}
/**
 * Argument-injection guard: a source starting with `-` would be read as a flag by `git ls-remote`/
 * `npm view` if it ever reached them unguarded -- a reviewer reproduced `git:--upload-pack=...`
 * running an arbitrary command via a malicious upload-pack. `--` immediately before the source in
 * the actual command (below) is the first line of defense; rejecting it here, before any command
 * ever runs, is the second, and catches it even if a future change to the URL-building in
 * `parseGitSpec` ever passed something through unprefixed.
 */
function assertNotFlagLike(value, label) {
    if (value.startsWith("-")) {
        throw new MmpArgumentError(`${label} looks like a command-line flag, not a source: ${value}`);
    }
}
export async function defaultCheckSourceExists(source, options) {
    if (isOffline() || options?.offline === true)
        return;
    const timeoutMs = options?.timeoutMs ?? NETWORK_CHECK_TIMEOUT_MS;
    if (source.type === "npm") {
        const result = await runCheckCommand("npm", ["view", "--", source.spec, "version"], timeoutMs);
        if (result.missing)
            throw new MmpArgumentError("npm is not on PATH; cannot verify the package exists");
        if (!result.ok) {
            throw new MmpArgumentError(`npm package not found: ${source.spec}${result.stderr ? `\n${result.stderr}` : ""}`);
        }
        return;
    }
    const result = await runCheckCommand("git", ["ls-remote", "--", source.url], timeoutMs);
    if (result.missing)
        throw new MmpArgumentError("git is not on PATH; cannot verify the repository exists");
    if (!result.ok) {
        throw new MmpArgumentError(`git repository not reachable: ${source.url}${result.stderr ? `\n${result.stderr}` : ""}`);
    }
}
/** Mirrors Pi's own `isOfflineModeEnabled` (package-manager.js): PI_OFFLINE disables every
 * network-backed resolution Pi does, including this same kind of npm/git existence check, so
 * `mmp install` skips it here too instead of failing on a check nothing intends to satisfy. */
function isOffline() {
    const value = process.env.PI_OFFLINE;
    return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}
/** Mirrors Pi's splitRef (utils/git.js, not exported): finds an `@ref` suffix pinning a
 * branch/tag/commit in each of Pi's three git source shapes -- scp-like (`git@host:path@ref`), an
 * explicit-scheme URL (`scheme://host/path@ref`), and a bare host/path (`host/path@ref`). The
 * separator is `@`, not `#` (a reviewer caught the earlier version splitting on the wrong
 * character -- `git:github.com/user/repo@v1` would have checked the unreachable
 * ".../repo@v1" instead of ".../repo"). Only the repo part is used for the reachability check below;
 * the ref itself isn't checked (docs/cli-design.md §3 only promises the repo is reachable). */
function splitGitRef(url) {
    const scpLikeMatch = /^git@([^:]+):(.+)$/.exec(url);
    if (scpLikeMatch) {
        const pathWithMaybeRef = scpLikeMatch[2] ?? "";
        const refSeparator = pathWithMaybeRef.indexOf("@");
        if (refSeparator < 0)
            return { repo: url };
        const repoPath = pathWithMaybeRef.slice(0, refSeparator);
        const ref = pathWithMaybeRef.slice(refSeparator + 1);
        if (!repoPath || !ref)
            return { repo: url };
        return { repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`, ref };
    }
    if (url.includes("://")) {
        try {
            const parsed = new URL(url);
            const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
            const refSeparator = pathWithMaybeRef.indexOf("@");
            if (refSeparator < 0)
                return { repo: url };
            const repoPath = pathWithMaybeRef.slice(0, refSeparator);
            const ref = pathWithMaybeRef.slice(refSeparator + 1);
            if (!repoPath || !ref)
                return { repo: url };
            parsed.pathname = `/${repoPath}`;
            return { repo: parsed.toString().replace(/\/$/, ""), ref };
        }
        catch {
            return { repo: url };
        }
    }
    const slashIndex = url.indexOf("/");
    if (slashIndex < 0)
        return { repo: url };
    const host = url.slice(0, slashIndex);
    const pathWithMaybeRef = url.slice(slashIndex + 1);
    const refSeparator = pathWithMaybeRef.indexOf("@");
    if (refSeparator < 0)
        return { repo: url };
    const repoPath = pathWithMaybeRef.slice(0, refSeparator);
    const ref = pathWithMaybeRef.slice(refSeparator + 1);
    if (!repoPath || !ref)
        return { repo: url };
    return { repo: `${host}/${repoPath}`, ref };
}
const GIT_URL_SCHEMES = new Set(["https:", "http:", "ssh:", "git:"]);
/** Rejects a path Pi's own buildGitSource (utils/git.js) would also reject: too few segments (needs
 * at least an org/repo), or an unsafe part (a `..` segment, or -- encoded or not -- a null byte or
 * backslash). */
function hasInvalidGitPath(path) {
    const normalized = path.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    if (segments.length < 2)
        return true;
    let decoded;
    try {
        decoded = decodeURIComponent(normalized);
    }
    catch {
        return true;
    }
    return [normalized, decoded].some((candidate) => candidate.includes("\0") || candidate.includes("\\") || candidate.split("/").includes(".."));
}
/**
 * Parses and validates a `git:<spec>` source (the part after the `git:` prefix), scoped to the
 * shapes MMP's own docs show (docs/cli-design.md §3): a bare `host/path`, an explicit
 * `https/http/ssh/git` URL, or `git@host:path` scp syntax, each optionally with an `@ref`. Mirrors
 * the structural checks Pi's own parseGitUrl/buildGitSource (utils/git.js, not exported) apply --
 * host present (a dot, or "localhost", for the bare form), only those four schemes, at least an
 * org/repo path, no unsafe path parts -- so a spec Pi's own loader would reject at `mmp` startup is
 * caught here first, before it's ever written to the Manifest, instead of surfacing as a confusing
 * "not reachable" from a mis-built check URL (or, worse, silently written and failing only on the
 * next `mmp` run). This is a deliberate subset: it doesn't replicate parseGitUrl's
 * hosted-git-info-based shorthand (an unprefixed "user/repo" resolving to GitHub, bitbucket
 * detection, and the like), since MMP's own git: examples always give an explicit host.
 */
function parseGitSpec(spec) {
    const { repo } = splitGitRef(spec);
    assertNotFlagLike(repo, "git repository");
    const scpLikeMatch = /^git@([^:@/]+):(.+)$/.exec(repo);
    if (scpLikeMatch) {
        const host = scpLikeMatch[1];
        if (!host || hasInvalidGitPath(scpLikeMatch[2])) {
            throw new MmpArgumentError(`git source is not a valid repository: git:${spec}`);
        }
        return { url: repo };
    }
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(repo);
    if (schemeMatch) {
        if (!GIT_URL_SCHEMES.has(schemeMatch[1].toLowerCase() + ":")) {
            throw new MmpArgumentError(`git source uses an unsupported scheme (${schemeMatch[1]}:); only https, http, ssh, and git are accepted: git:${spec}`);
        }
        let parsed;
        try {
            parsed = new URL(repo);
        }
        catch {
            throw new MmpArgumentError(`git source is not a valid URL: git:${spec}`);
        }
        if (!parsed.hostname || hasInvalidGitPath(parsed.pathname)) {
            throw new MmpArgumentError(`git source is not a valid repository: git:${spec}`);
        }
        return { url: repo };
    }
    const slashIndex = repo.indexOf("/");
    if (slashIndex < 0) {
        throw new MmpArgumentError(`git source is not a valid repository (expected host/path): git:${spec}`);
    }
    const host = repo.slice(0, slashIndex);
    const path = repo.slice(slashIndex + 1);
    if ((!host.includes(".") && host !== "localhost") || hasInvalidGitPath(path)) {
        throw new MmpArgumentError(`git source is not a valid repository (expected host/path): git:${spec}`);
    }
    return { url: `https://${repo}` };
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
        if (source.startsWith("npm:")) {
            assertNotFlagLike(spec, "npm package");
            await checkSourceExists({ type: "npm", spec });
        }
        else {
            const { url } = parseGitSpec(spec);
            await checkSourceExists({ type: "git", url });
        }
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
export function isHelpRequested(argv) {
    return argv.includes("-h") || argv.includes("--help");
}
/** Mirrors Pi's `printPackageCommandHelp("install")` (dist/package-manager-cli.js), in MMP's own
 * words: a Manifest instead of settings.json, no --approve/--no-approve (parseSourceArgs doesn't
 * accept them -- project trust for `mmp install -l` is decided once, at `mmp --approve`/`/trust`,
 * not per command). */
function renderInstallHelp() {
    return `Usage:
  mmp install <source> [-l] [--approve|--no-approve] [--offline]

Add an extension source to the Manifest.

Options:
  -l                 Write the project Manifest (.mmp/mmp.json) instead of the global one (~/.mmp/mmp.json)
  -a, --approve      Trust the project Manifest for this -l write, even if the project isn't
                      otherwise trusted (this run only; does not persist -- use mmp --approve or
                      /trust to persist it)
  -na, --no-approve  Refuse an -l write even if the project is otherwise trusted
  --offline          Skip checking that an npm:/git: source actually resolves (like PI_OFFLINE)

Examples:
  mmp install npm:@foo/bar
  mmp install git:github.com/user/repo
  mmp install git:github.com/user/repo@v1.0
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
    // Only `install` acts on this (its own existence check, below); accepted here too so `remove`
    // doesn't need a separate parser for the one flag it ignores.
    let offline = false;
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
        if (argument === "--offline") {
            offline = true;
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
    return { source, local, approveOverride, offline };
}
export async function runInstallCommand(argv, options) {
    if (isHelpRequested(argv)) {
        process.stdout.write(renderInstallHelp());
        return 0;
    }
    const { source: rawSource, local, approveOverride, offline } = parseSourceArgs(argv, "install");
    if (local)
        assertProjectTrustedFor(process.cwd(), approveOverride);
    const target = local ? projectTarget(process.cwd()) : globalTarget();
    const checkSourceExists = options?.checkSourceExists ??
        ((parsedSource) => defaultCheckSourceExists(parsedSource, { offline }));
    const source = await validateAndResolveSource(rawSource, checkSourceExists);
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
    const mmpPaths = resolveMmpPaths(process.env);
    const global = globalTarget();
    const lines = [];
    describeManifest("Global", resolveManifest(global.path, "global"), lines);
    const projectCandidate = findNearestProjectManifest(process.cwd(), global.path);
    let trustedProjectRoot;
    if (projectCandidate === undefined) {
        lines.push("Project: (none found)");
    }
    else {
        // Same rule as every real run (DEVELOPMENT.md §8.2 rule 1): before a trust decision, at most
        // check the Manifest exists -- never read its declared Rules/Skills/Extensions.
        const trusted = readProjectTrustDecision(mmpPaths.agentDir, process.cwd()) === true;
        if (!trusted) {
            lines.push(`Project (${projectCandidate.manifestPath}): not trusted -- not read (mmp --approve or /trust)`);
        }
        else {
            trustedProjectRoot = projectCandidate.root;
            describeManifest("Project", resolveManifest(projectCandidate.manifestPath, "project"), lines);
        }
    }
    const discovered = discoverSkillRoots({
        environment: process.env,
        mmpHome: mmpPaths.mmpHome,
        agentDir: mmpPaths.agentDir,
        trustedProjectRoot,
    });
    lines.push("Discovered skill roots:");
    if (discovered.length === 0) {
        lines.push("  (none)");
    }
    else {
        for (const root of discovered)
            lines.push(`  skill     ${root.value} (discovered: ${root.discovered})`);
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