// Read-only tool grouping (docs/tui-design.md 4.2 M4 "连续只读工具合并成一行", grok source notes
// research-grok-build-tui.md 4.4 "动词分组"): consecutive collapsed read/grep/find/ls tool blocks
// render as one line, e.g. `◈ Read 3 files`. Grouping is derived at render time from the order and
// state of `Transcript`'s existing `messages` container -- nothing is tracked incrementally, so a
// history replay (reset()) produces identical groups without any special-cased replay logic, and an
// assistant message that streamed no visible text/thinking (the common "one tool call per turn"
// shape) stays transparent to a run instead of splitting it (an empty message renders zero lines).
import type { Theme, ToolExecutionOptions } from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

import { piTui } from "../pi-tui.js";
import type { ToolRenderers } from "./types.js";
import { createFlashState, disposeFlash, type FlashState, isFlashing, paintRailTone, startFlash } from "./flash.js";

export type GroupKind = "read" | "grep" | "find" | "ls";

const GROUP_KINDS = new Set<GroupKind>(["read", "grep", "find", "ls"]);

/** Only a built-in read/grep/find/ls tool groups; an extension overriding one of these names (or any
 * other extension tool) never does (docs/tui-design.md 4.2: "Only built-in read-only tools group"). */
export function asGroupKind(toolName: string, isBuiltIn: boolean): GroupKind | undefined {
  return isBuiltIn && GROUP_KINDS.has(toolName as GroupKind) ? (toolName as GroupKind) : undefined;
}

/** grok observed verb ("Read"); noun counts calls, not results, matching the observed
 * `Read 2 files, Searched 1 pattern, Listed 1 dir` (docs/tui-design.md 4.2, grok notes 4.4). Neither
 * source gives `find` a verb. "Found N files" was tried first and rejected on review: it reads as a
 * *result* count ("N files were found") when it's actually a *call* count (find was invoked N times,
 * each returning anywhere from 0 to many files) -- the same trap `grep`'s "matches" wording avoids by
 * counting patterns, not hits. `find`'s call-scoping argument is its `path`, so it reuses grep's
 * "Searched" verb (both tools search something) with its own noun, "path(s)", which names what was
 * searched rather than implying what was found. */
