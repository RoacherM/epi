import type { ResolvedAssembly } from "./assembly.js";
import type {
  DiscoveredSkillProvenance,
  ResolvedDisabledExtension,
  ResolvedInlineExtension,
  ResolvedResource,
} from "./manifest.js";

export interface EpiRuntimeResource {
  kind: ResolvedResource["kind"];
  value: string;
  source: ResolvedResource["source"];
  declaredIn: string;
  /** Set only for an auto-discovered skill root; absent for anything declared in a Manifest. */
  discovered?: DiscoveredSkillProvenance;
}

export interface EpiRuntimeExtension {
  name: string;
  source: ResolvedInlineExtension["source"];
  /** Absent for a built-in that is on by default (`source: "default"`). */
  declaredIn?: string;
}

export interface EpiRuntimeDisabledExtension {
  name: string;
  source: ResolvedDisabledExtension["source"];
  declaredIn: string;
}

export interface EpiLoadedSkill {
  name: string;
  description: string;
  filePath: string;
  modelInvocable: boolean;
}

export interface EpiRuntimeIdentity {
  runtime: {
    name: "Epi";
    version: string;
    engine: "Pi";
    engineVersion: string;
  };
  paths: {
    epiHome: string;
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
     * `skillRoots` below. Never Pi's own discovery paths (~/.pi/agent/skills, project .pi/skills)
     * or a project's .agents/skills, and never a root inside or containing Pi's state dir
     * (`<epiHome>/pi`: auth, sessions, model catalog, settings). */
    fixedSkillRoots: readonly [string, string, string];
    /** Whether Pi's own ambient discovery paths (~/.pi/agent/skills, cwd .pi/skills, cwd
     * .agents/skills, ...) were loaded -- always false; Epi always passes noSkills etc. and feeds
     * Pi only the paths in `skillRoots` via resources_discover. */
    piDiscoveryPathsLoaded: false;
  };
  declaredResources: {
    rules: EpiRuntimeResource[];
    skillRoots: EpiRuntimeResource[];
    inlineExtensions: EpiRuntimeExtension[];
    externalExtensions: EpiRuntimeResource[];
    /** Built-ins turned off by a Manifest's `"disable"`; omitted when none are, so a run that
     * disables nothing shows the model the same inventory as before the field existed. */
    disabledExtensions?: EpiRuntimeDisabledExtension[];
  };
}

interface LoadedSkillLike {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
}

function copyResource(resource: ResolvedResource): EpiRuntimeResource {
  return {
    kind: resource.kind,
    value: resource.value,
    source: resource.source,
    declaredIn: resource.declaredIn,
    ...(resource.discovered === undefined ? {} : { discovered: resource.discovered }),
  };
}

export function createEpiRuntimeIdentity(options: {
  epiVersion: string;
  piVersion: string;
  epiHome: string;
  assembly: ResolvedAssembly;
}): EpiRuntimeIdentity {
  const project = options.assembly.projectManifest;
  return {
    runtime: {
      name: "Epi",
      version: options.epiVersion,
      engine: "Pi",
      engineVersion: options.piVersion,
    },
    paths: {
      epiHome: options.epiHome,
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
      fixedSkillRoots: ["~/.agents/skills", "<epiHome>/skills", "<trusted project>/.epi/skills"],
      piDiscoveryPathsLoaded: false,
    },
    declaredResources: {
      rules: options.assembly.rules.map(copyResource),
      skillRoots: options.assembly.skills.map(copyResource),
      inlineExtensions: options.assembly.inlineExtensions.map((extension) => ({
        name: extension.name,
        source: extension.source,
        ...(extension.declaredIn === undefined ? {} : { declaredIn: extension.declaredIn }),
      })),
      externalExtensions: options.assembly.externalExtensions.map(copyResource),
      ...(options.assembly.disabledExtensions.length === 0
        ? {}
        : {
            disabledExtensions: options.assembly.disabledExtensions.map((extension) => ({
              name: extension.name,
              source: extension.source,
              declaredIn: extension.declaredIn,
            })),
          }),
    },
  };
}

export function normalizeLoadedSkills(
  skills: readonly LoadedSkillLike[] | undefined,
): EpiLoadedSkill[] {
  return (skills ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    modelInvocable: !skill.disableModelInvocation,
  }));
}

export function createEpiRuntimeReport(
  identity: EpiRuntimeIdentity,
  loadedSkills: readonly EpiLoadedSkill[],
): EpiRuntimeIdentity & { loadedSkills: EpiLoadedSkill[] } {
  return {
    ...identity,
    loadedSkills: loadedSkills.map((skill) => ({ ...skill })),
  };
}

export function renderEpiRuntimePrompt(
  identity: EpiRuntimeIdentity,
  loadedSkills: readonly EpiLoadedSkill[],
): string {
  const report = createEpiRuntimeReport(identity, loadedSkills);
  return [
    "# Epi Runtime Contract",
    "You are hosted by Epi, an SDK harness built on Pi. When asked which runtime or harness you are using, identify it as Epi on Pi, not as stock Pi alone.",
    "Upstream Pi documentation describes engine features and stock discovery paths. Epi overrides resource discovery: the inventory below is authoritative for this run.",
    "Only `loadedSkills` are loaded skills. A file or skill found elsewhere on disk is not an Epi-loaded capability unless it appears in this inventory.",
    "When asked which skills, rules, or extensions are available, answer from this inventory. Epi loads skills only from the Manifest and three fixed roots (tagged `discovered` in `skillRoots`). Do not scan ~/.pi, ~/.claude, ~/.codex, project .pi, or project .agents directories to infer loaded resources; ~/.agents/skills contents are loaded only if they appear in `loadedSkills`.",
    "If the user explicitly asks to inspect an arbitrary directory, you may inspect it, but describe discovered files as files—not as loaded Epi resources.",
    "Manifest-relative resource paths resolve from the directory containing the declaring epi.json. The Epi agentDir stores Pi auth, settings, sessions, and model catalog state; it is not an ambient skills root.",
    "The Manifest input schema is exactly `{ \"version\": 1, \"rules\": [], \"skills\": [], \"extensions\": [], \"disable\": [] }`; the built-ins epi:task, epi:mcp and epi:hooks are on unless listed in `disable`. Inventory fields such as `skillRoots` and `declaredResources` are report-only and must not be written to epi.json.",
    "After Manifest edits, `/reload` re-resolves Rules and Skills. Extension selection or configuration changes require restarting Epi.",
    "<epi_runtime_inventory>",
    JSON.stringify(report, null, 2),
    "</epi_runtime_inventory>",
  ].join("\n\n");
}
