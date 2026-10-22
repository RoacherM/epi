// The turn's one column (docs/tui-one-column-design.md §2.1): reply text, tool rows, failure rows and
// the user message all end at the same right edge, the reply's reading measure from the content
// column. Code blocks, tables and diagrams are data and keep the full width.

/** Columns of body text per row (Bringhurst's 45–75 characters; WCAG 1.4.8 asks for ≤ 80). */
export const DEFAULT_MEASURE = 76;
/** The content column: body text and code start here, under a tool's call text (R3). */
export const CONTENT_COLUMN = 5;
/** The column's right edge, counted from the transcript's left edge: content column plus measure. */
export const TURN_COLUMNS = CONTENT_COLUMN + DEFAULT_MEASURE;