const VERBS: Record<GroupKind, { label: string; singular: string; plural: string }> = {
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

type Status = "running" | "done" | "error";

/**
 * A tool call in a run. `Transcript.tool()` is the only place these get built, alongside the
 * `groupKind`/`status`/`expandedFlag` bookkeeping the render wrapper below reads back out --
 * `ToolExecutionComponent`'s own fields are private, so overriding its mutators is how a subclass
 * observes its own state. `flash` is public: `GroupedMessages` reads each member's own flash state
 * directly to decide whether (and in what color) the group's merged line should flash -- there is no
 * separate group-level flash timer (see `GroupedMessages.renderSummaryLine`).
 */
export class ToolEntry extends ToolExecutionComponent {
  status: Status = "running";
  expandedFlag = false;
  readonly flash: FlashState = createFlashState();
  private started = false;

  constructor(
    toolName: string,
    toolCallId: string,
    args: unknown,
    renderers: ToolRenderers | undefined,
    private readonly hostUi: TUI,
    cwd: string,
    private readonly theme: Theme,
    readonly groupKind: GroupKind | undefined,
    options?: ToolExecutionOptions,
  ) {
    super(toolName, toolCallId, args, options, renderers as never, hostUi, cwd);
  }

  override markExecutionStarted(): void {
    this.started = true;
    super.markExecutionStarted();
  }

  override updateResult(
    result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError: boolean },
    isPartial = false,
  ): void {
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

  override setExpanded(expanded: boolean): void {
    this.expandedFlag = expanded;
    super.setExpanded(expanded);
  }

  override render(width: number): string[] {
    return isFlashing(this.flash) ? paintRailTone(super.render(width), this.flash.tone, this.theme) : super.render(width);
  }

  /** Cleared on `Transcript.reset()` so a stale flash timer never fires after this entry is gone. */
  dispose(): void {
    disposeFlash(this.flash);
  }
}

interface MemberLike {
  groupKind: GroupKind | undefined;
  status: Status;
}

function summarize(members: MemberLike[]): { running: number; completed: number; failed: number; breakdown: string } {
  let running = 0;
  let completed = 0;
  let failed = 0;
  const order: GroupKind[] = [];
  const counts = new Map<GroupKind, number>();
  for (const member of members) {
    if (member.status === "running") running += 1;
    else if (member.status === "error") failed += 1;
    else completed += 1;
    if (member.groupKind !== undefined) {
      if (!counts.has(member.groupKind)) order.push(member.groupKind);
      counts.set(member.groupKind, (counts.get(member.groupKind) ?? 0) + 1);
    }
  }
  // grep and find share "Searched"; keep them together and name the verb once:
  // "Searched 1 pattern, 2 paths", in the order each verb first appeared.
  const firstLabelIndex = (kind: GroupKind) => order.findIndex((other) => VERBS[other].label === VERBS[kind].label);
  let previousLabel: string | undefined;
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
 * 40/80/120 can be checked without a real `Transcript`/`ToolEntry`. */
export function verbGroupLine(members: MemberLike[], theme: Theme, width: number): string {
  const { running, failed, completed, breakdown } = summarize(members);
  const anyRunning = running > 0;
  const anyFailed = failed > 0;
  let text = anyRunning ? `${RUN_LABEL} · ${completed} completed` : breakdown;
  if (anyFailed) text += ` ${theme.fg("error", `· ${failed} failed`)}`;
  const rail = anyRunning ? theme.fg("accent", "┃") : " ";
  const lead = `${rail}${" ".repeat(PREFIX - 1)}`;
  const bulletTone = anyRunning ? "accent" : anyFailed ? "error" : "muted";
  const bullet = theme.fg(bulletTone, "◈ ");
  const contentWidth = Math.max(1, width - PREFIX - 2);
  return lead + bullet + piTui.truncateToWidth(text, contentWidth);
}

/** A muted `◈ ...` line laid out with the same 3-column lead as every other line (rail + padding),
 * for the "N more" and "fold" affordances, which have no rail of their own to draw. */
function leadLine(theme: Theme, text: string): string {
  return " ".repeat(PREFIX) + theme.fg("muted", text);
}

/** Mirrors pi-tui's own (unexported) `dispatchMouseEvent`: normalizes a child's result so a nested
 * Container's own dispatch result (already carrying `target`) passes through unchanged. */
function dispatchToChild(component: Component, event: TuiMouseEvent): TuiMouseEventResult | undefined {
  const result = component.handleMouse?.(event);
  if (!result) return undefined;
  if ("target" in result) return result;
  if (!result.handled && !result.capture && !result.focus) return undefined;
  return {
    ...result,
    handled: true,
    ...(result.focus ? { focusTarget: component } : {}),
    target: { component, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height },
  } as TuiMouseEventResult;
}

function isGroupable(component: Component): component is ToolEntry {
  return component instanceof ToolEntry && component.groupKind !== undefined;
}

const noop = (): void => {};

/** A row with nothing to draw itself (its text is pushed to `out` directly by the caller) but that
 * runs `onClick` on a left click -- used for the group line, "N more" and "fold" affordances. */
function clickTarget(onClick: () => void): Component {
  return {
    render: () => [],
    invalidate: noop,
    handleMouse: (event: TuiMouseEvent) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
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
export class GroupedMessages implements Component {
  private mouseLayout: { width: number; rows: { component: Component; height: number }[] } | undefined;
  private toolsExpanded = false;
  // Both keyed by a run's first member: stable across renders because runs only grow at the tail
  // (children are never reordered or inserted before an existing one), so the same object always
  // identifies "this run" for as long as it exists.
  private readonly unfolded = new Set<ToolEntry>();
  private readonly revealed = new Set<ToolEntry>();

  constructor(
    private readonly messages: Container,
    private readonly tui: TUI,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {
    this.messages.invalidate();
  }

  /** `Ctrl+O`: always wins over any per-group unfold/reveal state left over from clicks. */
  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    this.unfolded.clear();
    this.revealed.clear();
  }

  /** Cleared on `Transcript.reset()`: old runs' first members no longer resolve to anything on screen. */
  dispose(): void {
    this.unfolded.clear();
    this.revealed.clear();
  }

  render(width: number): string[] {
    const out: string[] = [];
    const rows: { component: Component; height: number }[] = [];
    const children = this.messages.children;
    let i = 0;
    while (i < children.length) {
      const first = children[i]!; // guarded by the `while` bound above
      if (isGroupable(first)) {
        const members: ToolEntry[] = [first];
        let lastIndex = i;
        let j = i + 1;
        // Bridge children that render zero lines (an assistant turn with only tool calls, no
        // visible text/thinking): the spec breaks a run on "other tool, text or thinking", not on
        // the (usually empty) assistant message every tool call is nested under.
        while (j < children.length) {
          const candidate = children[j]!; // guarded by the `while` bound above
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
          const anchor = members[0]!;
          if (!this.toolsExpanded && !this.unfolded.has(anchor)) {
            const lines = this.renderSummaryLine(members, width);
            out.push(...lines);
            rows.push({ component: clickTarget(() => { this.unfolded.add(anchor); this.tui.requestRender(); }), height: lines.length });
          } else {
            this.renderUnfolded(anchor, members, width, out, rows);
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

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y < 0 || event.y >= event.height) return undefined;
    if (this.mouseLayout?.width !== event.width) this.render(event.width);
    let y = 0;
    for (const { component, height } of this.mouseLayout!.rows) {
      if (event.y >= y && event.y < y + height) {
        return dispatchToChild(component, { ...event, y: event.y - y, height });
      }
      y += height;
    }
    return undefined;
  }

  /**
   * Individual blocks again. Under `Ctrl+O` every member shows, uncapped (the user asked to see
   * everything). Unfolded by a click instead, only the most recent `MAX_UNFOLDED_MEMBERS` show by
   * default -- the newest, most likely still-running calls, not the oldest -- behind a clickable
   * "N more" that reveals the rest; a "fold" line folds this one run back (Ctrl+O stays the only way
   * to fold *and* unfold everything at once).
   */
  private renderUnfolded(
    anchor: ToolEntry,
    members: ToolEntry[],
    width: number,
    out: string[],
    rows: { component: Component; height: number }[],
  ): void {
    const capped = !this.toolsExpanded && !this.revealed.has(anchor) && members.length > MAX_UNFOLDED_MEMBERS;
    const visible = capped ? members.slice(-MAX_UNFOLDED_MEMBERS) : members;
    if (capped) {
      const hidden = members.length - visible.length;
      const moreLine = leadLine(this.theme, `◈ ${hidden} more`);
      out.push(moreLine);
      rows.push({ component: clickTarget(() => { this.revealed.add(anchor); this.tui.requestRender(); }), height: 1 });
    }
    for (const member of visible) {
      const rendered = member.render(width);
      out.push(...rendered);
      rows.push({ component: member, height: rendered.length });
    }
    if (!this.toolsExpanded) {
      const foldLine = leadLine(this.theme, "◈ fold");
      out.push(foldLine);
      rows.push({
        component: clickTarget(() => {
          this.unfolded.delete(anchor);
          this.revealed.delete(anchor);
          this.tui.requestRender();
        }),
        height: 1,
      });
    }
  }

  /**
   * The merged line has no group-level flash timer of its own: once every member has settled, it
   * paints its rail in whichever tone a still-flashing member is showing (error wins over success),
   * which is exactly the 400ms window each member already tracks on its own `ToolEntry.flash`. This
   * needs no "did a render happen between running and settled" observation -- pi-tui's own render
   * throttle can (and in the real app, does) coalesce a fast run's frames so no such render ever
   * happens, which a wall-clock read of `isFlashing()` doesn't care about.
   */
  private renderSummaryLine(members: ToolEntry[], width: number): string[] {
    const line = verbGroupLine(members, this.theme, width);
    if (members.some((member) => member.status === "running")) return ["", line];
    const flashing = members.filter((member) => isFlashing(member.flash));
    if (flashing.length === 0) return ["", line];
    const tone = flashing.some((member) => member.flash.tone === "error") ? "error" : "success";
    return ["", ...paintRailTone([line], tone, this.theme)];
  }
}
