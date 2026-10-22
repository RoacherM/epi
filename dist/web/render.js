import { CallLine, createOrUpdateLines, failureRow, setCallSummary, textContent } from "../tui/tools/common.js";
import { describeRange } from "./dates.js";
function shortUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}`;
    }
    catch {
        return url;
    }
}
function monthOf(date) {
    return date.slice(0, 7);
}
function failedSources(theme, runs) {
    return runs.filter((run) => run.error !== undefined).map((run) => theme.fg("error", `${run.id} ✗`));
}
/** The call row's tail for a finished search: `after 2026-09-15 · 8 results · 2 out of range · exa ✗`. */
function searchSummary(theme, details) {
    const parts = [];
    const range = describeRange(details.range);
    if (range !== "")
        parts.push(range);
    parts.push(`${details.hits.length} result${details.hits.length === 1 ? "" : "s"}`);
    if (details.outOfRange > 0)
        parts.push(`${details.outOfRange} out of range`);
    if (range === "" && details.span !== undefined) {
        const [first, last] = details.span;
        parts.push(monthOf(first) === monthOf(last) ? monthOf(first) : `${monthOf(first)} → ${monthOf(last)}`);
    }
    return [...parts.map((part) => theme.fg("dim", part)), ...failedSources(theme, details.runs)].join(theme.fg("dim", " · "));
}
function searchRows(theme, details) {
    const rows = details.hits.map((hit) => {
        const date = hit.date === undefined
            ? theme.fg("dim", hit.dateLooksWrong ? "date unknown (looks wrong)" : "date unknown")
            : `${theme.fg("muted", hit.date)} ${theme.fg("dim", hit.ago ?? "")}`;
        return `${date}  ${theme.fg("toolOutput", hit.title)} ${theme.fg("dim", `${shortUrl(hit.url)} [${hit.sources.join(", ")}]`)}`;
    });
    const runs = details.runs.map((run) => (run.error === undefined ? `${run.id} ${run.hits} in ${run.ms}ms` : `${run.id} failed: ${run.error}`));
    const tail = [details.today, ...runs, ...(details.outOfRange > 0 ? [`${details.outOfRange} outside the date range`] : [])];
    rows.push(theme.fg("dim", tail.join(" · ")));
    return rows;
}
function quote(text) {
    return `"${text.replace(/\s+/g, " ").trim()}"`;
}
const searchRenderers = {
    renderCall(args, theme, context) {
        const sources = Array.isArray(args.sources) && args.sources.length > 0 ? ` ${theme.fg("dim", `(${args.sources.join(", ")})`)}` : "";
        return new CallLine("◆", theme, `${theme.fg("toolOutput", "search")} ${theme.fg("toolOutput", quote(args.query ?? ""))}${sources}`, context);
    },
    renderResult(result, options, theme, context) {
        const details = result.details;
        if (context.isError || details?.kind !== "search") {
            setCallSummary(context, undefined);
            const first = textContent(result).split("\n").find((line) => line.trim() !== "") ?? "failed";
            return createOrUpdateLines(context, context.isError ? [failureRow(theme, first)] : [], undefined, [0]);
        }
        setCallSummary(context, searchSummary(theme, details));
        return createOrUpdateLines(context, options.expanded ? searchRows(theme, details) : []);
    },
};
const fetchRenderers = {
    renderCall(args, theme, context) {
        return new CallLine("◆", theme, `${theme.fg("toolOutput", "fetch")} ${theme.fg("toolOutput", shortUrl(args.url ?? ""))}`, context);
    },
    renderResult(result, options, theme, context) {
        const details = result.details;
        if (context.isError || details?.kind !== "fetch") {
            setCallSummary(context, undefined);
            const first = textContent(result).split("\n").find((line) => line.trim() !== "") ?? "failed";
            return createOrUpdateLines(context, context.isError ? [failureRow(theme, first)] : [], undefined, [0]);
        }
        const tried = details.runs.filter((run) => run.error !== undefined).map((run) => `${run.id} ✗`);
        const parts = [details.date ?? "date unknown", `${details.lines ?? 0} lines`, ...(details.runs.length > 1 ? [`via ${details.from}`] : [])];
        setCallSummary(context, [...parts.map((part) => theme.fg("dim", part)), ...tried.map((part) => theme.fg("error", part))].join(theme.fg("dim", " · ")));
        if (!options.expanded)
            return createOrUpdateLines(context, []);
        const rows = [
            `${theme.fg("toolOutput", details.title || details.url)}`,
            theme.fg("dim", [details.today, ...details.runs.map((run) => (run.error === undefined ? `${run.id} in ${run.ms}ms` : `${run.id} failed: ${run.error}`)), ...(details.dateFrom !== undefined && details.dateFrom !== details.from ? [`date from ${details.dateFrom}`] : [])].join(" · ")),
        ];
        return createOrUpdateLines(context, rows);
    },
};
export const webRenderers = { web_search: searchRenderers, web_fetch: fetchRenderers };
//# sourceMappingURL=render.js.map