import { MmpArgumentError } from "./errors.js";

// ── Resource flags: only the Manifest may declare Rules/Skills/Extensions (docs/cli-design.md §2) ──
const RESERVED_RESOURCE_FLAGS: Readonly<Record<string, true>> = {
  "--extension": true,
  "-e": true,
  "--no-extensions": true,
  "-ne": true,
  "--skill": true,
  "--no-skills": true,
  "-ns": true,
  "--prompt-template": true,
  "--no-prompt-templates": true,
  "-np": true,
  "--theme": true,
  "--no-themes": true,
  "--no-context-files": true,
  "-nc": true,
  "--system-prompt": true,
  "--append-system-prompt": true,
};

const RESERVED_RESOURCE_VALUE_FLAGS = [
  "--extension",
  "--skill",
  "--prompt-template",
  "--theme",
  "--system-prompt",
  "--append-system-prompt",
] as const;

function findReservedResourceFlag(argument: string): string | undefined {
  if (RESERVED_RESOURCE_FLAGS[argument] === true) {
    return argument;
  }
  return RESERVED_RESOURCE_VALUE_FLAGS.find((flag) => argument.startsWith(`${flag}=`));
}

// ── Flags MMP has decided not to expose, with the reason (docs/cli-design.md §2) ──
const UNSUPPORTED_FLAGS: Readonly<Record<string, string>> = {
  "--use-theme": "MMP's interface is grok-styled, full-screen only, with a single theme MMP manages",
  "--tui-mode": "MMP's TUI is full-screen only",
};

/** Matches `--flag` and, since neither of these takes a bare boolean form in Pi, `--flag=value`
 * too -- otherwise that spelling would fall through to the "hold back for extensions" branch below
 * and produce a worse, unrelated error. */
function findUnsupportedFlagReason(argument: string): string | undefined {
  if (UNSUPPORTED_FLAGS[argument] !== undefined) {
    return UNSUPPORTED_FLAGS[argument];
  }
  const flag = Object.keys(UNSUPPORTED_FLAGS).find((candidate) => argument.startsWith(`${candidate}=`));
  return flag === undefined ? undefined : UNSUPPORTED_FLAGS[flag];
}

type FlagArity = "none" | "value";

/**
 * "forward": validated for arity/unknown-flag purposes only, then pushed verbatim into
 * `passthrough` for Pi's own parser (piMain, or MMP's TUI's `parseArgs` call) to interpret and
 * validate the value of -- MMP does not duplicate Pi's own value validation (enum checks, etc.),
 * so error text for a bad value stays exactly what Pi would say.
 * "mmp": consumed here, never forwarded (dry-run, no-project, approve/no-approve, version, help).
 */
type FlagHandler = "forward" | "dry-run" | "no-project" | "approve" | "no-approve" | "version" | "help";

interface FlagTableEntry {
  flags: readonly string[];
  arity: FlagArity;
  handler: FlagHandler;
  help: string;
}

/**
 * The one table of every flag `mmp` accepts (docs/cli-design.md §2): drives parsing (this file),
 * validation, and `mmp --help` (renderHelp, below). A short flag (`-x`) not in this table, not a
 * reserved resource flag, and not in UNSUPPORTED_FLAGS is rejected outright. A long flag (`--foo`)
 * in none of those is held back instead (Pi's own `parseArgs` `unknownFlags`, cli/args.js) and
 * forwarded on both paths -- it may be one an extension registers with `pi.registerFlag`, which
 * only loading extensions can confirm; downstream (agent-session-services.js's
 * applyExtensionFlagValues, run on both the TUI path and piMain) errors by name if nothing claims
 * it.
 */
