import { piTui } from "../../tui/pi-tui.js";
import { pad, scrollbar } from "../preview/draw.js";
import { Finder, LinePrompt } from "../preview/search.js";
import { contentLines, formatClock, formatDuration, formatOffset, safeJson, usageLines } from "./format.js";
import { buildGrid, buildTimeline, columnRange } from "./timeline.js";
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
        return Math.max(3, height - this.chromeRows(height));
    }
    /** Rows the grid timeline takes above the body: two lanes, each `laneRows` tall, plus the axis. */
    laneRows(height) {
        if (height >= 24)
            return 3;
        if (height >= 18)
            return 2;
        return 1;
    }
    chromeRows(height) {
        const grid = this.laneRows(height) * 2 + 1;
        return 1 + grid + (height < 16 ? 0 : 1) + 1;
    }
    detailWidth() {
        const width = this.options.tui.terminal.columns;
        if (!this.detailOpen)
            return width;
        if (width >= 120)
            return width - Math.max(56, Math.floor(width / 2)) - 1;
        return width;
    }
    /** Cell width, gap and column count for the grid at this terminal width. */
    gridGeometry(width, labelWidth) {
        const available = Math.max(8, width - labelWidth - 1);
        const cellWidth = available >= 60 ? 3 : available >= 28 ? 2 : 1;
        const gap = available / (cellWidth + 1) >= 12 ? 1 : 0;
        const columns = Math.max(4, Math.floor((available + gap) / (cellWidth + gap)));
        return { cellWidth, gap, columns };
    }
    gridTone(tone, lane) {
        if (tone === "error")
            return "error";
        if (tone === "running")
            return "warning";
        return lane === "model" ? "accent" : "success";
    }
    /** The selected step's column range, so its cells stand out in the grid. */
    selectedHighlight(summary, timeline, columns) {
        const step = this.currentStep(summary);
        if (step === undefined || step.kind === "event" || step.kind === "user" || step.kind === "unknown")
            return undefined;
        const lane = step.kind === "model" ? "model" : "tools";
        if (step.span !== undefined) {
            const [from, to] = columnRange(timeline, step.span.startMs, step.span.endMs ?? step.span.startMs, columns);
            return { lane, from, to };
        }
        if (step.atMs !== undefined) {
            const [from, to] = columnRange(timeline, step.atMs, step.atMs, columns);
            return { lane, from, to };
        }
        return undefined;
    }
    /** The GitHub-like grid: one block per active time bucket, stacked rows for concurrency. */
    timelineLines(width, summary) {
        const th = this.options.theme;
        const labelWidth = 6;
        const height = this.options.tui.terminal.rows;
        const laneRows = this.laneRows(height);
        const timeline = buildTimeline(summary, { tickCount: 6 });
        const { cellWidth, gap, columns } = this.gridGeometry(width, labelWidth);
        if (timeline.empty) {
            const out = [
                `${pad(th.fg("dim", "Model"), labelWidth)} ${th.fg("dim", "no timing recorded for this session")}`,
            ];
            while (out.length < laneRows * 2 + 1)
                out.push(" ".repeat(labelWidth));
            return out;
        }
        const lanes = buildGrid(timeline, columns);
        const highlight = this.selectedHighlight(summary, timeline, columns);
        const rows = [];
        for (const lane of lanes) {
            for (let row = 0; row < laneRows; row += 1) {
                const label = row === 0 ? pad(th.fg("dim", lane.lane === "model" ? "Model" : "Tools"), labelWidth) : " ".repeat(labelWidth);
                let body = "";
                for (let column = 0; column < columns; column += 1) {
                    const cell = lane.cells[column];
                    const filled = cell.active > 0 && row >= laneRows - Math.min(cell.active, laneRows);
                    const glyph = (filled ? "█" : "·").repeat(cellWidth);
                    const hot = highlight !== undefined && highlight.lane === lane.lane && column >= highlight.from && column <= highlight.to;
                    if (hot)
                        body += th.inverse(th.fg(filled ? this.gridTone(cell.tone, lane.lane) : "dim", glyph));
                    else if (filled)
                        body += th.fg(this.gridTone(cell.tone, lane.lane), glyph);
                    else
                        body += th.fg("dim", glyph);
                    if (gap > 0 && column < columns - 1)
                        body += " ";
                }
                rows.push(`${label} ${body}`);
            }
        }
        // Axis: each tick label starts at its column; the grid cell is wider than one character.
        const axisWidth = labelWidth + 1 + columns * (cellWidth + gap);
        const axis = Array(axisWidth).fill(" ");
        for (const tick of timeline.ticks) {
            let at = labelWidth + 1 + Math.floor(((tick.atMs - timeline.startMs) / Math.max(1, timeline.endMs - timeline.startMs)) * columns) * (cellWidth + gap);
            for (const char of tick.label) {
                if (at >= axisWidth)
                    break;
                axis[at] = char;
                at += 1;
            }
        }
        rows.push(th.fg("dim", axis.join("").replace(/\s+$/, "")));
        return rows;
    }
    headerLine(width, summary) {
        const th = this.options.theme;
        const branch = this.options.branch();
        const state = this.options.recorder.running ? th.fg("accent", "● running") : th.fg("dim", "○ idle");
        const coverage = summary.coverage;
        const parts = [
            th.style(" trace ", { bg: "selectedBg", fg: "accent", bold: true }),
            th.fg("text", branch ?? "(no branch)"),
            th.fg("dim", `${summary.groups} user message${summary.groups === 1 ? "" : "s"} · ${summary.steps.length} steps`),
            state,
            th.fg("dim", `${coverage.withSpan} spanned · ${coverage.durationOnly} duration only · ${coverage.untimed} untimed`),
        ];
        if (summary.observing > 0)
            parts.push(th.fg("warning", `${summary.observing} live`));
        return pad(parts.join(th.fg("dim", "  ·  ")), width);
    }
    listRow(step, index, selected, width) {
        const th = this.options.theme;
        const durationMs = step.duration?.ms ?? (step.span?.endMs === undefined ? undefined : step.span.endMs - step.span.startMs);
        const marker = selected ? "›" : " ";
        const seq = String(index + 1).padStart(3);
        const duration = pad(formatDuration(durationMs), 7);
        const glyph = KIND_GLYPH[step.kind] ?? "?";
        const typeWidth = width >= 80 ? 12 : 8;
        const type = pad(step.object, typeWidth);
        const status = step.status === "completed" || step.status === "pending" ? "" : ` ${step.status}`;
        const note = step.note === undefined ? "" : ` ${step.note}`;
        const body = `${marker}${seq} ${duration} ${glyph} ${type} ${step.title}${note}${status}`;
        const tone = selected
            ? "text"
            : step.status === "error" || step.status === "aborted"
                ? "error"
                : step.status === "running"
                    ? "accent"
                    : step.status === "length" || step.status === "deferred"
                        ? "warning"
                        : step.kind === "event" || step.kind === "user"
                            ? "dim"
                            : "text";
        const clipped = pad(body, width);
        return selected ? th.style(clipped, { bg: "selectedBg", bold: true }) : th.fg(tone, clipped);
    }
    listLines(width, height, summary) {
        const th = this.options.theme;
        if (summary.steps.length === 0) {
            return Array.from({ length: height }, (_, row) => pad(row === 0 ? th.fg("dim", " No steps recorded in this session yet.") : "", width));
        }
        if (this.follow)
            this.cursor = summary.steps.length - 1;
        this.cursor = Math.max(0, Math.min(this.cursor, summary.steps.length - 1));
        if (this.cursor < this.listScroll)
            this.listScroll = this.cursor;
        if (this.cursor >= this.listScroll + height)
            this.listScroll = this.cursor - height + 1;
        this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, summary.steps.length - height)));
        const bar = scrollbar(th, summary.steps.length, height, this.listScroll, height);
        return Array.from({ length: height }, (_, row) => {
            const index = this.listScroll + row;
            const step = summary.steps[index];
            if (step === undefined)
                return " ".repeat(Math.max(0, width - 1)) + bar[row];
            const selected = index === this.cursor && this.focus === "list";
            return pad(this.listRow(step, index, selected, width - 1), width - 1) + bar[row];
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
        const rows = [this.headerLine(width, summary)];
        rows.push(...this.timelineLines(width, summary));
        if (!compact)
            rows.push("");
        const bodyHeight = this.bodyHeight();
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