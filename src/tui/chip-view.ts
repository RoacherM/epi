// A text chip's full content (docs/tui-design.md 4.3): the inspector shows every line, and `e` edits
// it in a dialog that puts the result back in place of the chip, still folded when it is long.
import type { Component, TUI } from "@earendil-works/pi-tui";

import type { InspectTarget } from "./buffer/inspector.js";
import { editInEditorSlot } from "./dialogs.js";
import { type ChipEditor, type ChipInfo, dropTrailingNewline } from "./paste-chips.js";

export interface ChipViewHost {
  readonly tui: TUI;
  inspect(target: InspectTarget): void;
  takeEditorSlot(component: Component): () => void;
  notice(text: string, tone: "info" | "warning" | "error"): void;
}

type TextChip = Extract<ChipInfo, { kind: "text" }>;

export function viewTextChip(host: ChipViewHost, editor: ChipEditor, chip: TextChip): void {
  const lines = dropTrailingNewline(chip.content).split("\n");
  host.inspect({
    title: chip.label,
    subtitle: `${lines.length} ${lines.length === 1 ? "line" : "lines"} · ${chip.content.length} chars`,
    lines,
    firstLineNumber: 1,
    text: chip.content,
    wrap: true,
    edit: () => void editTextChip(host, editor, chip),
  });
}

async function editTextChip(host: ChipViewHost, editor: ChipEditor, chip: TextChip): Promise<void> {
  const edited = await editInEditorSlot(host, `Edit ${chip.label}`, chip.content);
  if (edited === undefined) return;
  if (!editor.replaceTextChip(chip, edited)) {
    host.notice(`${chip.label} is no longer in the prompt; the edit was not applied.`, "warning");
  }
  host.tui.requestRender();
}
