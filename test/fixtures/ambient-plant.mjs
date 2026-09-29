// Plants marked ambient Pi resources everywhere Pi might discover them, for isolation tests.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Every marker below sits where Pi would discover it without MMP's --no-* flags.
export function plantPiResources(baseDir, tag, markDir) {
  mkdirSync(join(baseDir, "extensions"), { recursive: true });
  writeFileSync(
    join(baseDir, "extensions", `ambient-${tag}.mjs`),
    `import { writeFileSync } from "node:fs";
export default function (pi) {
  writeFileSync(${JSON.stringify(join(markDir, tag))}, "loaded");
  pi.registerCommand("ambient-ext-${tag}", { handler: async () => {} });
}
`,
  );
  plantSkill(join(baseDir, "skills"), `ambient-skill-${tag}`);
  mkdirSync(join(baseDir, "prompts"), { recursive: true });
  writeFileSync(join(baseDir, "prompts", `ambient-prompt-${tag}.md`), `---\ndescription: x\n---\nAMBIENT-PROMPT-${tag}\n`);
  mkdirSync(join(baseDir, "themes"), { recursive: true });
  writeFileSync(join(baseDir, "themes", `ambient-theme-${tag}.json`), JSON.stringify({ name: `ambient-theme-${tag}`, colors: {} }));
  writeFileSync(join(baseDir, "AGENTS.md"), `AMBIENT-CONTEXT-${tag}\n`);
  writeFileSync(join(baseDir, "SYSTEM.md"), `AMBIENT-SYSTEM-${tag}\n`);
  writeFileSync(join(baseDir, "APPEND_SYSTEM.md"), `AMBIENT-APPENDSYSTEM-${tag}\n`);
}

export function plantSkill(skillsDir, name) {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n${name}\n`);
}


/** Plants the full ambient set for a project and home; `marks` collects files written by ambient extensions. */
export function plantAmbientWorld({ home, project, marks }) {
  plantPiResources(join(project, ".pi"), "project", marks);
  plantPiResources(join(home, ".pi", "agent"), "pi-agent", marks);
  plantPiResources(join(home, ".mmp", "pi"), "mmp-agent", marks);
  plantSkill(join(project, ".agents", "skills"), "ambient-skill-project-agents");
  plantSkill(join(home, ".agents", "skills"), "ambient-skill-home-agents");
  writeFileSync(join(project, "AGENTS.md"), "AMBIENT-CONTEXT-agents-md\n");
  writeFileSync(join(project, "CLAUDE.md"), "AMBIENT-CONTEXT-claude-md\n");
  writeFileSync(join(project, "AGENTS.override.md"), "AMBIENT-CONTEXT-override\n");
}

export const AMBIENT_MARKER = /AMBIENT-[A-Z]+-[\w-]+|ambient-(?:ext|skill|prompt|theme)-[\w-]+/g;
