import { piTui } from "../../tui/pi-tui.js";
import { centered, imageBody, pad } from "./draw.js";
import { clock } from "./files.js";
import { audioWave, Player, SEEK_SECONDS } from "./media.js";
const { matchesKey, truncateToWidth, visibleWidth } = piTui;
const PANE_HINT = "space play/pause · ←/→ 5s";
/** ffmpeg's and ffplay's `-headers` option: every header as `Key: value\r\n`, in one argument. */
function headerArgs(headers) {
    const entries = Object.entries(headers ?? {});
    return entries.length === 0 ? [] : ["-headers", entries.map(([name, value]) => `${name}: ${value}\r\n`).join("")];
}
export class PlayerPane {
    source;
    host;
    onDispose;
    player;
    /** Where the progress bar sits in the status row, and the body height, for the mouse. */
    progress;
    height = 0;
    disposed = false;
    constructor(source, host, onDispose) {
        this.source = source;
        this.host = host;
        this.onDispose = onDispose;
    }
    /** Stops ffmpeg and ffplay. Safe to call more than once; a disposed pane does not play again. */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.player?.stop();
        this.player = undefined;
        this.onDispose?.();
    }
    /** Space/p pause and resume, ←/→ and h/l seek 5 s, g/0 go back to the start. True when the key was used. */
    handleInput(data) {
        const player = this.player;
        if (!player)
            return false;
        if (data === " " || data === "p")
            player.toggle();
        else if (matchesKey(data, "right") || data === "l")
            player.seek(player.position + SEEK_SECONDS);
        else if (matchesKey(data, "left") || data === "h")
            player.seek(player.position - SEEK_SECONDS);
        else if (data === "g" || data === "0")
            player.seek(0);
        else
            return false;
        return true;
    }
    /** `x`/`y` are relative to the body's top left; `y === height` is the status row. A click on the
     * picture pauses, a click or drag on the progress bar seeks. True when the event was used. */
    handleMouse(event, x, y) {
        const player = this.player;
        if (!player || (event.type !== "press" && event.type !== "drag"))
            return false;
        if (y === this.height && this.progress && x >= this.progress.start) {
            if (!this.source.duration)
                return false;
            const ratio = Math.min(1, (x - this.progress.start) / Math.max(1, this.progress.width - 1));
            player.seek(ratio * this.source.duration);
            return true;
        }
        if (y < this.height && event.type === "press") {
            player.toggle();
            return true;
        }
        return false;
    }
    /** `body` is exactly `height` rows: the picture and one row of sound level; `status` is one row. */
    render(width, height) {
        this.height = height;
        const th = this.host.theme;
        if (this.disposed) {
            const body = centered(th.fg("dim", "stopped"), width, height).map((line) => pad(line, width));
            return { body, status: this.host.hint ? truncateToWidth(` ${th.fg("dim", this.host.hint)}`, width, "…") : "" };
        }
        const hint = this.host.hint ? `${PANE_HINT} · ${this.host.hint}` : PANE_HINT;
        const frameHeight = Math.max(1, height - 1);
        if (!this.player || this.player.width !== width || this.player.height !== frameHeight) {
            const resumeAt = this.player?.position ?? 0;
            const playing = this.player?.playing ?? true;
            this.player?.stop();
            this.player = this.createPlayer(width, frameHeight);
            this.player.playing = playing;
            this.player.play(resumeAt);
        }
        const player = this.player;
        const frameBody = player.error
            ? centered(th.fg("error", player.error), width, frameHeight)
            : player.frameBase64
                ? (() => {
                    const rendered = imageBody(player.frameBase64, "image/png", th, width, frameHeight, this.source.label, undefined, player.imageId, true);
                    player.imageId = rendered.imageId;
                    return rendered.lines;
                })()
                : centered(th.fg("dim", "loading…"), width, frameHeight);
        const meterLabel = ` sound ${player.audioLevelDb === undefined ? "--" : `${Math.round(player.audioLevelDb)}dB`} `;
        const meterWidth = Math.max(0, width - visibleWidth(meterLabel));
        const wave = audioWave(player.audioHistory, meterWidth);
        const meter = th.fg("dim", meterLabel) + th.fg("accent", wave);
        const body = [...frameBody, meter].slice(0, Math.max(0, height));
        const state = player.ended ? "■" : player.playing ? "▶" : "⏸";
        const duration = this.source.duration ?? 0;
        const time = `${state} ${clock(player.position)}${duration ? ` / ${clock(duration)}` : ""}`;
        const barWidth = Math.max(0, width - visibleWidth(time) - visibleWidth(hint) - 6);
        const filled = duration ? Math.round(Math.min(1, player.position / duration) * barWidth) : 0;
        this.progress = { start: visibleWidth(time) + 3, width: barWidth };
        const progress = th.fg("accent", "━".repeat(filled)) + th.fg("dim", "─".repeat(Math.max(0, barWidth - filled)));
        return {
            body: body.map((line) => pad(line, width)),
            // Cut the way the viewer's page cuts its rows, so a narrow pane draws the same as before.
            status: truncateToWidth(` ${th.fg("accent", time)}  ${progress}  ${th.fg("dim", hint)}`, width, "…"),
        };
    }
    createPlayer(width, height) {
        const { video, audio, headers, fps, loop } = this.source;
        const args = headerArgs(headers);
        return new Player(video, width, height, loop ?? false, () => this.host.tui.requestRender(), {
            ...(fps === undefined ? {} : { fps }),
            ...(audio === undefined ? {} : { audio }),
            ...(args.length === 0 ? {} : { videoArgs: args, audioArgs: args }),
        });
    }
}
//# sourceMappingURL=player-pane.js.map