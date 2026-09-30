import type { ResolvedAssembly } from "./assembly.js";
import type {
  DiscoveredSkillProvenance,
  ResolvedInlineExtension,
  ResolvedResource,
} from "./manifest.js";

export interface MmpRuntimeResource {
  kind: ResolvedResource["kind"];
  value: string;
  source: ResolvedResource["source"];
  declaredIn: string;
  /** Set only for an auto-discovered skill root; absent for anything declared in a Manifest. */
  discovered?: DiscoveredSkillProvenance;
}

export interface MmpRuntimeExtension {
  name: string;
  source: ResolvedInlineExtension["source"];
  declaredIn: string;
}

export interface MmpLoadedSkill {
  name: string;
  description: string;
  filePath: string;
  modelInvocable: boolean;
}

export interface MmpRuntimeIdentity {
  runtime: {
    name: "MMP";
    version: string;
    engine: "Pi";
    engineVersion: string;
  };
  paths: {
    mmpHome: string;
    agentDir: string;
  };
  manifests: {
    global: {
      path: string;
      loaded: boolean;
    };
    project: {
      discovery: ResolvedAssembly["projectDiscovery"];
      path: string | null;
      trusted: boolean | null;
      loaded: boolean;
    };
  };
  resourcePolicy: {
    discovery: "manifest-and-fixed-skill-roots";
    relativePaths: "declaring-manifest-directory";
    /** The only three directories skills are auto-discovered from beyond the Manifest
     * (docs/decisions.md S1); entries actually loaded from them are tagged `discovered` in
     * `skillRoots` below. Never Pi's own discovery paths (~/.pi/agent/skills, MMP's Pi data dir,
     * project .pi/skills) or a project's .agents/skills. */
    fixedSkillRoots: readonly [string, string, string];
    /** Whether Pi's own ambient discovery paths (~/.pi/agent/skills, cwd .pi/skills, cwd
     * .agents/skills, ...) were loaded -- always false; MMP always passes noSkills etc. and feeds
     * Pi only the paths in `skillRoots` via resources_discover. */
    piDiscoveryPathsLoaded: false;
  };
  declaredResources: {
    rules: MmpRuntimeResource[];
    skillRoots: MmpRuntimeResource[];
    inlineExtensions: MmpRuntimeExtension[];
    externalExtensions: MmpRuntimeResource[];
  };
}

interface LoadedSkillLike {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
}

function copyResource(resource: ResolvedResource): MmpRuntimeResource {
  return {
    kind: resource.kind,
    value: resource.value,
    source: resource.source,
    declaredIn: resource.declaredIn,
    ...(resource.discovered === undefined ? {} : { discovered: resource.discovered }),
  };
}

export function createMmpRuntimeIdentity(options: {
  mmpVersion: string;
  piVersion: string;
  mmpHome: string;
  assembly: ResolvedAssembly;
}): MmpRuntimeIdentity {
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
      discovery: "manifest-and-fixed-skill-roots",
      relativePaths: "declaring-manifest-directory",
      fixedSkillRoots: ["~/.agents/skills", "<mmpHome>/skills", "<trusted project>/.mmp/skills"],
      piDiscoveryPathsLoaded: false,
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

export function normalizeLoadedSkills(
  skills: readonly LoadedSkillLike[] | undefined,
): MmpLoadedSkill[] {
  return (skills ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    modelInvocable: !skill.disableModelInvocation,
  }));
}

export function createMmpRuntimeReport(
  identity: MmpRuntimeIdentity,
  loadedSkills: readonly MmpLoadedSkill[],
): MmpRuntimeIdentity & { loadedSkills: MmpLoadedSkill[] } {
  return {
    ...identity,
    loadedSkills: loadedSkills.map((skill) => ({ ...skill })),
  };
}

export function renderMmpRuntimePrompt(
  identity: MmpRuntimeIdentity,
  loadedSkills: readonly MmpLoadedSkill[],
): string {
  const report = createMmpRuntimeReport(identity, loadedSkills);
  return [
    "# MMP Runtime Contract",
    "You are hosted by MMP (Make My Pi), an SDK harness embedding Pi. When asked which runtime or harness you are using, identify it as MMP on Pi, not as stock Pi alone.",
    "Upstream Pi documentation describes engine features and stock discovery paths. MMP overrides resource discovery: the inventory below is authoritative for this run.",
    "Only `loadedSkills` are loaded skills. A file or skill found elsewhere on disk is not an MMP-loaded capability unless it appears in this inventory.",
    "When asked which skills, rules, or extensions are available, answer from this inventory. MMP loads skills only from the Manifest and three fixed roots (tagged `discovered` in `skillRoots`). Do not scan ~/.pi, ~/.claude, ~/.codex, project .pi, or project .agents directories to infer loaded resources; ~/.agents/skills contents are loaded only if they appear in `loadedSkills`.",
    "If the user explicitly asks to inspect an arbitrary directory, you may inspect it, but describe discovered files as files—not as loaded MMP resources.",
    "Manifest-relative resource paths resolve from the directory containing the declaring mmp.json. The MMP agentDir stores Pi auth, settings, sessions, and model catalog state; it is not an ambient skills root.",
    "The Manifest input schema is exactly `{ \"version\": 1, \"rules\": [], \"skills\": [], \"extensions\": [] }`. Inventory fields such as `skillRoots` and `declaredResources` are report-only and must not be written to mmp.json.",
    "After Manifest edits, `/reload` re-resolves Rules and Skills. Extension selection or configuration changes require restarting MMP.",
    "<mmp_runtime_inventory>",
    JSON.stringify(report, null, 2),
    "</mmp_runtime_inventory>",
  ].join("\n\n");
}
