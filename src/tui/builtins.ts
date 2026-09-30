// Built-in slash commands of MMP TUI v2 (docs/tui-design.md 4.6). Pi implements its built-ins inside
// its own interactive mode, which MMP replaces, so each one is re-wired here. Like Pi, a built-in
// wins over an extension command with the same name.
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { CommandHost } from "./command-host.js";
import { runLogin, runLogout, runModel, runTrust } from "./commands.js";
import { runExport, runImport } from "./export-commands.js";
import { runHotkeys, runName, runScopedModels, runSession } from "./info-commands.js";
import { runCompact, runCopy, runReload, runResume, runThinking } from "./session-commands.js";
import { runClone, runFork, runTree } from "./session-tree-commands.js";
import { runSettings } from "./settings-command.js";
import { runBug, runChangelog, runShare } from "./share-commands.js";

export interface BuiltinCommand {
  name: string;
  description: string;
  argumentHint?: string;
  run(host: CommandHost, args: string): Promise<void>;
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "login", description: "Log in to a model provider", argumentHint: "<provider>", run: (host, args) => runLogin(host, args) },
  { name: "logout", description: "Remove stored credentials", run: (host) => runLogout(host) },
  { name: "model", description: "Select a model", argumentHint: "<provider/model>", run: (host, args) => runModel(host, args) },
  { name: "new", description: "Start a new session", run: async (host) => void (await host.runtime.newSession()) },
  { name: "quit", description: "Quit MMP", run: (host) => host.exit(0) },
  { name: "compact", description: "Compact the session context", argumentHint: "[instructions]", run: (host, args) => runCompact(host, args) },
  { name: "resume", description: "Resume a different session", run: async (host) => { await runResume(host); } },
  { name: "thinking", description: "Set thinking level", argumentHint: "[level]", run: (host, args) => runThinking(host, args) },
  { name: "copy", description: "Copy the last assistant message", run: (host) => runCopy(host) },
  { name: "reload", description: "Reload extensions, skills, prompts and context files", run: (host) => runReload(host) },
  { name: "trust", description: "Trust or distrust the current project's .mmp/mmp.json", run: (host) => runTrust(host) },
  { name: "tree", description: "Navigate the session tree", run: (host) => runTree(host) },
  { name: "fork", description: "Fork from a previous user message", run: (host) => runFork(host) },
  { name: "clone", description: "Duplicate the current session", run: (host) => runClone(host) },
  { name: "name", description: "Set or show the session name", argumentHint: "[name]", run: (host, args) => runName(host, args) },
  { name: "session", description: "Show session info and stats", run: (host) => runSession(host) },
  { name: "export", description: "Export the session (HTML or JSONL)", argumentHint: "[path]", run: (host, args) => runExport(host, args) },
  { name: "import", description: "Replace the current session from a JSONL file", argumentHint: "<path>", run: (host, args) => runImport(host, args) },
  { name: "settings", description: "Open settings menu", run: (host) => runSettings(host) },
  { name: "hotkeys", description: "Show keyboard shortcuts", run: (host) => runHotkeys(host) },
  { name: "scoped-models", description: "Choose models for Ctrl+P cycling", run: (host) => runScopedModels(host) },
  { name: "share", description: "Share the session as a private gist", run: (host) => runShare(host) },
  { name: "changelog", description: "Show MMP's release notes", run: (host) => runChangelog(host) },
  { name: "bug", description: "Report an MMP bug on GitHub", argumentHint: "[description]", run: (host, args) => runBug(host, args) },
];

/** Pi built-ins not wired yet. */
const PLANNED: Record<string, string> = {};

/** Pi built-ins MMP leaves out on purpose, with the reason shown to the user. */
const NOT_IN_MMP: Record<string, string> = {};

export type BuiltinLookup =
  | { kind: "run"; command: BuiltinCommand }
  | { kind: "planned" | "excluded"; message: string }
  | undefined;

export function findBuiltin(name: string): BuiltinLookup {
  const command = BUILTIN_COMMANDS.find((candidate) => candidate.name === name);
  if (command !== undefined) return { kind: "run", command };
  if (name in PLANNED) return { kind: "planned", message: `/${name} is not available in MMP yet.` };
  if (name in NOT_IN_MMP) return { kind: "excluded", message: `/${name} is not available in MMP. ${NOT_IN_MMP[name]}` };
  return undefined;
}

export interface SlashCompletion {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** Everything `/` can complete: built-ins (planned ones marked), prompt templates, extension commands, skills. */
export function slashCompletions(session: AgentSession): SlashCompletion[] {
  const builtins: SlashCompletion[] = [
    ...BUILTIN_COMMANDS.map(({ name, description, argumentHint }) => ({ name, description, ...(argumentHint === undefined ? {} : { argumentHint }) })),
    ...Object.entries(PLANNED).map(([name, description]) => ({ name, description: `${description} (not yet)` })),
  ];
  const taken = new Set([...builtins.map((command) => command.name), ...Object.keys(NOT_IN_MMP)]);
  const templates = session.promptTemplates.map((template) => ({
    name: template.name,
    ...(template.description === undefined ? {} : { description: template.description }),
    ...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
  }));
  const extensions = session.extensionRunner.getRegisteredCommands()
    .filter((command) => !taken.has(command.name))
    .map((command) => ({ name: command.invocationName, ...(command.description === undefined ? {} : { description: command.description }) }));
  // Pi always expands /skill:name when sent; the setting only controls whether they are suggested.
  const skillsShown = session.settingsManager.getEnableSkillCommands();
  const skills = (skillsShown ? session.resourceLoader.getSkills().skills : []).map((skill) => ({
    name: `skill:${skill.name}`,
    ...(skill.description === undefined ? {} : { description: skill.description }),
  }));
  return [...builtins, ...templates, ...extensions, ...skills];
}
