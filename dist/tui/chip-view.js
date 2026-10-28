import { editInEditorSlot } from "./dialogs.js";
import { dropTrailingNewline } from "./paste-chips.js";
export function viewTextChip(host, editor, chip) {
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
async function editTextChip(host, editor, chip) {
    const edited = await editInEditorSlot(host, `Edit ${chip.label}`, chip.content);
    if (edited === undefined)
        return;
    if (!editor.replaceTextChip(chip, edited)) {
        host.notice(`${chip.label} is no longer in the prompt; the edit was not applied.`, "warning");
    }
    host.tui.requestRender();
}
//# sourceMappingURL=chip-view.js.map