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
import { createFlashState, disposeFlash, type FlashState, paintFlashRail, startFlash } from "./flash.js";

export type GroupKind = "read" | "grep" | "find" | "ls";

const GROUP_KINDS = new Set<GroupKind>(["read", "grep", "find", "ls"]);

/** Only a built-in read/grep/find/ls tool groups; an extension overriding one of these names (or any
 * other extension tool) never does (docs/tui-design.md 4.2: "Only built-in read-only tools group"). */
export function asGroupKind(toolName: string, isBuiltIn: boolean): GroupKind | undefined {
  return isBuiltIn && GROUP_KINDS.has(toolName as GroupKind) ? (toolName as GroupKind) : undefined;
}

/** grok observed verb ("Read"); noun counts calls, not results, matching the observed
 * `Read 2 files, Searched 1 pattern, Listed 1 dir` (docs/tui-design.md 4.2, grok notes 4.4). `find`
 * has no verb in either source, so it gets its own ("Found") rather than reusing grep's "Searched",
 * since a find call searches file names, not file contents. */
const VERBS: Record<GroupKind, { label: string; singular: string; plural: string }> = {
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

type Status = "running" | "done" | "error";

/**
 * A tool call in a run. `Transcript.tool()` is the only place these get built, alongside the
 * `groupKind`/`status`/`expandedFlag` bookkeeping the render wrapper below reads back out --
 * `ToolExecutionComponent`'s own fields are private, so overriding its mutators is how a subclass
 * observes its own state.
 */
export class ToolEntry extends ToolExecutionComponent {
  readonly id: string;
  status: Status = "running";
  expandedFlag = false;
  private started = false;
  private readonly flash: FlashState = createFlashState();

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
    this.id = toolCallId;
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
    return paintFlashRail(super.render(width), this.flash, this.theme);
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

/**
 * Wraps `Transcript`'s `messages` container: folds consecutive collapsed built-in read-only tool
 * blocks into one line at render time. Swapped in for `this.messages` as `root`'s child; `add()`
 * keeps mutating the real container exactly as before. This class reads `messages.children`
 * directly and never calls `messages.render()`/`messages.handleMouse()` -- so `messages`'s own
 * (inherited) `mouseLayout` cache is never populated and must never be relied on by anything else.
 */
export class GroupedMessages implements Component {
  private mouseLayout: { width: number; rows: { component: Component; height: number }[] } | undefined;
  // Keyed by the run's first member's id, stable across renders because runs only grow at the
  // tail (children are never reordered or inserted before an existing one).
  private readonly runFlashes = new Map<string, { flash: FlashState; wasRunning: boolean }>();

  constructor(
    private readonly messages: Container,
    private readonly tui: TUI,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {
    this.messages.invalidate();
  }

  /** Cleared on `Transcript.reset()`: old runs' keys no longer resolve to anything on screen. */
  dispose(): void {
    for (const { flash } of this.runFlashes.values()) disposeFlash(flash);
    this.runFlashes.clear();
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
          if (members.every((member) => !member.expandedFlag)) {
            const lines = this.renderSummaryLine(members, width);
            out.push(...lines);
            rows.push({ component: this.runClickTarget(members), height: lines.length });
          } else {
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

  /** Clicking the merged line expands every member, same as Ctrl+O would for just this run. */
  private runClickTarget(members: ToolEntry[]): Component {
    return {
      render: () => [],
      invalidate: noop,
      handleMouse: (event: TuiMouseEvent) => {
        if (event.type !== "click" || event.button !== "left") return undefined;
        for (const member of members) member.setExpanded(true);
        this.tui.requestRender();
        return { handled: true };
      },
    };
  }

  private renderSummaryLine(members: ToolEntry[], width: number): string[] {
    const anyRunning = members.some((member) => member.status === "running");
    const anyFailed = members.some((member) => member.status === "error");
    const key = members[0]!.id; // renderSummaryLine is only reached with members.length > 1
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