export const MMP_FLAG_TABLE: readonly FlagTableEntry[] = [
  { flags: ["--provider"], arity: "value", handler: "forward", help: "--provider <name>              Provider to search for --model (requires --model)" },
  { flags: ["--model"], arity: "value", handler: "forward", help: "--model <pattern>               Model pattern or ID (\"provider/id\", optional \":<thinking>\")" },
  { flags: ["--thinking"], arity: "value", handler: "forward", help: "--thinking <level>              Thinking level: off, minimal, low, medium, high, xhigh, max" },
  { flags: ["--api-key"], arity: "value", handler: "forward", help: "--api-key <key>                 API key (defaults to env vars)" },
  { flags: ["--models"], arity: "value", handler: "forward", help: "--models <patterns>             Comma-separated model patterns for cycling" },
  { flags: ["-c", "--continue"], arity: "none", handler: "forward", help: "-c, --continue                  Continue previous session" },
  { flags: ["-r", "--resume"], arity: "none", handler: "forward", help: "-r, --resume                    Select a session to resume" },
  { flags: ["--session"], arity: "value", handler: "forward", help: "--session <path|id>             Use specific session file or partial UUID" },
  { flags: ["--session-id"], arity: "value", handler: "forward", help: "--session-id <id>               Use exact project session ID, creating it if missing" },
  { flags: ["--fork"], arity: "value", handler: "forward", help: "--fork <path|id>                Fork a session into a new session" },
  { flags: ["--session-dir"], arity: "value", handler: "forward", help: "--session-dir <dir>             Directory for session storage and lookup" },
  { flags: ["--no-session"], arity: "none", handler: "forward", help: "--no-session                    Don't save session (ephemeral)" },
  { flags: ["-n", "--name"], arity: "value", handler: "forward", help: "-n, --name <name>               Set session display name" },
  { flags: ["-t", "--tools"], arity: "value", handler: "forward", help: "-t, --tools <names>             Comma-separated allowlist of tool names to enable" },
  { flags: ["-xt", "--exclude-tools"], arity: "value", handler: "forward", help: "-xt, --exclude-tools <names>    Comma-separated denylist of tool names to disable" },
  { flags: ["-nt", "--no-tools"], arity: "none", handler: "forward", help: "-nt, --no-tools                 Disable all tools by default" },
  { flags: ["-nbt", "--no-builtin-tools"], arity: "none", handler: "forward", help: "-nbt, --no-builtin-tools        Disable built-in tools but keep extension/custom tools" },
  { flags: ["-p", "--print"], arity: "none", handler: "forward", help: "-p, --print                     Non-interactive mode: process prompt and exit" },
  { flags: ["--mode"], arity: "value", handler: "forward", help: "--mode <mode>                   Output mode: text (default), json, or rpc" },
  { flags: ["--list-models"], arity: "none", handler: "forward", help: "--list-models [search]          List available models (optional fuzzy search)" },
  { flags: ["--export"], arity: "value", handler: "forward", help: "--export <file>                 Export session file to HTML and exit" },
  { flags: ["--offline"], arity: "none", handler: "forward", help: "--offline                       Disable startup network operations" },
  { flags: ["--verbose"], arity: "none", handler: "forward", help: "--verbose                       Show startup details (resources, model, session)" },
  { flags: ["-a", "--approve"], arity: "none", handler: "approve", help: "-a, --approve                   Trust the discovered project configuration for this run" },
  { flags: ["-na", "--no-approve"], arity: "none", handler: "no-approve", help: "-na, --no-approve               Ignore the discovered project configuration for this run" },
  { flags: ["--no-project"], arity: "none", handler: "no-project", help: "--no-project                    Disable project .mmp discovery" },
  { flags: ["--dry-run"], arity: "none", handler: "dry-run", help: "--dry-run                       Resolve and validate configuration, print JSON, do not start" },
  { flags: ["-h", "--help"], arity: "none", handler: "help", help: "-h, --help                      Show this help" },
  { flags: ["-v", "--version"], arity: "none", handler: "version", help: "-v, --version                   Show version number" },
];

