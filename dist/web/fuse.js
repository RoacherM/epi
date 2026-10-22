// Merging what several sources found (docs/web-search-design.md §4.2): one entry per page, ranked by
// Reciprocal Rank Fusion over each source's own order (their scores are not comparable), each date
// normalized and rechecked against the requested range.
import { inRange, isImplausible, normalizeDate, pickDate } from "./dates.js";
// RRF's usual constant: a page ranked 1st by one source and 10th by another beats one ranked 2nd by
// only one, without the top ranks swamping the rest.
const RRF_K = 60;
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|mc_cid|mc_eid|ref|ref_src)$/i;
/** A URL reduced to what decides whether two results are the same page: no scheme, no `www.`, no
 * fragment, no tracking parameters, no trailing slash, lowercase host. Unparseable: as given. */
export function urlKey(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return url.trim();
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const params = [...parsed.searchParams.entries()].filter(([name]) => !TRACKING.test(name));
    const query = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;
    const path = parsed.pathname.replace(/\/+$/, "");
    const port = parsed.port === "" ? "" : `:${parsed.port}`;
    return `${host}${port}${path}${query}`;
}
function firstText(hits, pick) {
    for (const hit of hits) {
        const text = pick(hit)?.trim();
        if (text)
            return text;
    }
    return "";
}
/** Each page once, with the sources that found it and its RRF score. */
function collect(bySource) {
    const merged = new Map();
    for (const [source, hits] of bySource) {
        const seen = new Set();
        hits.forEach((hit, index) => {
            const key = urlKey(hit.url);
            // A source listing one page twice ranks it once, at its best place.
            if (seen.has(key))
                return;
            seen.add(key);
            const entry = merged.get(key) ?? { url: hit.url, sources: [], hits: [], score: 0 };
            entry.sources.push(source);
            entry.hits.push(hit);
            entry.score += 1 / (RRF_K + index + 1);
            merged.set(key, entry);
        });
    }
    return merged;
}
function toMerged(key, entry, now) {
    let dateLooksWrong = false;
    const dates = [];
    entry.hits.forEach((hit, index) => {
        const date = normalizeDate(hit.date, entry.sources[index]);
        if (date === undefined)
            return;
        if (isImplausible(date, now))
            dateLooksWrong = true;
        else
            dates.push(date);
    });
    const { date, disagrees } = pickDate(dates);
    return {
        url: entry.url,
        key,
        title: firstText(entry.hits, (hit) => hit.title) || entry.url,
        // §4.2-5: DeepSeek's summary is written for a model; otherwise the excerpts.
        text: firstText(entry.hits, (hit) => hit.summary) || firstText(entry.hits, (hit) => hit.snippet),
        sources: entry.sources,
        score: entry.score,
        date,
        disagrees,
        dateLooksWrong,
        authority: Math.max(-1, ...entry.hits.map((hit) => hit.authority ?? -1)),
    };
}
function dateKey(hit) {
    if (hit.date === undefined)
        return "";
    return hit.date.precision === "year" ? `${hit.date.date}-00-00` : hit.date.date;
}
function byRelevance(a, b) {
    return b.score - a.score || dateKey(b).localeCompare(dateKey(a)) || b.authority - a.authority;
}
/** Merges each source's ranked hits (`bySource`, in source order): dedupe by `urlKey`, RRF, the
 * date recheck, then the order. Within a date range a result of unknown date is kept, after the dated
 * ones (§8 #5). */
export function fuse(bySource, options) {
    const merged = [...collect(bySource)].map(([key, entry]) => toMerged(key, entry, options.now));
    const ranged = options.range.after !== undefined || options.range.before !== undefined;
    let outOfRange = 0;
    const kept = merged.filter((hit) => {
        if (!ranged || hit.date === undefined || inRange(hit.date, options.range))
            return true;
        outOfRange += 1;
        return false;
    });
    kept.sort((a, b) => {
        if ((ranged || options.sort === "newest") && (a.date === undefined) !== (b.date === undefined))
            return a.date === undefined ? 1 : -1;
        if (options.sort === "newest")
            return dateKey(b).localeCompare(dateKey(a)) || byRelevance(a, b);
        return byRelevance(a, b);
    });
    return { hits: kept, outOfRange };
}
//# sourceMappingURL=fuse.js.map