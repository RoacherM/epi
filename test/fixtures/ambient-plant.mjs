// Plants marked ambient Pi resources everywhere Pi might discover them, for isolation tests.
// The *names* of what to plant (which project-config resources require trust, which context-file
// names Pi looks for) come from the installed Pi itself (pi-ambient-sources.mjs), not a hand-kept
// list here -- a future Pi adding a new discovery source gets planted automatically, and one that
// moves the source Pi reads them from fails loudly instead of silently going untested.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { contextFileCandidateNames, trustRequiringProjectConfigResources } from "./pi-ambient-sources.mjs";

export function plantSkill(skillsDir, name) {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n${name}\n`);
}

/** Plants a marker for one entry of Pi's TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES (trust-manager.js)
 * under `configDir` (a `.pi`-style directory: a project's `.pi`, `~/.pi/agent`, or `~/.mmp/pi`).
 * Throws for a name this doesn't know how to plant -- a directory kind or a `.md` file are the only
 * shapes Pi's list has ever held; anything else needs a new case here, not a silent no-op. */
function plantTrustRequiringResource(configDir, name, tag, markDir) {
  if (name === "extensions") {
    mkdirSync(join(configDir, "extensions"), { recursive: true });
    writeFileSync(
      join(configDir, "extensions", `ambient-${tag}.mjs`),
      `import { writeFileSync } from "node:fs";
export default function (pi) {
  writeFileSync(${JSON.stringify(join(markDir, tag))}, "loaded");
  pi.registerCommand("ambient-ext-${tag}", { handler: async () => {} });
}
`,
    );
    return;
  }
  if (name === "skills") {
    plantSkill(join(configDir, "skills"), `ambient-skill-${tag}`);
    return;
  }
  if (name === "prompts") {
    mkdirSync(join(configDir, "prompts"), { recursive: true });
    writeFileSync(join(configDir, "prompts", `ambient-prompt-${tag}.md`), `---\ndescription: x\n---\nAMBIENT-PROMPT-${tag}\n`);
    return;
  }
  if (name === "themes") {
    mkdirSync(join(configDir, "themes"), { recursive: true });
    writeFileSync(join(configDir, "themes", `ambient-theme-${tag}.json`), JSON.stringify({ name: `ambient-theme-${tag}`, colors: {} }));
    return;
  }
  if (name === "settings.json") {
    // Its ambient effect isn't marker text (it can pick a provider/model, not inject a string into
    // the prompt), so it's covered by the separate "project .pi/settings.json does not apply at
    // runtime" tests below, not by the AMBIENT_MARKER scan.
    return;
  }
  if (name === "mcp.json") {
    // Pi 0.99 added mcp.json to this list (core/trust-manager.js). Its ambient effect, if the
    // native mcp extension ever read it here, would be a spawned child process, not marker text in
    // the system prompt or a registered command -- same shape as "extensions" above, reusing
    // markDir. A plain marker-writing stdio command is enough to prove nothing spawns it; MMP's own
    // native-MCP wiring (docs/mcp-design.md, stage 2) is what actually gets exercised once "mmp:mcp"
    // uses Pi's loadMcpConfig, at which point this same fixture also proves an untrusted project's
    // mcp.json isn't loaded by MMP.
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          [`ambient-${tag}`]: {
            command: process.execPath,
            args: [
              "-e",
              `require("fs").writeFileSync(${JSON.stringify(join(markDir, tag))}, "loaded")`,
            ],
          },
        },
      }),
    );
    return;
  }
  if (name.endsWith(".md")) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, name), `AMBIENT-${name.replace(/\.md$/i, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-${tag}\n`);
    return;
  }
  throw new Error(
    `ambient-plant.mjs: don't know how to plant Pi's trust-requiring project resource ${JSON.stringify(name)} ` +
    "(from trust-manager.js's TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES) -- add a case in plantTrustRequiringResource.",
  );
}

/** Plants every resource in Pi's current TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES list under
 * `configDir`. `configDir` is itself an agent dir root for a global call (`~/.pi/agent`,
 * `~/.mmp/pi`) -- SYSTEM.md/APPEND_SYSTEM.md and the skills/prompts/themes/extensions dirs are
 * ambient there regardless of project trust (resource-loader.js's discoverSystemPromptFile and
 * getDefaultSourceInfoForPath). */
export function plantPiResources(configDir, tag, markDir) {
  for (const name of trustRequiringProjectConfigResources()) {
    plantTrustRequiringResource(configDir, name, tag, markDir);
  }
}

/** Plants every context-file name Pi's `loadContextFileFromDir` looks for (resource-loader.js)
 * directly into `dir` -- the project root (checked at cwd and every ancestor) or an agent dir root,
 * never a `.pi` subdirectory. */
export function plantContextFiles(dir, tag) {
  mkdirSync(dir, { recursive: true });
  for (const name of contextFileCandidateNames()) {
    writeFileSync(join(dir, name), `AMBIENT-CONTEXT-${tag}\n`);
  }
}

/** Plants the full ambient set for a project and home; `marks` collects files written by ambient extensions.
 * Global `~/.agents/skills` is deliberately NOT planted here: since docs/decisions.md S1, MMP itself
 * auto-discovers skills there (test/skill-discovery.test.mjs covers that as a positive case), so it
 * is no longer an "ambient resource that must never load" -- unlike a project's own `.agents/skills`
 * below, which stays forbidden (not a location the user chose for MMP). */
export function plantAmbientWorld({ home, project, marks }) {
  plantPiResources(join(project, ".pi"), "project", marks);
  plantPiResources(join(home, ".pi", "agent"), "pi-agent", marks);
  plantPiResources(join(home, ".mmp", "pi"), "mmp-agent", marks);
  plantContextFiles(join(home, ".pi", "agent"), "pi-agent-global");
  plantContextFiles(join(home, ".mmp", "pi"), "mmp-agent-global");
  plantContextFiles(project, "project-root");
  plantSkill(join(project, ".agents", "skills"), "ambient-skill-project-agents");
  // Not just the project's own .agents/skills -- one in an ancestor directory above it must stay
  // forbidden too (MMP never discovers project .agents/skills at any depth, only the three fixed
  // roots in docs/decisions.md S1).
  plantSkill(join(dirname(project), ".agents", "skills"), "ambient-skill-ancestor-agents");
}

export const AMBIENT_MARKER = /AMBIENT-[A-Z]+-[\w-]+|ambient-(?:ext|skill|prompt|theme)-[\w-]+/g;
