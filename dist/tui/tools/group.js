import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { piTui } from "../pi-tui.js";
import { createFlashState, disposeFlash, paintFlashRail, startFlash } from "./flash.js";
const GROUP_KINDS = new Set(["read", "grep", "find", "ls"]);
/** Only a built-in read/grep/find/ls tool groups; an extension overriding one of these names (or any
 * other extension tool) never does (docs/tui-design.md 4.2: "Only built-in read-only tools group"). */
export function asGroupKind(toolName, isBuiltIn) {
    return isBuiltIn && GROUP_KINDS.has(toolName) ? toolName : undefined;
}
/** grok observed verb ("Read"); noun counts calls, not results, matching the observed
 * `Read 2 files, Searched 1 pattern, Listed 1 dir` (docs/tui-design.md 4.2, grok notes 4.4). `find`
 * has no verb in either source, so it gets its own ("Found") rather than reusing grep's "Searched",
 * since a find call searches file names, not file contents. */
const VERBS = {
    read: { label: "Read", singular: "file", plural: "files" },
    grep: { label: "Searched", singular: "pattern", plural: "patterns" },
    find: { label: "Found", singular: "file", plural: "files" },
    ls: { label: "Listed", singular: "dir", plural: "dirs" },
};
// Group line layout matches tools/block.ts's CALL_PREFIX: a 1-column rail, 2 columns of padding,
// then a 2-character bullet ("◈ ") before the text.
const PREFIX = 3;
const MAX_EXPANDED_MEMBERS = 10;
const RUN_LABEL = "Reading…";
/**
 * A tool call in a run. `Transcript.tool()` is the only place these get built, alongside the
 * `groupKind`/`status`/`expandedFlag` bookkeeping the render wrapper below reads back out --
 * `ToolExecutionComponent`'s own fields are private, so overriding its mutators is how a subclass
 * observes its own state.
 */
export class ToolEntry extends ToolExecutionComponent {
    hostUi;
    theme;
    groupKind;
    id;
    status = "running";
    expandedFlag = false;
    started = false;
    flash = createFlashState();
    constructor(toolName, toolCallId, args, renderers, hostUi, cwd, theme, groupKind, options) {
        super(toolName, toolCallId, args, options, renderers, hostUi, cwd);
        this.hostUi = hostUi;
        this.theme = theme;
        this.groupKind = groupKind;
        this.id = toolCallId;
    }
    markExecutionStarted() {
        this.started = true;
        super.markExecutionStarted();
    }
    updateResult(result, isPartial = false) {
        super.updateResult(result, isPartial);
        if (isPartial) {
            this.status = "running";
            return;
        }
        const wasRunning = this.status === "running";
        this.status = result.isError ? "error" : "done";
        // Gated on `started`: replay (addFinishedMessage -> syncToolCalls -> a "toolResult" message
        // attaching the already-known result) never called markExecutionStarted, so it never flashes.
        if (wasRunning && this.started) {
            startFlash(this.flash, this.status === "error" ? "error" : "success", () => this.hostUi.requestRender());
        }
    }
    setExpanded(expanded) {
        this.expandedFlag = expanded;
        super.setExpanded(expanded);
    }
    render(width) {
        return paintFlashRail(super.render(width), this.flash, this.theme);
    }
    /** Cleared on `Transcript.reset()` so a stale flash timer never fires after this entry is gone. */
    dispose() {
        disposeFlash(this.flash);
    }
}
function summarize(members) {
    let running = 0;
    let completed = 0;
    let failed = 0;
    const order = [];
    const counts = new Map();
    for (const member of members) {
        if (member.status === "running")
            running += 1;
        else if (member.status === "error")
            failed += 1;
        else
            completed += 1;
        if (member.groupKind !== undefined) {
            if (!counts.has(member.groupKind))
                order.push(member.groupKind);
            counts.set(member.groupKind, (counts.get(member.groupKind) ?? 0) + 1);
        }
    }
    const breakdown = order
        .map((kind) => {
        const count = counts.get(kind) ?? 0;
        const verb = VERBS[kind];
        return `${verb.label} ${count} ${count === 1 ? verb.singular : verb.plural}`;
    })
        .join(", ");
    return { running, completed, failed, breakdown };
}
/** Pure text+layout for the collapsed group line, split out from `GroupedMessages` so widths
 * 40/80/120 can be checked without a real `Transcript`/`ToolEntry`. */
export function verbGroupLine(members, theme, width) {
    const { running, failed, completed, breakdown } = summarize(members);
    const anyRunning = running > 0;
    const anyFailed = failed > 0;
    let text = anyRunning ? `${RUN_LABEL} · ${completed} completed` : breakdown;
    if (anyFailed)
        text += ` ${theme.fg("error", `· ${failed} failed`)}`;
    const rail = anyRunning ? theme.fg("accent", "┃") : " ";
    const lead = `${rail}${" ".repeat(PREFIX - 1)}`;
    const bulletTone = anyRunning ? "accent" : anyFailed ? "error" : "muted";
    const bullet = theme.fg(bulletTone, "◈ ");
    const contentWidth = Math.max(1, width - PREFIX - 2);
    return lead + bullet + piTui.truncateToWidth(text, contentWidth);
}
/** Mirrors pi-tui's own (unexported) `dispatchMouseEvent`: normalizes a child's result so a nested
 * Container's own dispatch result (already carrying `target`) passes through unchanged. */