const FLAG_LOOKUP = new Map<string, FlagTableEntry>(
  MMP_FLAG_TABLE.flatMap((entry) => entry.flags.map((flag) => [flag, entry] as const)),
);

export interface MmpArgs {
  dryRun: boolean;
  noProject: boolean;
  version: boolean;
  update: boolean;
  projectTrustOverride: boolean | undefined;
  passthrough: string[];
}

export function parseMmpArgs(argv: readonly string[]): MmpArgs {
  if (argv[0] === "update") {
    return {
      dryRun: false,
      noProject: false,
      version: false,
      update: true,
      projectTrustOverride: undefined,
      passthrough: argv.slice(1),
    };
  }

  const passthrough: string[] = [];
  let dryRun = false;
  let noProject = false;
  let version = false;
  let projectTrustOverride: boolean | undefined;
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (optionsEnded) {
      passthrough.push(argument);
      continue;
    }

    if (argument === "--") {
      optionsEnded = true;
      passthrough.push(argument);
      continue;
    }

    const reservedFlag = findReservedResourceFlag(argument);
    if (reservedFlag !== undefined) {
      throw new MmpArgumentError(
        `${reservedFlag} is managed by the MMP manifest and cannot be passed directly`,
      );
    }

    if (!argument.startsWith("-") || argument === "-") {
      // A positional message, or an `@file` argument: never validated against the flag table.
      passthrough.push(argument);
      continue;
    }

    const unsupportedReason = findUnsupportedFlagReason(argument);
    if (unsupportedReason !== undefined) {
      throw new MmpArgumentError(`${argument} is not supported by MMP: ${unsupportedReason}.`);
    }

    const entry = FLAG_LOOKUP.get(argument);
    if (entry === undefined) {
      if (!argument.startsWith("--")) {
        throw new MmpArgumentError(`Unknown option: ${argument}`);
      }
      // Extension-registered flag candidate (Pi's parseArgs `unknownFlags`, cli/args.js): held back
      // here, not rejected -- Pi's own parser re-parses `passthrough` on both paths (piMain directly;
      // MMP's TUI via services.ts's `parseArgs`) and matches it against what loaded extensions
      // actually registered (agent-session-services.js's applyExtensionFlagValues), erroring by name
      // if nobody did. MMP never guesses this flag's arity itself: the next token (its value, or the
      // start of the next flag/message) simply falls through this same loop unchanged.
      passthrough.push(argument);
      continue;
    }

    switch (entry.handler) {
      case "dry-run":
        dryRun = true;
        break;
      case "no-project":
        noProject = true;
        break;
      case "approve":
        if (projectTrustOverride === false) {
          throw new MmpArgumentError("--approve and --no-approve cannot be used together");
        }
        projectTrustOverride = true;
        break;
      case "no-approve":
        if (projectTrustOverride === true) {
          throw new MmpArgumentError("--approve and --no-approve cannot be used together");
        }
        projectTrustOverride = false;
        break;
      case "version":
        version = true;
        break;
      case "help":
        // Kept in `passthrough` (matching Pi's own `-h`/`--help` spelling) so host.ts's existing
        // `passthrough.includes("--help")` check keeps working unchanged.
        passthrough.push(argument);
        break;
      case "forward":
        passthrough.push(argument);
        if (entry.arity === "value") {
          if (index + 1 >= argv.length) {
            throw new MmpArgumentError(`${argument} requires a value`);
          }
          index += 1;
          passthrough.push(argv[index]!);
        }
        break;
    }
  }

  return {
    dryRun,
    noProject,
    version,
    update: false,
    projectTrustOverride,
    passthrough,
  };
}

/**
 * Whether `flag` appears in `passthrough` before a `--` separator, not after it. Pi's own parseArgs
 * (cli/args.js) stops interpreting flags entirely at `--`, treating everything after it as positional
 * messages/`@file` arguments -- `mmp -- --help` sends the literal text "--help" as a message, it
 * doesn't print help (bug 9). `passthrough` always contains the `--` token itself (parseMmpArgs,
 * above, pushes it through unchanged), so this only has to find that one marker.
 */
