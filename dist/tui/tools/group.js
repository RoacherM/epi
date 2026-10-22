import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { breathe, motionTime } from "../motion.js";
import { piTui } from "../pi-tui.js";
import { dispatchToRows } from "../rows.js";
import { isClockGated, paintSpine, spineMember, TIP_ROWS } from "../spine.js";
import { durationBar, fitCallRow } from "./common.js";
import { createFlashState, disposeFlash, isFlashing, startFlash } from "./flash.js";
const GROUP_KINDS = new Set(["read", "grep", "find", "ls"]);
/** Only a built-in read/grep/find/ls tool groups; an extension overriding one of these names (or any
 * other extension tool) never does (docs/tui-design.md 4.2: "Only built-in read-only tools group"). */
export function asGroupKind(toolName, isBuiltIn) {
    return isBuiltIn && GROUP_KINDS.has(toolName) ? toolName : undefined;
}
/** grok observed verb ("Read"); noun counts calls, not results, matching the observed
 * `Read 2 files, Searched 1 pattern, Listed 1 dir` (docs/tui-design.md 4.2, grok notes 4.4). Neither
 * source gives `find` a verb. "Found N files" was tried first and rejected on review: it reads as a
 * *result* count ("N files were found") when it's actually a *call* count (find was invoked N times,
 * each returning anywhere from 0 to many files) -- the same trap `grep`'s "matches" wording avoids by
 * counting patterns, not hits. `find`'s call-scoping argument is its `path`, so it reuses grep's
 * "Searched" verb (both tools search something) with its own noun, "path(s)", which names what was
 * searched rather than implying what was found. */
const VERBS = {
    read: { label: "Read", singular: "file", plural: "files" },
    grep: { label: "Searched", singular: "pattern", plural: "patterns" },
    find: { label: "Searched", singular: "path", plural: "paths" },
    ls: { label: "Listed", singular: "dir", plural: "dirs" },
};
// Group line layout matches tools/block.ts's CALL_PREFIX: a 1-column rail, 2 columns of padding,
// then a 2-character bullet ("◈ ") before the text.
const PREFIX = 3;
const MAX_UNFOLDED_MEMBERS = 10;
const RUN_LABEL = "Reading…";
/**
 * A tool call in a run. `Transcript.tool()` is the only place these get built, alongside the
 * `groupKind`/`status`/`expandedFlag` bookkeeping the render wrapper below reads back out --
 * `ToolExecutionComponent`'s own fields are private, so overriding its mutators is how a subclass
 * observes its own state. `flash` is public: `GroupedMessages` reads each member's own flash state
 * directly to decide whether (and in what color) the group's merged line should flash -- there is no
 * separate group-level flash timer (see `GroupedMessages.renderSummaryLine`).
 */
