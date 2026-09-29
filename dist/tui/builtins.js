import { runLogin, runLogout, runModel, runTrust } from "./commands.js";
export const BUILTIN_COMMANDS = [
    { name: "login", description: "Log in to a model provider", argumentHint: "<provider>", run: (host, args) => runLogin(host, args) },
    { name: "logout", description: "Remove stored credentials", run: (host) => runLogout(host) },
    { name: "model", description: "Select a model", argumentHint: "<provider/model>", run: (host, args) => runModel(host, args) },
    { name: "new", description: "Start a new session", run: async (host) => void (await host.runtime.newSession()) },
    { name: "quit", description: "Quit MMP", run: (host) => host.exit(0) },
    { name: "trust", description: "Trust or distrust the current project's .mmp/mmp.json", run: (host) => runTrust(host) },
];
/** Pi built-ins not wired yet, in the priority order agreed for M3 (P0, then P1, then P2). */
const PLANNED = {
    compact: "Compact the session context",
    resume: "Resume a different session",
    thinking: "Set thinking level",
    copy: "Copy the last assistant message",
    reload: "Reload extensions, skills, prompts and context files",
    tree: "Navigate the session tree",
    fork: "Fork from a previous user message",
    clone: "Duplicate the current session",
    name: "Set the session name",
    session: "Show session info and stats",
    export: "Export the session (HTML or JSONL)",
    import: "Import a session from a JSONL file",
    hotkeys: "Show keyboard shortcuts",
    settings: "Open settings",
    "scoped-models": "Choose models for model cycling",
};
/** Pi built-ins MMP leaves out on purpose, with the reason shown to the user. */
const NOT_IN_MMP = {
    share: "Sharing sessions to a gist is not part of MMP.",
    bug: "/bug reports to the Pi developers; report MMP issues on MMP's GitHub instead.",
    changelog: "Run mmp update to see and install new MMP releases.",
};
export function findBuiltin(name) {
    const command = BUILTIN_COMMANDS.find((candidate) => candidate.name === name);
    if (command !== undefined)
        return { kind: "run", command };
    if (name in PLANNED)
        return { kind: "planned", message: `/${name} is not in MMP TUI v2 yet; use classic mmp (without MMP_TUI=v2) for now.` };
    if (name in NOT_IN_MMP)
        return { kind: "excluded", message: `/${name} is not available in MMP. ${NOT_IN_MMP[name]}` };
    return undefined;
}
/** Everything `/` can complete: built-ins (planned ones marked), prompt templates, extension commands, skills. */
export function slashCompletions(session) {
    const builtins = [
        ...BUILTIN_COMMANDS.map(({ name, description, argumentHint }) => ({ name, description, ...(argumentHint === undefined ? {} : { argumentHint }) })),
        ...Object.entries(PLANNED).map(([name, description]) => ({ name, description: `${description} (not in v2 yet)` })),
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
//# sourceMappingURL=builtins.js.map