/** Mirrors pi-tui's own (unexported) `dispatchMouseEvent`: normalizes a child's result so a nested
 * Container's own dispatch result (already carrying `target`) passes through unchanged. */
export function dispatchToChild(component, event) {
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
/** Hands `event` to the child whose rows contain it, in that child's own row coordinates. */
export function dispatchToRows(rows, event) {
    if (event.y < 0 || event.y >= event.height)
        return undefined;
    let y = 0;
    for (const { component, height, skipped = 0 } of rows) {
        if (event.y >= y && event.y < y + height) {
            return dispatchToChild(component, { ...event, y: event.y - y + skipped, height: height + skipped });
        }
        y += height;
    }
    return undefined;
}
//# sourceMappingURL=rows.js.map