export class ToolEntry extends ToolExecutionComponent {
    hostUi;
    groupKind;
    spineRole = "tool";
    status = "running";
    expandedFlag = false;
    flash = createFlashState();
    /** The final result's run time, for the group row's bar. */
    durationMs;
    clockLive = true;
    // The rows last drawn while running, kept for frames when the clock may not move them.
    frozen;
    started = false;
    constructor(toolName, toolCallId, args, renderers, hostUi, cwd, groupKind, options) {
        super(toolName, toolCallId, args, options, renderers, hostUi, cwd);
        this.hostUi = hostUi;
        this.groupKind = groupKind;
    }
    markExecutionStarted() {
        this.started = true;
        this.frozen = undefined;
        super.markExecutionStarted();
    }
    /** Running and outside the transcript's tip: the rows as last drawn, so the duration bar holds
     * still (spine.ts ClockGated); anything that happened since (output, the result) already cleared them. */
    render(width) {
        if (this.status === "running" && !this.clockLive && this.frozen?.width === width)
            return this.frozen.lines;
        const lines = super.render(width);
        this.frozen = this.status === "running" ? { width, lines } : undefined;
        return lines;
    }
    invalidate() {
        this.frozen = undefined;
        super.invalidate();
    }
    updateResult(result, isPartial = false) {
        super.updateResult(result, isPartial);
        this.frozen = undefined;
        if (!isPartial)
            this.durationMs = result.durationMs;
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
        this.frozen = undefined;
        super.setExpanded(expanded);
    }
    /** The completion flash lights the whole block's stretch of the turn spine (src/tui/spine.ts). */
    spineFlash() {
        return isFlashing(this.flash) ? this.flash : undefined;
    }
    get spineRunning() {
        return this.status === "running";
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
    // grep and find share "Searched"; keep them together and name the verb once:
    // "Searched 1 pattern, 2 paths", in the order each verb first appeared.
    const firstLabelIndex = (kind) => order.findIndex((other) => VERBS[other].label === VERBS[kind].label);
    let previousLabel;
    const breakdown = [...order]
        .sort((a, b) => firstLabelIndex(a) - firstLabelIndex(b))
        .map((kind) => {
        const count = counts.get(kind) ?? 0;
        const verb = VERBS[kind];
        const noun = `${count} ${count === 1 ? verb.singular : verb.plural}`;
        const clause = verb.label === previousLabel ? noun : `${verb.label} ${noun}`;
        previousLabel = verb.label;
        return clause;
    })
        .join(", ");
    return { running, completed, failed, breakdown };
}
/** Pure text+layout for the collapsed group line, split out from `GroupedMessages` so widths
 * 40/80/120 can be checked without a real `Transcript`/`ToolEntry`. While a member runs, the `◈`
 * breathes (docs/tui-motion-design.md M5), read at `t` seconds; the turn spine beside it pulses. */
export function verbGroupLine(members, theme, width, t = motionTime()) {
    const { running, failed, completed, breakdown } = summarize(members);
    const anyRunning = running > 0;
    const anyFailed = failed > 0;
    let text = anyRunning ? `${RUN_LABEL} · ${completed} completed` : breakdown;
    if (anyFailed)
        text += ` ${theme.fg("error", `· ${failed} failed`)}`;
    const lead = " ".repeat(PREFIX);
    const bullet = anyRunning
        ? breathe(theme, "accent", "thinkingHigh", t, "◈ ")
        : theme.fg(anyFailed ? "error" : "muted", "◈ ");
    const contentWidth = Math.max(1, width - PREFIX - 2);
    // The group's bar is the sum of its members' times, in the same column as single calls
    // (docs/tui-one-column-design.md §2.2); none while one runs or when a time is missing.
    const times = members.map((member) => member.durationMs);
    const total = !anyRunning && times.every((ms) => ms !== undefined) ? times.reduce((sum, ms) => sum + ms, 0) : undefined;
    const bar = total === undefined ? "" : durationBar(theme, total);
    return lead + bullet + fitCallRow({ body: text, tail: "", bar }, contentWidth, "…");
}
/** A muted `◈ ...` line laid out with the same 3-column lead as every other line (rail + padding),
 * for the "N more" and "fold" affordances, which have no rail of their own to draw. */
function leadLine(theme, text) {
    return " ".repeat(PREFIX) + theme.fg("muted", text);
}
function isGroupable(component) {
    return component instanceof ToolEntry && component.groupKind !== undefined;
}
const noop = () => { };
/** A row with nothing to draw itself (its text is pushed to `out` directly by the caller) but that
 * runs `onClick` on a left click -- used for the group line, "N more" and "fold" affordances. */
function clickTarget(onClick) {
    return {
        render: () => [],
        invalidate: noop,
        handleMouse: (event) => {
            if (event.type !== "click" || event.button !== "left")
                return undefined;
            onClick();
            return { handled: true };
        },
    };
}
/**
 * Wraps `Transcript`'s `messages` container: folds consecutive collapsed built-in read-only tool
 * blocks into one line at render time. Swapped in for `this.messages` as `root`'s child; `add()`
 * keeps mutating the real container exactly as before. This class reads `messages.children`
 * directly and never calls `messages.render()`/`messages.handleMouse()` -- so `messages`'s own
 * (inherited) `mouseLayout` cache is never populated and must never be relied on by anything else.
 *
 * "Unfolded" (this class's own per-run state, below) is a different axis from "expanded" (each
 * `ToolEntry`'s own `expandedFlag`, i.e. Pi's normal show-full-output toggle): clicking a folded
 * group line only unfolds it into its individual (still content-collapsed) blocks, it never expands
 * any member's output -- clicking `◈ Read 10 files` must show ten one-line blocks, not print all ten
 * files' contents. `Ctrl+O` (`setToolsExpanded`) is authoritative over folding: it always clears
 * `unfolded`/`revealed`, so the very next render folds every settled run again regardless of any
 * member's `expandedFlag` or any run's prior unfold/reveal state.
 */
export class GroupedMessages {
    messages;
    tui;
    theme;
    turnRunning;
    mouseLayout;
    toolsExpanded = false;
    // Both keyed by a run's first member: stable across renders because runs only grow at the tail
    // (children are never reordered or inserted before an existing one), so the same object always
    // identifies "this run" for as long as it exists.
    unfolded = new Set();
    revealed = new Set();
    // Last frame's blocks, and those with a row in the transcript's last TIP_ROWS rows: a clock-driven
    // block may move only there (spine.ts ClockGated). A block not drawn last frame counts as live.
    drawn = new Set();
    inTip = new Set();
    constructor(messages, tui, theme, 
    /** A turn is in progress: its spine is live (src/tui/spine.ts). */
    turnRunning = () => false) {
        this.messages = messages;
        this.tui = tui;
        this.theme = theme;
        this.turnRunning = turnRunning;
    }
    invalidate() {
        this.messages.invalidate();
    }
    /** `Ctrl+O`: always wins over any per-group unfold/reveal state left over from clicks. */
    setToolsExpanded(expanded) {
        this.toolsExpanded = expanded;
        this.unfolded.clear();
        this.revealed.clear();
    }
    /** Cleared on `Transcript.reset()`: old runs' first members no longer resolve to anything on screen. */
    dispose() {
        this.unfolded.clear();
        this.revealed.clear();
        this.drawn.clear();
        this.inTip.clear();
    }
    render(width) {
        const placed = [];
        const children = this.messages.children;
        for (const child of children) {
            if (isClockGated(child))
                child.clockLive = !this.drawn.has(child) || this.inTip.has(child);
        }
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
                    const anchor = members[0];
                    if (!this.toolsExpanded && !this.unfolded.has(anchor)) {
                        placed.push(this.summaryLine(anchor, members, width));
                    }
                    else {
                        this.renderUnfolded(anchor, members, width, placed);
                    }
                    i = lastIndex + 1;
                    continue;
                }
            }
            const rendered = first.render(width);
            if (rendered.length > 0)
                placed.push(place(first, rendered));
            i += 1;
        }
        joinToolRuns(placed);
        paintSpine(this.theme, placed, width, this.turnRunning());
        this.noteTip(placed);
        this.mouseLayout = { width, rows: placed.map(({ component, lines, skipped }) => ({ component, height: lines.length, skipped })) };
        return placed.flatMap((block) => block.lines);
    }
    /** Which blocks this frame drew, and which of them reach into the last TIP_ROWS rows. */
    noteTip(placed) {
        const total = placed.reduce((rows, block) => rows + block.lines.length, 0);
        this.drawn = new Set();
        this.inTip = new Set();
        let end = 0;
        for (const block of placed) {
            end += block.lines.length;
            this.drawn.add(block.component);
            if (end > total - TIP_ROWS)
                this.inTip.add(block.component);
        }
    }
    handleMouse(event) {
        if (event.y < 0 || event.y >= event.height)
            return undefined;
        if (this.mouseLayout?.width !== event.width)
            this.render(event.width);
        return dispatchToRows(this.mouseLayout.rows, event);
    }
    /**
     * Individual blocks again. Under `Ctrl+O` every member shows, uncapped (the user asked to see
     * everything). Unfolded by a click instead, only the most recent `MAX_UNFOLDED_MEMBERS` show by
     * default -- the newest, most likely still-running calls, not the oldest -- behind a clickable
     * "N more" that reveals the rest; a "fold" line folds this one run back (Ctrl+O stays the only way
     * to fold *and* unfold everything at once).
     */
    renderUnfolded(anchor, members, width, placed) {
        const capped = !this.toolsExpanded && !this.revealed.has(anchor) && members.length > MAX_UNFOLDED_MEMBERS;
        const visible = capped ? members.slice(-MAX_UNFOLDED_MEMBERS) : members;
        if (capped) {
            const hidden = members.length - visible.length;
            const reveal = clickTarget(() => { this.revealed.add(anchor); this.tui.requestRender(); });
            placed.push({ component: reveal, lines: [leadLine(this.theme, `◈ ${hidden} more`)], skipped: 0, member: TRUNK, toolish: true });
        }
        for (const member of visible)
            placed.push(place(member, member.render(width)));
        if (!this.toolsExpanded) {
            const fold = clickTarget(() => {
                this.unfolded.delete(anchor);
                this.revealed.delete(anchor);
                this.tui.requestRender();
            });
            placed.push({ component: fold, lines: [leadLine(this.theme, "◈ fold")], skipped: 0, member: TRUNK, toolish: true });
        }
    }
    /**
     * The merged line has no group-level flash timer of its own: once every member has settled, its
     * spine branch flashes in whichever tone a still-flashing member is showing (error wins over
     * success), which is exactly the 400ms window each member already tracks on its own
     * `ToolEntry.flash` (and fades the same way, read from that member's own state). This needs no
     * "did a render happen between running and settled" observation -- pi-tui's own render throttle
     * can (and in the real app, does) coalesce a fast run's frames so no such render ever happens,
     * which a wall-clock read of `isFlashing()` doesn't care about.
     */
    summaryLine(anchor, members, width) {
        const running = members.some((member) => member.status === "running");
        const flash = () => {
            if (running)
                return undefined;
            const flashing = members.filter((member) => isFlashing(member.flash));
            return (flashing.find((member) => member.flash.tone === "error") ?? flashing[0])?.flash;
        };
        const unfold = clickTarget(() => { this.unfolded.add(anchor); this.tui.requestRender(); });
        return {
            component: unfold,
            lines: ["", verbGroupLine(members, this.theme, width)],
            skipped: 0,
            member: { spineRole: "tool", spineRunning: running, spineFlash: flash },
            toolish: true,
        };
    }
}
const TRUNK = { spineRole: "trunk" };
function place(component, lines) {
    const member = component instanceof piTui.Spacer ? "spacer" : spineMember(component);
    return { component, lines: [...lines], skipped: 0, member, toolish: component instanceof ToolEntry };
}
/**
 * Consecutive tool rows sit together with no blank row between them (docs/tui-transcript-layout-
 * design.md R4). That blank row is the one Pi's ToolExecutionComponent puts first in its own render
 * (and the group line copies): it is left out here, and a click on the block is handed on one row
 * lower, where Pi's own handleMouse expects it (pi-internals row `tool-exec-leading-blank`).
 */
function joinToolRuns(placed) {
    let previousToolish = false;
    for (const block of placed) {
        if (block.toolish && previousToolish && block.lines[0] === "") {
            block.lines.shift();
            block.skipped = 1;
        }
        if (block.lines.length > 0)
            previousToolish = block.toolish;
    }
}
//# sourceMappingURL=group.js.map