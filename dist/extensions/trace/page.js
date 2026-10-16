import { piTui } from "../../tui/pi-tui.js";
import { pad, scrollbar } from "../preview/draw.js";
import { Finder, LinePrompt } from "../preview/search.js";
import { contentLines, formatClock, formatDuration, formatOffset, safeJson, usageLines } from "./format.js";
import { foldTimeline } from "./fold.js";
import { projectTrace } from "./project.js";
const { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } = piTui;
const SECTIONS = ["Summary", "Payload", "Result", "Schema", "Timing"];
const KIND_GLYPH = { model: "◆", tool: "⚙", user: "»", event: "·", unknown: "?" };
/** A frame with the list and, at ≥120 columns, the inspector side by side. */
export class TracePage {
    options;
    focused = false;
    cursor = 0;
    listScroll = 0;
    detailOpen = false;
    focus = "list";
    section = 0;
    detailScroll = 0;
    follow = true;
    /** `waterfall`: bar positioned on the visible time axis; `duration`: bar length by duration. */
    finder = new Finder();
    prompt;
    message = "";
    cache;
    unsubscribe;
    /** Body geometry from the last render, for the mouse. */
    geometry;
    constructor(options) {
        this.options = options;
        this.unsubscribe = options.recorder.subscribe(() => options.tui.requestRender());
    }
    dispose() {
        this.unsubscribe();
    }
    /** Recompute the projection only when the branch actually changed. */
    summary() {
        // The leaf is the branch's change signal: every append advances it, as does a branch move. The
        // recorder generation covers the gap before an observation is persisted as an entry (a running
        // tool), and any other observation update (docs/trace-design.md §6.2).
        const signature = `${this.options.session.getLeafId() ?? "∅"}|${this.options.recorder.generation}`;
        if (this.cache?.signature === signature)
            return this.cache.summary;
        const summary = projectTrace(this.options.session.getBranch(), this.options.recorder);
        this.cache = { signature, summary };
        return summary;
    }
    currentStep(summary) {
        return summary.steps[this.cursor];
    }
    handleInput(data) {
        this.message = "";
        if (this.prompt) {
            const done = this.prompt.handleInput(data);
            if (done === "submit")
                this.submit(this.prompt);
            if (done !== undefined)
                this.prompt = undefined;
            this.options.tui.requestRender();
            return;
        }
        const summary = this.summary();
        if (data === "/") {
            this.prompt = new LinePrompt("/");
            this.options.tui.requestRender();
            return;
        }
        if (matchesKey(data, "escape")) {
            if (this.finder.query !== "")
                this.finder.query = "";
            else if (this.detailOpen)
                this.detailOpen = false;
            else
                this.close();
            this.options.tui.requestRender();
            return;
        }
        if (data === "q" && !this.detailOpen) {
            this.close();
            return;
        }
        if (data === "n" || data === "N") {
            this.findNext(data === "N", summary);
            this.options.tui.requestRender();
            return;
        }
        if (this.focus === "detail" && this.detailOpen)
            this.detailKeys(data, summary);
        else
            this.listKeys(data, summary);
        this.options.tui.requestRender();
    }
    close() {
        this.dispose();
        this.options.done(undefined);
    }
    moveCursor(delta, summary) {
        const count = summary.steps.length;
        if (count === 0)
            return;
        this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta));
        this.follow = this.cursor === count - 1;
        this.detailScroll = 0;
    }
    listKeys(data, summary) {
        const page = this.bodyHeight() - 1;
        if (data === "j" || matchesKey(data, "down"))
            this.moveCursor(1, summary);
        else if (data === "k" || matchesKey(data, "up"))
            this.moveCursor(-1, summary);
        else if (data === "g") {
            this.cursor = 0;
            this.follow = false;
        }
        else if (data === "G") {
            this.follow = true;
            this.cursor = Math.max(0, summary.steps.length - 1);
        }
        else if (data === " " || matchesKey(data, "pageDown"))
            this.moveCursor(Math.max(1, page), summary);
        else if (data === "b" || matchesKey(data, "pageUp"))
            this.moveCursor(-Math.max(1, page), summary);
        else if (matchesKey(data, "ctrl+d"))
            this.moveCursor(Math.floor(page / 2), summary);
        else if (matchesKey(data, "ctrl+u"))
            this.moveCursor(-Math.floor(page / 2), summary);
        else if (matchesKey(data, "return") || data === "l" || matchesKey(data, "right") || matchesKey(data, "tab"))
            this.openDetail();
    }
    openDetail() {
        if (this.summary().steps.length === 0)
            return;
        this.detailOpen = true;
        this.focus = "detail";
        this.follow = false;
        this.detailScroll = 0;
    }
    detailKeys(data, summary) {
        const rows = this.detailRows(this.section, summary, this.detailWidth()).length;
        const page = Math.max(1, this.bodyHeight() - 1);
        if (data === "h" || matchesKey(data, "left"))
            this.section = (this.section + SECTIONS.length - 1) % SECTIONS.length;
        else if (data === "l" || matchesKey(data, "right"))
            this.section = (this.section + 1) % SECTIONS.length;
        else if (matchesKey(data, "tab"))
            this.focus = "list";
        else if (data >= "1" && data <= "5")
            this.section = Number(data) - 1;
        else if (data === "j" || matchesKey(data, "down"))
            this.detailScroll += 1;
        else if (data === "k" || matchesKey(data, "up"))
            this.detailScroll -= 1;
        else if (data === " " || matchesKey(data, "pageDown"))
            this.detailScroll += page;
        else if (data === "b" || matchesKey(data, "pageUp"))
            this.detailScroll -= page;
        else if (matchesKey(data, "ctrl+d"))
            this.detailScroll += Math.floor(page / 2);
        else if (matchesKey(data, "ctrl+u"))
            this.detailScroll -= Math.floor(page / 2);
        else if (data === "g")
            this.detailScroll = 0;
        else if (data === "G")
            this.detailScroll = Math.max(0, rows - this.bodyHeight());
        this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, rows - this.bodyHeight())));
    }
    submit(prompt) {
        if (prompt.kind === "/") {
            this.finder.query = prompt.text;
            this.detailOpen = true;
            this.focus = "detail";
            this.findNext(false, this.summary());
        }
    }
    findNext(backwards, summary) {
        if (this.finder.query === "")
            return;
        const rows = this.detailRows(this.section, summary, this.detailWidth());
        const row = this.finder.next(rows, this.detailScroll, backwards);
        if (row === undefined)
            this.message = `not found: ${this.finder.query}`;
        else
            this.detailScroll = row;
    }
    // ── rendering ────────────────────────────────────────────────────────────
    bodyHeight() {
        const height = this.options.tui.terminal.rows;
        const base = height < 16 ? 3 : 4; // header, axis, blank (not compact), status
        return Math.max(3, height - base - this.topRows());
    }
    /** A fixed slice of the list shown as the dot matrix above it, never growing with the session. */
    topRows() {
        const height = this.options.tui.terminal.rows;
        return Math.min(5, Math.max(2, Math.round(height * 0.12)));
    }
    detailWidth() {
        const width = this.options.tui.terminal.columns;
        if (!this.detailOpen)
            return width;
        if (width >= 120)
            return width - Math.max(56, Math.floor(width / 2)) - 1;
        return width;
    }
    /** Pixel geometry: two glyphs per cell with a 1-column gap, matching the agreed mockup. */
    gridGeometry(width) {
        const pixelWidth = 2;
        const gap = 1;
        const units = Math.max(4, Math.floor((Math.max(8, width - 1) + gap) / (pixelWidth + gap)));
        return { units, pixelWidth, gap, usedWidth: units * pixelWidth + (units - 1) * gap };
    }
    /** Keep the cursor's row on screen and the list scroll in range, before anything is drawn. */
    syncList(summary, height) {
        if (this.follow)
            this.cursor = summary.steps.length - 1;
        this.cursor = Math.max(0, Math.min(this.cursor, Math.max(0, summary.steps.length - 1)));
        if (this.cursor < this.listScroll)
            this.listScroll = this.cursor;
        if (this.cursor >= this.listScroll + height)
            this.listScroll = this.cursor - height + 1;
        this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, summary.steps.length - height)));
    }
    durationOf(step) {
        if (step.duration !== undefined)
            return step.duration.ms;
        if (step.span?.endMs !== undefined)
            return step.span.endMs - step.span.startMs;
        return undefined;
    }
    /** The time window of the steps currently on screen: the grid never compresses the whole
     * session, only what is visible right now. */
    visibleWindow(steps) {
        let start = Number.POSITIVE_INFINITY;
        let end = Number.NEGATIVE_INFINITY;
        for (const step of steps) {
            // Only execution defines the window: user/event timestamps would stretch it over idle time.
            if (step.kind !== "model" && step.kind !== "tool")
                continue;
            if (step.span !== undefined) {
                start = Math.min(start, step.span.startMs);
                end = Math.max(end, step.span.endMs ?? step.span.startMs);
            }
            else if (step.atMs !== undefined) {
                start = Math.min(start, step.atMs);
                end = Math.max(end, step.atMs);
            }
        }
        if (!Number.isFinite(start) || !Number.isFinite(end))
            return undefined;
        return { startMs: start, endMs: end <= start ? start + 1 : end };
    }
    /** The visible model/tool activity as time intervals, for the folding map. */
    timelineMap(visible, units) {
        const intervals = [];
        for (const step of visible) {
            if (step.kind !== "model" && step.kind !== "tool")
                continue;
            if (step.span !== undefined)
                intervals.push([step.span.startMs, step.span.endMs ?? step.span.startMs]);
            else if (step.atMs !== undefined)
                intervals.push([step.atMs, step.atMs]);
        }
        const folded = foldTimeline(intervals, units);
        return folded;
    }
    /** One step's dot-matrix row: its span as blocks, an instant as one cell, empty when untimed.
     * User and event steps show a single marker so every step on screen has its own row. */
    stepBar(step, columnOf, geo, selected) {
        const th = this.options.theme;
        const cells = Array.from({ length: geo.units }, () => ({ text: " ".repeat(geo.pixelWidth), lit: false }));
        const mark = (from, to, tone) => {
            for (let unit = from; unit <= to; unit += 1)
                cells[unit] = { text: th.fg(tone, "▪".repeat(geo.pixelWidth)), lit: true };
        };
        if (step.kind === "model" || step.kind === "tool") {
            const tone = step.status === "error" || step.status === "aborted" ? "error" : step.status === "running" ? "warning" : step.kind === "model" ? "accent" : "success";
            if (step.span !== undefined) {
                const from = columnOf(step.span.startMs);
                const to = step.span.endMs === undefined ? from : Math.max(from, columnOf(step.span.endMs));
                mark(from, to, tone);
            }
            else if (step.atMs !== undefined) {
                mark(columnOf(step.atMs), columnOf(step.atMs), tone);
            }
        }
        else if (step.kind === "user") {
            if (step.atMs !== undefined)
                mark(columnOf(step.atMs), columnOf(step.atMs), "text");
        }
        else if (step.kind === "event") {
            if (step.atMs !== undefined)
                mark(columnOf(step.atMs), columnOf(step.atMs), "dim");
        }
        return cells.map((cell, unit) => {
            // The selected step's dots are reversed so it is findable in the minimap.
            const glyph = selected && cell.lit ? th.inverse(cell.text) : cell.text;
            return glyph + (unit < geo.units - 1 ? " ".repeat(geo.gap) : "");
        }).join("");
    }
    /** The axis above the step rows: the window's start and total, with a dot pair where a long idle
     * gap was folded. */
    gridAxis(geo, skipped, window) {
        const th = this.options.theme;
        const chars = Array(geo.usedWidth).fill(" ");
        const start = "+0ms";
        for (let index = 0; index < start.length && index < geo.usedWidth; index += 1)
            chars[index] = start[index];
        const total = formatDuration(window.endMs - window.startMs);
        const endAt = geo.usedWidth - total.length;
        if (endAt >= start.length + 1)
            for (let index = 0; index < total.length; index += 1)
                chars[endAt + index] = total[index];
        for (const unit of skipped) {
            const at = unit * (geo.pixelWidth + geo.gap);
            if (chars[at] === " ")
                chars[at] = "·";
            if (at + 1 < geo.usedWidth && chars[at + 1] === " ")
                chars[at + 1] = "·";
        }
        return th.fg("dim", chars.join(""));
    }
    headerLine(width, summary) {
        const th = this.options.theme;
        const branch = this.options.branch();
        const count = `${summary.steps.length} step${summary.steps.length === 1 ? "" : "s"}`;
        const left = `${th.style(" trace ", { bg: "selectedBg", fg: "accent", bold: true })} ${th.fg("text", branch ?? "(no branch)")} ${th.fg("dim", `· ${count}`)}`;
        const right = this.options.recorder.running ? th.fg("accent", "● running") : th.fg("dim", "○ idle");
        const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2);
        return ` ${left}${" ".repeat(gap)}${right} `;
    }
    listRow(step, index, selected, width) {
        const th = this.options.theme;
        const durationMs = this.durationOf(step);
        const marker = selected ? "›" : " ";
        const seq = String(index + 1).padStart(3);
        const duration = pad(formatDuration(durationMs), 7);
        const glyph = KIND_GLYPH[step.kind] ?? "?";
        // The icon carries the same colour the step has in the dot matrix above.
        const iconTone = step.status === "error" || step.status === "aborted" ? "error" : step.status === "running" ? "warning" : step.kind === "model" ? "accent" : step.kind === "tool" ? "success" : step.kind === "user" ? "text" : "dim";
        const typeWidth = width >= 80 ? 12 : 8;
        const type = pad(step.object, typeWidth);
        const status = step.status === "completed" || step.status === "pending" ? "" : ` ${step.status}`;
        const note = step.note === undefined ? "" : ` ${step.note}`;
        const body = pad(`${marker}${seq} ${duration} ${th.fg(iconTone, glyph)} ${type} ${step.title}${note}${status}`, width);
        const tone = step.status === "error" || step.status === "aborted" ? "error" : step.status === "running" ? "accent" : step.status === "length" || step.status === "deferred" ? "warning" : step.kind === "event" || step.kind === "user" ? "dim" : "text";
        return selected ? th.style(body, { bg: "selectedBg", bold: true }) : th.fg(tone, body);
    }
    listLines(width, height, summary) {
        const th = this.options.theme;
        if (summary.steps.length === 0) {
            return Array.from({ length: height }, (_, row) => pad(row === 0 ? th.fg("dim", " No steps recorded in this session yet.") : "", width));
        }
        const bar = scrollbar(th, summary.steps.length, height, this.listScroll, height);
        return Array.from({ length: height }, (_, row) => {
            const index = this.listScroll + row;
            const step = summary.steps[index];
            if (step === undefined)
                return " ".repeat(Math.max(0, width - 1)) + bar[row];
            const selected = index === this.cursor && this.focus === "list";
            return this.listRow(step, index, selected, width - 1) + bar[row];
        });
    }
    // ── inspector ────────────────────────────────────────────────────────────
    field(name, text, tone) {
        return [{ text: name.padEnd(12), tone: "dim" }, { text, ...(tone === undefined ? {} : { tone }) }];
    }
    block(name, text) {
        const lines = text.split("\n");
        return [
            [{ text: name.padEnd(12), tone: "dim" }],
            ...lines.map((line) => [{ text: `  ${line}` }]),
        ];
    }
    detailLines(step, section) {
        switch (section) {
            case "Summary": return this.summarySection(step);
            case "Payload": return this.payloadSection(step);
            case "Result": return this.resultSection(step);
            case "Schema": return this.schemaSection(step);
            case "Timing": return this.timingSection(step);
        }
    }
    summarySection(step) {
        const lines = [
            this.field("step", `${step.kind} · ${step.id}`),
            this.field("status", step.status, step.status === "error" ? "error" : step.status === "running" ? "accent" : undefined),
            this.field("source", step.source === "observation" ? "observed live (not yet bound to an entry)" : "session entry"),
            this.field("entry", step.entryId ?? "— (observation)"),
            this.field("parent", step.parentId ?? "—"),
            this.field("at", `${formatClock(step.atMs)}${step.atMs === undefined ? "" : ` · ${formatOffset(step.atMs, this.summary().startMs)}`}`),
        ];
        if (step.model !== undefined) {
            const model = step.model;
            lines.push(this.field("model", `${model.provider ?? "?"}/${model.responseModel ?? model.model ?? "?"}`));
            lines.push(this.field("api", model.api ?? "—"));
            lines.push(this.field("stop", model.stopReason ?? "—", model.stopReason === "length" ? "warning" : model.stopReason === "error" ? "error" : undefined));
            if (model.rawStopReason !== undefined)
                lines.push(this.field("raw stop", model.rawStopReason));
            if (model.errorMessage !== undefined)
                lines.push(this.field("error", model.errorMessage, "error"));
            const blocks = model.blocks.map((block) => block.type);
            lines.push(this.field("content", blocks.length === 0 ? "(none)" : blocks.join(", ")));
            if (step.callIds !== undefined)
                lines.push(this.field("calls", step.callIds.join(", ")));
        }
        if (step.tool !== undefined) {
            lines.push(this.field("tool", step.tool.name));
            lines.push(this.field("call id", step.tool.callId));
            lines.push(this.field("arguments", step.tool.arguments === undefined ? "—" : "recorded (Payload)"));
            lines.push(this.field("result", step.tool.result === undefined ? "not recorded" : step.tool.result.isError ? "error" : "recorded (Result)"));
        }
        if (step.warning !== undefined)
            lines.push(this.field("warning", step.warning, "warning"));
        return lines;
    }
    payloadSection(step) {
        if (step.model !== undefined) {
            const lines = [this.field("note", "payload below is the recorded response metadata; it is not a captured HTTP request")];
            lines.push(this.field("provider", step.model.provider ?? "—"));
            lines.push(this.field("api", step.model.api ?? "—"));
            lines.push(this.field("model", step.model.model ?? "—"));
            lines.push(this.field("response", step.model.responseModel ?? "—"));
            if (step.model.thinkingLevel !== undefined)
                lines.push(this.field("thinking", step.model.thinkingLevel));
            for (const line of usageLines(step.model.usage)) {
                lines.push(this.field(line.subset ? `usage ${line.label}` : `usage ${line.label}`, `${line.value}${line.subset ? " (included above)" : ""}`));
            }
            return lines;
        }
        if (step.tool !== undefined) {
            if (step.tool.arguments === undefined)
                return [this.field("arguments", "no arguments recorded", "dim")];
            return this.block("arguments", safeJson(step.tool.arguments));
        }
        return [this.field("payload", "not applicable to this step kind", "dim")];
    }
    resultSection(step) {
        if (step.model !== undefined) {
            const lines = [];
            step.model.blocks.forEach((block, index) => {
                const title = block.redacted ? `${block.type} ${index + 1} (redacted — no visible text)` : `${block.type} ${index + 1}`;
                lines.push([{ text: title, tone: "dim" }]);
                const text = block.redacted ? "(hidden content)" : block.text === "" ? "(empty)" : block.text;
                for (const line of text.split("\n"))
                    lines.push([{ text: `  ${line}` }]);
                if (block.type === "toolCall" && block.toolName !== undefined)
                    lines.push([{ text: `  → ${block.toolName} ${block.callId ?? ""}`.trimEnd(), tone: "accent" }]);
            });
            if (lines.length === 0)
                lines.push(this.field("content", "no content blocks recorded", "dim"));
            return lines;
        }
        if (step.tool !== undefined) {
            const result = step.tool.result;
            if (result === undefined)
                return [this.field("result", step.status === "running" ? "still running" : "not recorded", step.status === "running" ? "accent" : "dim")];
            const lines = [this.field("is error", result.isError ? "yes" : "no", result.isError ? "error" : undefined)];
            lines.push(...this.block("content", contentLines(result.content).join("\n")));
            if (result.details !== undefined)
                lines.push(...this.block("details", safeJson(result.details)));
            if (step.tool.nested !== undefined)
                lines.push(...this.block("nested calls", safeJson(step.tool.nested)));
            return lines;
        }
        return [this.field("result", "not applicable to this step kind", "dim")];
    }
    schemaSection(step) {
        if (step.tool === undefined) {
            return [this.field("schema", "not applicable; no schema is fabricated for a non-tool step", "dim")];
        }
        const schema = step.tool.schema;
        if (schema?.declaration === undefined) {
            return [
                this.field("source", schema?.source ?? "unknown"),
                this.field("declaration", schema?.unavailable ?? "unavailable", "warning"),
                this.field("note", "the current tool registry is a separate, later source and is not shown as the call-time schema", "dim"),
            ];
        }
        return [
            this.field("source", schema.source),
            ...this.block("declaration", safeJson(schema.declaration)),
            this.field("note", "replayed from session system messages, not read from today's registry", "dim"),
        ];
    }
    timingSection(step) {
        const lines = [];
        if (step.duration !== undefined) {
            lines.push(this.field(step.duration.scope === "execute" ? "execute" : "response", `${formatDuration(step.duration.ms)} · ${step.duration.source}`));
        }
        if (step.span !== undefined) {
            const end = step.span.endMs === undefined ? "running" : formatOffset(step.span.endMs, this.summary().startMs);
            lines.push(this.field("observed", `${formatOffset(step.span.startMs, this.summary().startMs)} → ${end}`));
            lines.push(this.field("span source", step.span.source));
        }
        if (step.atMs !== undefined)
            lines.push(this.field("recorded at", `${formatClock(step.atMs)} · ${formatOffset(step.atMs, this.summary().startMs)}`));
        if (step.duration === undefined && step.span === undefined && step.atMs === undefined) {
            lines.push(this.field("timing", "nothing recorded", "warning"));
        }
        if (step.spanIssue !== undefined)
            lines.push(this.field("issue", step.spanIssue, "warning"));
        if (step.tool !== undefined && step.span === undefined && step.duration !== undefined) {
            lines.push(this.field("note", "execute start/end not recorded; the span is not inferred from the result timestamp", "dim"));
        }
        return lines;
    }
    detailRows(section, summary, width) {
        const step = this.currentStep(summary);
        const th = this.options.theme;
        if (step === undefined)
            return [th.fg("dim", " No step selected.")];
        const name = SECTIONS[section] ?? "Summary";
        const tabs = SECTIONS.map((entry, index) => index === section ? th.fg("accent", `[${entry}]`) : th.fg("dim", ` ${entry} `)).join(" ");
        const header = pad(` ${tabs}`, width);
        const headline = pad(th.fg("text", ` ${step.kind} · ${step.title || step.object}`), width);
        const body = this.detailLines(step, name).flatMap((line) => this.renderDetailLine(line, width));
        return [header, headline, "", ...body];
    }
    renderDetailLine(line, width) {
        const th = this.options.theme;
        const styled = line.map((segment) => (segment.tone === undefined ? segment.text : th.fg(segment.tone, segment.text))).join("");
        const wrapped = styled === "" ? [""] : wrapTextWithAnsi(styled, Math.max(1, width));
        return wrapped.map((row) => pad(row, width));
    }
    render(width) {
        const th = this.options.theme;
        const height = this.options.tui.terminal.rows;
        const compact = height < 16;
        const summary = this.summary();
        const bodyHeight = this.bodyHeight();
        this.syncList(summary, bodyHeight);
        const labelWidth = 5;
        const geo = this.gridGeometry(width - labelWidth);
        const rows = [this.headerLine(width, summary)];
        // The matrix is a fixed-height window on the selected step, not one row per visible step.
        const topCount = this.topRows();
        const topStart = Math.max(0, Math.min(this.cursor - Math.floor((topCount - 1) / 2), Math.max(0, summary.steps.length - topCount)));
        const topSteps = summary.steps.slice(topStart, topStart + topCount);
        const topWindow = this.visibleWindow(topSteps);
        if (topWindow === undefined) {
            rows.push(` ${pad("", labelWidth)}${th.fg("dim", "no timing in view")}`);
            for (let index = 0; index < topCount; index += 1)
                rows.push("");
        }
        else {
            const map = this.timelineMap(topSteps, geo.units);
            rows.push(` ${pad("", labelWidth)}${this.gridAxis(geo, map.skipped, topWindow)}`);
            for (let index = 0; index < topCount; index += 1) {
                const step = topSteps[index];
                if (step === undefined) {
                    rows.push("");
                    continue;
                }
                const stepNumber = topStart + index;
                const selected = stepNumber === this.cursor;
                const pointer = selected ? (this.detailOpen ? "▸" : "›") : " ";
                const label = pad(`${pointer}${String(stepNumber + 1).padStart(3)} `, labelWidth);
                rows.push(` ${th.fg(selected ? "accent" : "dim", label)}${this.stepBar(step, map.columnOf, geo, selected)}`);
            }
        }
        if (!compact)
            rows.push("");
        const wide = width >= 120 && this.detailOpen;
        const leftWidth = wide ? Math.max(56, Math.floor(width / 2)) : width;
        const rightWidth = wide ? width - leftWidth - 1 : width;
        this.geometry = { top: rows.length, height: bodyHeight, listWidth: leftWidth, wide };
        if (this.detailOpen) {
            const bars = this.detailRows(this.section, summary, rightWidth);
            const maxScroll = Math.max(0, bars.length - bodyHeight);
            this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));
            const shown = bars.slice(this.detailScroll, this.detailScroll + bodyHeight);
            const bar = scrollbar(th, bars.length, bodyHeight, this.detailScroll, bodyHeight);
            if (wide) {
                const list = this.listLines(leftWidth - 1, bodyHeight, summary);
                for (let row = 0; row < bodyHeight; row += 1) {
                    rows.push(`${pad(list[row] ?? "", leftWidth - 1)}${th.fg("border", "│")}${pad(this.finder.highlight(shown[row] ?? "", (text) => th.inverse(text)), rightWidth - 1)}${bar[row]}`);
                }
            }
            else {
                for (let row = 0; row < bodyHeight; row += 1) {
                    rows.push(pad(this.finder.highlight(shown[row] ?? "", (text) => th.inverse(text)), width - 1) + bar[row]);
                }
            }
        }
        else {
            const list = this.listLines(width - 1, bodyHeight, summary);
            for (let row = 0; row < bodyHeight; row += 1)
                rows.push(list[row] ?? " ".repeat(Math.max(0, width - 1)));
        }
        const step = this.currentStep(summary);
        const position = summary.steps.length === 0 ? "0/0" : `${this.cursor + 1}/${summary.steps.length}`;
        const left = this.message !== "" ? th.fg("warning", this.message) : th.fg("dim", this.hints());
        const right = th.fg("accent", position) + (step?.status === "running" ? th.fg("dim", " · running") : "");
        const clipped = truncateToWidth(left, Math.max(1, width - visibleWidth(right) - 3), "…");
        const gap = Math.max(1, width - visibleWidth(clipped) - visibleWidth(right) - 1);
        rows.push(` ${clipped}${" ".repeat(gap)}${right} `);
        return rows.slice(0, height);
    }
    hints() {
        if (this.prompt)
            return `${this.prompt.kind}${this.prompt.text}▏`;
        if (this.focus === "detail" && this.detailOpen) {
            return "←/→ section · 1-5 · j/k scroll · / search · n/N · Tab list · Esc back";
        }
        return "j/k select · Enter detail · / search · G latest · Esc close";
    }
    handleMouse(event) {
        const geometry = this.geometry;
        if (geometry === undefined)
            return { handled: true };
        const row = event.y - geometry.top;
        if (event.type === "wheel") {
            const delta = event.wheelDelta ?? 0;
            if (this.detailOpen && (!geometry.wide || event.x >= geometry.listWidth)) {
                const rows = this.detailRows(this.section, this.summary(), this.detailWidth());
                this.detailScroll = Math.max(0, Math.min(Math.max(0, rows.length - geometry.height), this.detailScroll + delta));
            }
            else {
                this.follow = false;
                this.moveCursor(delta, this.summary());
            }
            this.options.tui.requestRender();
            return { handled: true };
        }
        if (event.type === "click" && row >= 0 && row < geometry.height) {
            if (geometry.wide && event.x >= geometry.listWidth)
                return { handled: true };
            if (this.detailOpen && !geometry.wide)
                return { handled: true };
            const index = this.listScroll + row;
            if (index < this.summary().steps.length) {
                this.cursor = index;
                this.follow = index === this.summary().steps.length - 1;
                this.openDetail();
            }
            this.options.tui.requestRender();
            return { capture: true };
        }
        return { handled: true };
    }
    invalidate() { }
}
//# sourceMappingURL=page.js.map