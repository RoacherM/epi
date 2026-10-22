/** A calendar day, `YYYY-MM-DD`. */
export type Day = string;
export interface PageDate {
    /** `YYYY-MM-DD`, or `YYYY` when only the year is known. */
    date: string;
    /** `time`: the source gave a moment; `day`: a date only; `year`: just the year. */
    precision: "time" | "day" | "year";
    from: string;
    /** The moment, when `precision` is `time` (ms since the epoch). */
    at?: number;
}
export interface DateRange {
    /** First day included. */
    after?: Day;
    /** First day excluded. */
    before?: Day;
}
export type Recency = "day" | "week" | "month" | "year";
/** The local calendar day of `ms`. */
export declare function localDay(ms: number): Day;
/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` as the day it starts on; undefined when it isn't one of those or
 * isn't a real date (`2026-02-30`). */
export declare function startDay(text: string): Day | undefined;
/** `day` moved by `days` (negative: earlier), as a calendar day. */
export declare function addDays(day: Day, days: number): Day;
/** The range a `recency` names, counted back from today: `week` is today and the 6 days before,
 * `month` the day after the same day a month ago. */
export declare function recencyRange(recency: Recency, now: number): DateRange;
/** A source's date normalized (§4.3). A UTC midnight is a date only, kept as that UTC day: the
 * sources give it for pages that only state a day, and converting it would move it to the day before
 * west of UTC. A real moment is converted to the local day. Unparseable: undefined. */
export declare function normalizeDate(raw: unknown, from: string): PageDate | undefined;
/** A date later than tomorrow is not believed (§4.3: "date looks wrong"). */
export declare function isImplausible(date: PageDate, now: number): boolean;
/** The date a merged result shows, given every source's (in source order): the most precise one, the
 * first source on a tie. `disagrees` lists the others more than a day away from it. */
export declare function pickDate(dates: readonly PageDate[]): {
    date: PageDate | undefined;
    disagrees: PageDate[];
};
/** Whether `date` is in `range`. A year-only date is in it if any day of that year is. */
export declare function inRange(date: PageDate, range: DateRange): boolean;
/** `3 days ago`, `4 months ago`, `today`; `in the future` for a date after today. */
export declare function ago(date: PageDate, now: number): string;
/** `2026-10-22 15:40 Asia/Shanghai`: today as the model is told it. */
export declare function describeNow(now: number): string;
/** A range as the call row and result header write it: `after 2026-09-15`, `before 2026-06-01`. */
export declare function describeRange(range: DateRange): string;
//# sourceMappingURL=dates.d.ts.map