// Dates for web search (docs/web-search-design.md §4.3). Three times are kept apart: today (the local
// clock), a page's publication date (what a source says, or unknown), and how fresh fetched content
// is (Exa's maxAgeHours, which filters nothing by date). Every comparison is in local calendar days,
// so "after 2026-09-15" means the same thing to the user, the sources and the local recheck.

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

const PARTIAL = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** The local calendar day of `ms`. */
export function localDay(ms: number): Day {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` as the day it starts on; undefined when it isn't one of those or
 * isn't a real date (`2026-02-30`). */
export function startDay(text: string): Day | undefined {
  const match = PARTIAL.exec(text.trim());
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = match[2] === undefined ? 1 : Number(match[2]);
  const day = match[3] === undefined ? 1 : Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** `day` moved by `days` (negative: earlier), as a calendar day. */
export function addDays(day: Day, days: number): Day {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return localDay(new Date(year, month - 1, date + days).getTime());
}

/** The range a `recency` names, counted back from today: `week` is today and the 6 days before. */
export function recencyRange(recency: Recency, now: number): DateRange {
  const today = localDay(now);
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const after = recency === "day" ? today
    : recency === "week" ? addDays(today, -6)
    : recency === "month" ? localDay(new Date(year, month - 2, day + 1).getTime())
    : localDay(new Date(year - 1, month - 1, day + 1).getTime());
  return { after };
}

/** A source's date normalized (§4.3). A UTC midnight is a date only, kept as that UTC day: the
 * sources give it for pages that only state a day, and converting it would move it to the day before
 * west of UTC. A real moment is converted to the local day. Unparseable: undefined. */
export function normalizeDate(raw: unknown, from: string): PageDate | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const text = raw.trim();
  const partial = PARTIAL.exec(text);
  if (partial !== null) {
    if (partial[3] !== undefined && startDay(text) !== undefined) return { date: text, precision: "day", from };
    if (partial[2] === undefined) return { date: text, precision: "year", from };
    const day = startDay(text);
    return day === undefined ? undefined : { date: day, precision: "day", from };
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return undefined;
  const utc = new Date(ms);
  if (utc.getUTCHours() === 0 && utc.getUTCMinutes() === 0 && utc.getUTCSeconds() === 0 && utc.getUTCMilliseconds() === 0) {
    return { date: `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`, precision: "day", from };
  }
  return { date: localDay(ms), precision: "time", from, at: ms };
}

/** A date later than tomorrow is not believed (§4.3: "date looks wrong"). */
export function isImplausible(date: PageDate, now: number): boolean {
  const tomorrow = addDays(localDay(now), 1);
  const day = date.precision === "year" ? `${date.date}-01-01` : date.date;
  return day > tomorrow;
}

const PRECISION_RANK = { year: 0, day: 1, time: 2 } as const;

function dayNumber(day: string): number {
  const [year, month = 1, date = 1] = day.split("-").map(Number) as [number, number?, number?];
  return Date.UTC(year, month - 1, date) / 86_400_000;
}

/** The date a merged result shows, given every source's (in source order): the most precise one, the
 * first source on a tie. `disagrees` lists the others more than a day away from it. */
export function pickDate(dates: readonly PageDate[]): { date: PageDate | undefined; disagrees: PageDate[] } {
  let best: PageDate | undefined;
  for (const date of dates) {
    if (best === undefined || PRECISION_RANK[date.precision] > PRECISION_RANK[best.precision]) best = date;
  }
  if (best === undefined) return { date: undefined, disagrees: [] };
  const disagrees = dates.filter((date) => date !== best && Math.abs(dayNumber(date.date) - dayNumber(best.date)) > 1);
  return { date: best, disagrees };
}

/** Whether `date` is in `range`. A year-only date is in it if any day of that year is. */
export function inRange(date: PageDate, range: DateRange): boolean {
  const first = date.precision === "year" ? `${date.date}-01-01` : date.date;
  const last = date.precision === "year" ? `${date.date}-12-31` : date.date;
  if (range.after !== undefined && last < range.after) return false;
  if (range.before !== undefined && first >= range.before) return false;
  return true;
}

/** `3 days ago`, `4 months ago`, `today`; `in the future` for a date after today. */
export function ago(date: PageDate, now: number): string {
  const today = dayNumber(localDay(now));
  const then = dayNumber(date.precision === "year" ? `${date.date}-07-01` : date.date);
  const days = Math.round(today - then);
  if (days < 0) return "in the future";
  if (date.precision === "year") {
    const years = new Date(now).getFullYear() - Number(date.date);
    return years <= 0 ? "this year" : years === 1 ? "last year" : `${years} years ago`;
  }
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = Math.round(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/** `2026-10-22 15:40 Asia/Shanghai`: today as the model is told it. */
export function describeNow(now: number): string {
  const date = new Date(now);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local time";
  return `${localDay(now)} ${pad(date.getHours())}:${pad(date.getMinutes())} ${zone}`;
}

/** A range as the call row and result header write it: `after 2026-09-15`, `before 2026-06-01`. */
export function describeRange(range: DateRange): string {
  return [range.after === undefined ? "" : `after ${range.after}`, range.before === undefined ? "" : `before ${range.before}`].filter((part) => part !== "").join(" · ");
}
