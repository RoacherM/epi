// First-run "trust this project?" prompt (DEVELOPMENT.md 8.2). Interactive runs only: when a
// project .mmp/mmp.json is found and nothing (flag or saved decision) has decided its trust yet,
// MMP asks before resolving its own assembly and starting the TUI (src/host.ts). The TUI's
// `/trust` command (src/tui/commands.ts) reuses projectTrustOptions for the same choices.
import { dirname } from "node:path";

import { ProjectTrustStore, type ProjectTrustUpdate } from "@earendil-works/pi-coding-agent";
import type { SelectItem, SelectListTheme, Terminal } from "@earendil-works/pi-tui";

export interface ShouldAskProjectTrustOptions {
  /** stdin/stdout are TTYs and the Pi args select interactive mode (see src/interactive.ts). */
  interactive: boolean;
  dryRun: boolean;
  noProject: boolean;
  /** From --approve/--no-approve, or a trust choice already made earlier in this run. */
  trustOverride: boolean | undefined;
  /** The nearest ancestor with .mmp/mmp.json, or undefined when none was found. */
  projectRoot: string | undefined;
  /** ProjectTrustStore.get(projectRoot): null means no one has decided yet. */
  savedDecision: boolean | null;
}

/** Pure so the decision can be unit-tested without a terminal, a project, or a trust store. */
export function shouldAskProjectTrust(options: ShouldAskProjectTrustOptions): boolean {
  return options.interactive &&
    !options.dryRun &&
    !options.noProject &&
    options.trustOverride === undefined &&
    options.projectRoot !== undefined &&
    options.savedDecision === null;
}

export interface ProjectTrustChoice {
  label: string;
  trusted: boolean;
  updates: ProjectTrustUpdate[];
}

/**
 * Mirrors Pi's own trust prompt options (core/trust-manager.js getProjectTrustOptions), which MMP
 * cannot import directly: index.js only re-exports ProjectTrustStore and
 * hasTrustRequiringProjectResources from that module. Saved decisions still go through the same
 * exported ProjectTrustStore, so both stores stay compatible.
 */
export function projectTrustOptions(root: string): ProjectTrustChoice[] {
  const parent = dirname(root);
  const options: ProjectTrustChoice[] = [
    { label: "Trust", trusted: true, updates: [{ path: root, decision: true }] },
  ];
  if (parent !== root) {
    options.push({
      label: `Trust parent folder (${parent})`,
      trusted: true,
      updates: [
        { path: parent, decision: true },
        { path: root, decision: null },
      ],
    });
  }
  options.push({ label: "Trust (this run only)", trusted: true, updates: [] });
  options.push({ label: "Do not trust", trusted: false, updates: [{ path: root, decision: false }] });
  options.push({ label: "Do not trust (this run only)", trusted: false, updates: [] });
  return options;
}

/** No theme system for a one-shot prompt drawn before Pi's own theme is installed: basic highlight only. */
const highlight = (text: string): string => `\x1b[1m\x1b[36m${text}\x1b[0m`;
const plain = (text: string): string => text;
const SELECT_THEME: SelectListTheme = {
  selectedPrefix: plain,
  selectedText: highlight,
  description: plain,
  scrollInfo: plain,
  noMatch: plain,
};

export interface AskProjectTrustOptions {
  root: string;
  /** Injected by tests (see test/fixtures/tui-harness.mjs); defaults to the real terminal. */
  terminal?: Terminal;
}

/**
 * Draws a small select list on the main screen (not the alternate screen: nothing else is on
 * screen yet) and resolves once the user picks an option or cancels. Esc/Ctrl+C cancels: do not
 * trust this run, nothing saved. The terminal is fully restored before this returns, so piMain or
 * TUI v2 can start its own session right after.
 */
export async function askProjectTrust(options: AskProjectTrustOptions): Promise<ProjectTrustChoice> {
  const { piTui } = await import("./tui/pi-tui.js");
  const terminal = options.terminal ?? new piTui.ProcessTerminal();
  const tui = new piTui.TuiMainScreen(terminal);
  const choices = projectTrustOptions(options.root);
  const items: SelectItem[] = choices.map((choice) => ({ value: choice.label, label: choice.label }));
  const list = new piTui.SelectList(items, items.length, SELECT_THEME);

  const container = new piTui.Container();
  container.addChild(new piTui.Text("Trust project folder?", 0, 0));
  container.addChild(new piTui.Text(options.root, 0, 1));
  container.addChild(new piTui.Text(
    "This lets MMP read .mmp/mmp.json and load its rules, skills and extensions (extensions run code).",
    0,
    1,
  ));
  container.addChild(list);
  tui.addChild(container);

  return new Promise((resolve) => {
    const cancelled: ProjectTrustChoice = { label: "cancelled", trusted: false, updates: [] };
    const finish = (choice: ProjectTrustChoice): void => {
      void terminal.drainInput(1000).then(() => {
        tui.stop();
        resolve(choice);
      });
    };
    list.onSelect = (item) => finish(choices.find((choice) => choice.label === item.value) ?? cancelled);
    list.onCancel = () => finish(cancelled);
    tui.start();
    tui.setFocus(list);
    tui.requestRender();
  });
}

/** Persists the chosen updates (if any) to the same store MMP's `/trust` and classic Pi's `/trust` use. */
export function saveProjectTrustChoice(agentDir: string, choice: ProjectTrustChoice): void {
  if (choice.updates.length > 0) {
    new ProjectTrustStore(agentDir).setMany(choice.updates);
  }
}
