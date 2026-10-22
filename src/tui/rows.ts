// Stacking components and routing a click to the one under it, for the containers that need each
// child's row range (GroupedMessages, AssistantBlock): pi-tui's Container keeps that layout private.
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

/** A child's rows in its parent's render. `skipped` leading rows of the child's own render were
 * dropped from the parent's (W2's trimmed blank row): a click is handed on that many rows lower. */
export interface ChildRows {
  component: Component;
  height: number;
  skipped?: number;
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

/** Hands `event` to the child whose rows contain it, in that child's own row coordinates. */
export function dispatchToRows(rows: readonly ChildRows[], event: TuiMouseEvent): TuiMouseEventResult | undefined {
  if (event.y < 0 || event.y >= event.height) return undefined;
  let y = 0;
  for (const { component, height, skipped = 0 } of rows) {
    if (event.y >= y && event.y < y + height) {
      return dispatchToChild(component, { ...event, y: event.y - y + skipped, height: height + skipped });
    }
    y += height;
  }
  return undefined;
}