function dispatchToChild(component, event) {
    const result = component.handleMouse?.(event);
    if (!result)
        return undefined;
    if ("target" in result)
        return result;
    if (!result.handled && !result.capture && !result.focus)
        return undefined;
    return {
        ...result,
        handled: true,
        ...(result.focus ? { focusTarget: component } : {}),
        target: { component, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height },
    };
}
function isGroupable(component) {
    return component instanceof ToolEntry && component.groupKind !== undefined;
}
const noop = () => { };
/**
 * Wraps `Transcript`'s `messages` container: folds consecutive collapsed built-in read-only tool
 * blocks into one line at render time. Swapped in for `this.messages` as `root`'s child; `add()`
 * keeps mutating the real container exactly as before. This class reads `messages.children`
 * directly and never calls `messages.render()`/`messages.handleMouse()` -- so `messages`'s own
 * (inherited) `mouseLayout` cache is never populated and must never be relied on by anything else.
 */
export class GroupedMessages {
    messages;
    tui;
    theme;
    mouseLayout;
    // Keyed by the run's first member's id, stable across renders because runs only grow at the
    // tail (children are never reordered or inserted before an existing one).
    runFlashes = new Map();
    constructor(messages, tui, theme) {
        this.messages = messages;
        this.tui = tui;
        this.theme = theme;
    }
    invalidate() {
        this.messages.invalidate();
    }
    /** Cleared on `Transcript.reset()`: old runs' keys no longer resolve to anything on screen. */
    dispose() {
        for (const { flash } of this.runFlashes.values())
            disposeFlash(flash);
        this.runFlashes.clear();
    }
    render(width) {
        const out = [];
        const rows = [];
        const children = this.messages.children;
        let i = 0;
        while (i < children.length) {
            const first = children[i]; // guarded by the `while` bound above
            if (isGroupable(first)) {
                const members = [first];
                let lastIndex = i;
                let j = i + 1;
                // Bridge children that render zero lines (an assistant turn with only tool calls, no
                // visible text/thinking): the spec breaks a run on "other tool, text or thinking", not on
                // the (usually empty) assistant message every tool call is nested under.
                while (j < children.length) {
                    const candidate = children[j]; // guarded by the `while` bound above
                    if (isGroupable(candidate)) {
                        members.push(candidate);
                        lastIndex = j;
                        j += 1;
                        continue;
                    }
                    if (candidate.render(width).length === 0) {
                        j += 1;
                        continue;
                    }
                    break;
                }
                if (members.length > 1) {
                    if (members.every((member) => !member.expandedFlag)) {
                        const lines = this.renderSummaryLine(members, width);
                        out.push(...lines);
                        rows.push({ component: this.runClickTarget(members), height: lines.length });
                    }
                    else {
                        // Ctrl+O (or a click on the group line) expanded these: individual blocks again,
                        // capped at 10 with a trailing "N more" (docs/tui-design.md 4.2: "组内超过 10 项时末尾
                        // ◈ N more"). Each shown member keeps its own row so a click still reaches it directly,
                        // instead of the whole run sharing one big click target.
                        const shown = members.slice(0, MAX_EXPANDED_MEMBERS);
                        for (const member of shown) {
                            const rendered = member.render(width);
                            out.push(...rendered);
                            rows.push({ component: member, height: rendered.length });
                        }
                        if (members.length > MAX_EXPANDED_MEMBERS) {
                            const moreLine = this.theme.fg("muted", `◈ ${members.length - MAX_EXPANDED_MEMBERS} more`);
                            out.push(moreLine);
                            rows.push({ component: { render: () => [moreLine], invalidate: noop }, height: 1 });
                        }
                    }
                    i = lastIndex + 1;
                    continue;
                }
            }
            const rendered = first.render(width);
            if (rendered.length > 0) {
                out.push(...rendered);
                rows.push({ component: first, height: rendered.length });
            }
            i += 1;
        }
        this.mouseLayout = { width, rows };
        return out;
    }
    handleMouse(event) {
        if (event.y < 0 || event.y >= event.height)
            return undefined;
        if (this.mouseLayout?.width !== event.width)
            this.render(event.width);
        let y = 0;
        for (const { component, height } of this.mouseLayout.rows) {
            if (event.y >= y && event.y < y + height) {
                return dispatchToChild(component, { ...event, y: event.y - y, height });
            }
            y += height;
        }
        return undefined;
    }
    /** Clicking the merged line expands every member, same as Ctrl+O would for just this run. */
    runClickTarget(members) {
        return {
            render: () => [],
            invalidate: noop,
            handleMouse: (event) => {
                if (event.type !== "click" || event.button !== "left")
                    return undefined;
                for (const member of members)
                    member.setExpanded(true);
                this.tui.requestRender();
                return { handled: true };
            },
        };
    }
    renderSummaryLine(members, width) {
        const anyRunning = members.some((member) => member.status === "running");
        const anyFailed = members.some((member) => member.status === "error");
        const key = members[0].id; // renderSummaryLine is only reached with members.length > 1
        let entry = this.runFlashes.get(key);
        if (entry === undefined) {
            entry = { flash: createFlashState(), wasRunning: anyRunning };
            this.runFlashes.set(key, entry);
        }
        if (entry.wasRunning && !anyRunning) {
            startFlash(entry.flash, anyFailed ? "error" : "success", () => this.tui.requestRender());
        }
        entry.wasRunning = anyRunning;
        const line = verbGroupLine(members, this.theme, width);
        return ["", ...paintFlashRail([line], entry.flash, this.theme)];
    }
}
//# sourceMappingURL=group.js.map