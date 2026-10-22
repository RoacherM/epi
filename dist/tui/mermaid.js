import { diagramKind, render } from "lovely-mermaid";
const ROLE_COLOR = {
    border: "muted",
    text: "text",
    edge: "mdCode",
    edgeLabel: "muted",
    title: "dim",
};
// A flowchart's direction, to lay it out the other way when it is too wide (mmd2txt does the same).
const DIRECTION = /^(\s*(?:graph|flowchart)\s+)(TD|TB|LR|RL|BT)\b/m;
const FLIPPED = { TD: "LR", TB: "LR", BT: "LR", LR: "TD", RL: "TD" };
// Rendering is a fraction of a millisecond, but a streaming reply rebuilds its text blocks on every
// delta and a resumed session draws every diagram again: keep the latest results.
const CACHE_LIMIT = 64;
const cache = new Map();
/** The diagram drawn into at most `width` columns, or why it isn't. Pure in `source` and `width`,
 * apart from the theme's colors. */
export function renderMermaid(theme, source, width) {
    const drawn = layOut(source, width);
    if ("error" in drawn)
        return { kind: "source", note: drawn.error };
    const { art, flipped } = drawn;
    if (art === null) {
        const kind = diagramKind(source);
        if (kind !== null)
            return { kind: "source", note: `${kind} did not parse: showing source` };
        const header = declaredType(source);
        return { kind: "source", note: header === undefined ? "empty diagram" : `${header} is not supported: showing source` };
    }
    if (art.width > width)
        return { kind: "source", note: `${art.width} columns, wider than ${width}: showing source` };
    const notes = [];
    if (flipped !== undefined)
        notes.push(`re-laid out ${flipped === "LR" ? "left-right" : "top-down"}`);
    if (art.warnings.length > 0)
        notes.push(`dropped ${art.warnings.length} ${art.warnings.length === 1 ? "statement" : "statements"}`);
    return { kind: "art", rows: art.styled.map((spans) => paint(theme, spans)), note: notes.length > 0 ? notes.join(" · ") : undefined };
}
/** The art for `source`, laid out the other way when that is what fits; cached by source and width. */
function layOut(source, width) {
    const key = `${width}\0${source}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
        // Most recently used last, so the oldest is the one dropped.
        cache.delete(key);
        cache.set(key, hit);
        return hit;
    }
    let result;
    try {
        const art = render(source);
        result = { art, flipped: undefined };
        if (art !== null && art.width > width) {
            const match = DIRECTION.exec(source);
            const to = match === null ? undefined : FLIPPED[match[2]];
            const other = to === undefined ? null : render(source.replace(DIRECTION, `$1${to}`));
            if (other !== null && other.width < art.width)
                result = { art: other, flipped: to };
        }
    }
    catch (error) {
        // Visible, not swallowed (docs/dev-workflow.md §5): the source shows, and the note says why.
        const message = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 80);
        result = { error: `could not be drawn (${message}): showing source` };
    }
    cache.set(key, result);
    if (cache.size > CACHE_LIMIT)
        cache.delete(cache.keys().next().value);
    return result;
}
/** The diagram type a source declares: the first word after any front matter and comments. */
function declaredType(source) {
    const lines = source.split("\n");
    let index = 0;
    if (lines[0]?.trim() === "---") {
        index = lines.findIndex((line, at) => at > 0 && line.trim() === "---") + 1;
        if (index === 0)
            return undefined;
    }
    for (; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (line === "" || line.startsWith("%%"))
            continue;
        return line.split(/\s/)[0];
    }
    return undefined;
}
/** One row of art in the theme's colors, without trailing filler. */
function paint(theme, spans) {
    let end = spans.length;
    while (end > 0 && spans[end - 1].role === "none")
        end -= 1;
    return spans.slice(0, end).map((span) => (span.role === "none" ? span.text : theme.fg(ROLE_COLOR[span.role], span.text))).join("");
}
//# sourceMappingURL=mermaid.js.map