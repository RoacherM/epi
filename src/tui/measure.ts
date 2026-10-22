// The turn's width. 0.1.23 ended reply text, tool rows, failure rows and the user message at a 76-column
// reading measure (docs/tui-one-column-design.md §2.1); from 0.1.24 everything uses the terminal's
// full width (user, 2026-10-22: "都应该支持终端全宽吧"), so the call rows' duration bars line up on
// the terminal's right edge with tables, code, the status row and the prompt.

/** Columns of body text per row: no limit, the terminal's width. */
export const DEFAULT_MEASURE = Number.POSITIVE_INFINITY;
/** The content column: body text and code start here, under a tool's call text (R3). */
export const CONTENT_COLUMN = 5;
/** The column's right edge, counted from the transcript's left edge: no limit either. */
export const TURN_COLUMNS = Number.POSITIVE_INFINITY;