export function passthroughHasFlag(passthrough: readonly string[], flag: string): boolean {
  const dashDashIndex = passthrough.indexOf("--");
  const beforeDashDash = dashDashIndex === -1 ? passthrough : passthrough.slice(0, dashDashIndex);
  return beforeDashDash.includes(flag);
}

/** The shape of Pi's own `ExtensionFlag` (core/extensions/types.ts) that renderHelp's extension
 * section needs -- named locally so this file stays free of an SDK import, matching its existing
 * style (its only import is ./errors.js). */
export interface ExtensionFlagLike {
  name: string;
  type: "boolean" | "string";
  description?: string;
  extensionPath: string;
}

/** Mirrors Pi's own `printHelp`'s extension-flags block (dist/cli/args.js): one line per flag a
 * loaded extension registered with `pi.registerFlag`, padded the same way, falling back to "Registered
 * by <path>" when the extension gave no description. Empty when nothing registered a flag. */
function renderExtensionOptions(extensionFlags: readonly ExtensionFlagLike[]): string {
  if (extensionFlags.length === 0) {
    return "";
  }
  const lines = extensionFlags
    .map((flag) => {
      const value = flag.type === "string" ? " <value>" : "";
      const description = flag.description ?? `Registered by ${flag.extensionPath}`;
      return `  --${flag.name}${value}`.padEnd(32) + description;
    })
    .join("\n");
  return `\nExtension options:\n${lines}\n`;
}

/** `mmp --help`: MMP's own help text, generated from MMP_FLAG_TABLE plus its subcommands. Covers
 * every table flag; never mentions Pi's own CLI or appends Pi's own help (docs/cli-design.md §2).
 * `extensionFlags` (Pi's `resourceLoader.getExtensions().extensions[].flags`, gathered by host.ts
 * before calling this, since collecting them means loading extensions) adds an "Extension options"
 * section the same way Pi's own `--help` does -- omitted when no loaded extension registered one. */
export function renderHelp(extensionFlags: readonly ExtensionFlagLike[] = []): string {
  const flagLines = MMP_FLAG_TABLE.map((entry) => `  ${entry.help}`).join("\n");
  return `mmp - AI coding assistant with read, bash, edit, write tools

Usage:
  mmp [options] [--] [@files...] [messages...]
  mmp <subcommand> [options]

Subcommands:
  mmp update [--self|--extensions|--models|--all] [<source>]     Update mmp, extensions, or the model catalog
  mmp install <source> [-l] [--approve|--no-approve]             Add an extension source to the Manifest
  mmp remove <source> [-l] [--approve|--no-approve]              Remove an extension source from the Manifest
  mmp uninstall <source> [-l] [--approve|--no-approve]           Alias for remove
  mmp list                                                       List Manifest-declared rules, skills, extensions
  mmp config [-l] [--approve|--no-approve]                       Edit the Manifest in $VISUAL/$EDITOR
  mmp auth print-api-key|print-bearer-token|check                Print or check provider credentials
  mmp mcp add|remove|list|login|logout                           Configure and check MCP servers
  mmp <subcommand> --help                                        Show help for that subcommand

Options:
${flagLines}
${renderExtensionOptions(extensionFlags)}
Rules, Skills, and Extensions are declared by the Manifest only (mmp install/remove/list/config).
Ambient themes, prompt templates, context files, and resource CLI flags (--extension, --skill,
--theme, --system-prompt, ...) are rejected; edit the Manifest instead. A --long flag not in this
list is held for extensions the Manifest declares (Pi's own pi.registerFlag); one nothing
registers fails by name before startup.

Environment:
  MMP_HOME                   Absolute MMP configuration root (default: ~/.mmp)
  MMP_DISABLE_UPDATE_CHECK   Do not check for new MMP releases
`;
}
