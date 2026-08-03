function copyResource(resource) {
    return {
        kind: resource.kind,
        value: resource.value,
        source: resource.source,
        declaredIn: resource.declaredIn,
    };
}
export function createMmpRuntimeIdentity(options) {
    const project = options.assembly.projectManifest;
    return {
        runtime: {
            name: "MMP",
            version: options.mmpVersion,
            engine: "Pi",
            engineVersion: options.piVersion,
        },
        paths: {
            mmpHome: options.mmpHome,
            agentDir: options.assembly.agentDir,
        },
        manifests: {
            global: {
                path: options.assembly.globalManifest,
                loaded: options.assembly.globalManifestLoaded,
            },
            project: {
                discovery: options.assembly.projectDiscovery,
                path: project?.path ?? null,
                trusted: project?.trusted ?? null,
                loaded: project?.loaded ?? false,
            },
        },
        resourcePolicy: {
            discovery: "manifest-only",
            relativePaths: "declaring-manifest-directory",
            ambientResourceDirectoriesLoaded: false,
        },
        declaredResources: {
            rules: options.assembly.rules.map(copyResource),
            skillRoots: options.assembly.skills.map(copyResource),
            inlineExtensions: options.assembly.inlineExtensions.map((extension) => ({
                name: extension.name,
                source: extension.source,
                declaredIn: extension.declaredIn,
            })),
            externalExtensions: options.assembly.externalExtensions.map(copyResource),
        },
    };
}
export function normalizeLoadedSkills(skills) {
    return (skills ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        modelInvocable: !skill.disableModelInvocation,
    }));
}
export function createMmpRuntimeReport(identity, loadedSkills) {
    return {
        ...identity,
        loadedSkills: loadedSkills.map((skill) => ({ ...skill })),
    };
}
export function renderMmpRuntimePrompt(identity, loadedSkills) {
    const report = createMmpRuntimeReport(identity, loadedSkills);
    return [
        "# MMP Runtime Contract",
        "You are hosted by MMP (My Minimal Pi), an SDK harness embedding Pi. When asked which runtime or harness you are using, identify it as MMP on Pi, not as stock Pi alone.",
        "Upstream Pi documentation describes engine features and stock discovery paths. MMP overrides resource discovery: the inventory below is authoritative for this run.",
        "Only `loadedSkills` are loaded skills. A file or skill found elsewhere on disk is not an MMP-loaded capability unless it appears in this inventory.",
        "When asked which skills, rules, or extensions are available, answer from this inventory. Do not scan ambient ~/.pi, ~/.agents, ~/.claude, ~/.codex, .pi, or .agents directories to infer loaded resources.",
        "If the user explicitly asks to inspect an arbitrary directory, you may inspect it, but describe discovered files as files—not as loaded MMP resources.",
        "Manifest-relative resource paths resolve from the directory containing the declaring mmp.json. The MMP agentDir stores Pi auth, settings, sessions, and model catalog state; it is not an ambient skills root.",
        "<mmp_runtime_inventory>",
        JSON.stringify(report, null, 2),
        "</mmp_runtime_inventory>",
    ].join("\n\n");
}
//# sourceMappingURL=runtime-identity.js.map