// Pixels and sound: stills for images, video frames through ffmpeg, Quick Look thumbnails for
// formats the terminal cannot draw, and a player that streams frames at a fixed rate. ffmpeg,
// ffprobe and ffplay are looked up on PATH when a video is opened; nothing here is needed otherwise.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { piTui } from "../../tui/pi-tui.js";
import { kindOf } from "./files.js";
const { getCellDimensions, getImageDimensions } = piTui;
/** Frames per second when the source does not say, and the most that is drawn: a 60 fps source is
 * shown at 30. */
const DEFAULT_FPS = 24;
const MAX_FPS = 30;
/** Longer side of a video frame in pixels. The terminal scales the frame to the pane, so a pane's
 * full pixel size (2 MB of PNG per 1080p frame) only costs the terminal decoding time: at that size
 * playback stuttered. Sharpness is traded for the source's own frame rate. */
const FRAME_BOX_PX = 640;
/** How long the picture waits for the sound to start before it goes by the wall clock instead
 * (no audio stream, or no ffplay). */
const AUDIO_WAIT_MS = 1500;
/** Bytes the terminal has not taken yet above which a frame is dropped instead of drawn. */
const BACKLOG_BYTES = 1024 * 1024;
export const SEEK_SECONDS = 5;
const METER_SAMPLE_RATE = 8000;
const METER_WINDOW_SECONDS = 0.05;
const METER_HISTORY = 2000;
const METER_FLOOR_DB = -90;
const METER_RANGE_DB = 12;
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/** A program that could not be started. Only a failed spawn means "not installed": a missing media
 * file is ENOENT too, and must not be reported as a missing ffmpeg. */
function spawnErrorText(command, error) {
    return error?.code === "ENOENT"
        ? `${command} not found: install ffmpeg to view video`
        : errorText(error);
}
/** Every media child still running. They are killed when MMP exits, whatever the overlay was
 * doing: ffplay has no pipe to MMP and would otherwise go on playing sound. */
const liveChildren = new Set();
let exitHookInstalled = false;
function track(child) {
    if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.once("exit", stopMediaProcesses);
    }
    liveChildren.add(child);
    const forget = () => liveChildren.delete(child);
    child.once("close", forget);
    child.once("error", forget);
    return child;
}
export function stopMediaProcesses() {
    for (const child of liveChildren)
        child.kill("SIGKILL");
    liveChildren.clear();
}
function run(command, args, timeoutMs = 20_000) {
    return new Promise((resolveRun, reject) => {
        const child = track(spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }));
        const chunks = [];
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(new Error(spawnErrorText(command, error)));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0)
                resolveRun(Buffer.concat(chunks));
            else
                reject(new Error(stderr.trim().split("\n").pop() || `${command} exited with ${code}`));
        });
    });
}
/** ffprobe's "30000/1001" as a number; undefined for "0/0" or anything else that is not a rate. */
function frameRate(text) {
    const [numerator, denominator = "1"] = (text ?? "").split("/");
    const rate = Number(numerator) / Number(denominator);
    return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}
export async function probe(path) {
    const out = await run("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,codec_name,avg_frame_rate:format=duration", "-of", "json", path,
    ]);
    const json = JSON.parse(out.toString());
    const stream = json.streams?.[0];
    const duration = Number(json.format?.duration);
    return {
        ...(stream?.width === undefined ? {} : { width: stream.width }),
        ...(stream?.height === undefined ? {} : { height: stream.height }),
        ...(stream?.codec_name === undefined ? {} : { codec: stream.codec_name }),
        ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
        ...(frameRate(stream?.avg_frame_rate) === undefined ? {} : { fps: frameRate(stream?.avg_frame_rate) }),
    };
}
/** Quick Look thumbnail as PNG bytes for formats the terminal cannot draw directly (PDF/HEIC/etc.). */
async function quickLookPng(path) {
    const dir = mkdtempSync(join(tmpdir(), "mmp-preview-"));
    try {
        await run("qlmanage", ["-t", "-s", "1024", "-o", dir, path]);
        return readFileSync(join(dir, `${basename(path)}.png`));
    }
    catch {
        throw new Error("Quick Look has no preview for this file");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
function mimeFromPath(path) {
    const ext = extname(path).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg")
        return "image/jpeg";
    if (ext === ".gif")
        return "image/gif";
    if (ext === ".webp")
        return "image/webp";
    if (ext === ".bmp")
        return "image/bmp";
    if (ext === ".tif" || ext === ".tiff")
        return "image/tiff";
    if (ext === ".avif")
        return "image/avif";
    return "image/png";
}
/** Decoded stills by path, mtime and size. One decode runs at a time; while it runs only the
 * latest request waits, so holding j over a folder of photos does not spawn a process per file. */
export class StillCache {
    onReady;
    cache = new Map();
    busy = false;
    pending;
    constructor(onReady) {
        this.onReady = onReady;
    }
    get(key, job) {
        const hit = this.cache.get(key);
        if (hit)
            return hit;
        if (this.busy)
            this.pending = { key, job };
        else
            this.start(key, job);
        return undefined;
    }
    start(key, job) {
        this.busy = true;
        void job()
            .catch((error) => ({ error: errorText(error) }))
            .then((still) => {
            this.cache.set(key, still);
            if (this.cache.size > 64)
                this.cache.delete(this.cache.keys().next().value);
            this.busy = false;
            const next = this.pending;
            this.pending = undefined;
            if (next && !this.cache.has(next.key))
                this.start(next.key, next.job);
            this.onReady();
        });
    }
}
export function stillJob(entry) {
    const kind = kindOf(entry.name);
    return async () => {
        const infoPromise = kind === "quicklook" ? Promise.resolve(undefined) : probe(entry.path).catch(() => undefined);
        if (kind === "image") {
            const bytes = readFileSync(entry.path);
            const mimeType = mimeFromPath(entry.path);
            const base64 = bytes.toString("base64");
            const dimensions = getImageDimensions(base64, mimeType) ?? undefined;
            const info = await infoPromise;
            return { base64, mimeType, ...(dimensions ? { dimensions } : {}), ...(info ? { info } : {}) };
        }
        const png = kind === "quicklook"
            ? await quickLookPng(entry.path)
            : await run("ffmpeg", ["-v", "error", "-i", entry.path, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);
        const base64 = png.toString("base64");
        const dimensions = getImageDimensions(base64, "image/png") ?? undefined;
        const info = await infoPromise;
        return { base64, mimeType: "image/png", ...(dimensions ? { dimensions } : {}), ...(info ? { info } : {}) };
    };
}
/** Streams PNG frames from ffmpeg and shows them at the source's frame rate, following the sound:
 * ffplay reports where its audio is (`-stats`), and the frame for that moment is drawn. A frame
 * that is late (a slow redraw, a busy terminal) is dropped, so the picture never falls behind.
 * Until the sound starts the first frame waits; without sound the wall clock is used. Pausing
 * stops taking frames; the pipe's backpressure then stalls ffmpeg, so no signals are needed. */
export class Player {
    path;
    width;
    height;
    loop;
    onFrame;
    source;
    frameBase64;
    position = 0;
    playing = true;
    ended = false;
    error;
    imageId;
    audioLevelDb;
    /** RMS level in dB of each METER_WINDOW_SECONDS of audio, oldest first. */
    audioHistory = [];
    child;
    audio;
    audioMeter;
    meterPartial = Buffer.alloc(0);
    queue = [];
    partial = Buffer.alloc(0);
    timer;
    from = 0;
    /** Frames taken from the queue since `from`, drawn or dropped. */
    shown = 0;
    fps;
    /** A position in the clip known at a wall-clock time: the last one ffplay reported, or where the
     * wall clock took over. Undefined while waiting for the sound to start, and while paused. */
    anchor;
    /** Where this audio run started in the clip, ffplay's first reported clock, and when it was started. */
    audioFrom = 0;
    audioClockZero;
    audioStartedAt = 0;
    statsPartial = "";
    sourceDone = false;
    needFrame = true;
    constructor(path, width, height, loop, onFrame, source = {}) {
        this.path = path;
        this.width = width;
        this.height = height;
        this.loop = loop;
        this.onFrame = onFrame;
        this.source = source;
        const fps = source.fps ?? DEFAULT_FPS;
        this.fps = fps / Math.ceil(fps / MAX_FPS);
    }
    play(from) {
        this.stop();
        this.from = Math.max(0, from);
        this.position = this.from;
        this.shown = 0;
        this.anchor = undefined;
        this.ended = false;
        this.error = undefined;
        this.audioLevelDb = undefined;
        this.audioHistory = [];
        this.queue = [];
        this.partial = Buffer.alloc(0);
        this.meterPartial = Buffer.alloc(0);
        this.sourceDone = false;
        this.needFrame = true;
        let stderr = "";
        const cell = getCellDimensions();
        const maxWidthPx = Math.max(16, Math.min(FRAME_BOX_PX, Math.floor(this.width * cell.widthPx)));
        const maxHeightPx = Math.max(16, Math.min(FRAME_BOX_PX, Math.floor(this.height * cell.heightPx)));
        const vf = `fps=${this.fps},scale=w='min(${maxWidthPx},iw)':h='min(${maxHeightPx},ih)':force_original_aspect_ratio=decrease`;
        const child = track(spawn("ffmpeg", [
            "-v", "error", "-nostdin", "-ss", String(this.from), ...(this.source.videoArgs ?? []), "-i", this.path, "-an",
            "-vf", vf,
            "-f", "image2pipe", "-vcodec", "png", "-compression_level", "3", "-",
        ], { stdio: ["ignore", "pipe", "pipe"] }));
        this.child = child;
        if (this.playing)
            this.startAudio(this.from);
        child.stdout.on("data", (chunk) => {
            let buffer = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
            while (true) {
                const frame = takePngFrame(buffer);
                if (!frame)
                    break;
                this.queue.push(frame.png.toString("base64"));
                buffer = frame.rest;
            }
            this.partial = Buffer.from(buffer);
            if (this.queue.length > 3 * this.fps)
                child.stdout.pause();
        });
        child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
        child.on("error", (error) => {
            if (this.child !== child)
                return;
            this.error = spawnErrorText("ffmpeg", error);
            this.onFrame();
        });
        child.on("close", (code) => {
            if (this.child !== child)
                return;
            this.sourceDone = true;
            if (code !== 0 && this.shown === 0 && this.queue.length === 0)
                this.error ??= stderr.trim().split("\n").pop() || "ffmpeg failed";
        });
        this.timer = setInterval(() => this.tick(), 1000 / this.fps);
    }
    /** Where playback is now, or undefined while the first frame waits for the sound. */
    clipTime(now) {
        if (!this.anchor && now - this.audioStartedAt >= AUDIO_WAIT_MS)
            this.anchor = { position: this.position, at: now };
        return this.anchor ? this.anchor.position + (now - this.anchor.at) / 1000 : undefined;
    }
    tick() {
        if (!this.playing && !this.needFrame)
            return;
        const time = this.playing ? this.clipTime(Date.now()) : undefined;
        if (time === undefined && !this.needFrame)
            return;
        // Frames the clock is already past: keep the newest of them and drop the rest.
        const due = time === undefined ? 0 : Math.floor((time - this.from) * this.fps);
        while (this.shown < due - 1 && this.queue.length > 1) {
            this.queue.shift();
            this.shown++;
        }
        if (time !== undefined && this.shown >= due && !this.needFrame)
            return; // ahead of the sound
        const next = this.queue.shift();
        if (next) {
            if (time !== undefined)
                this.shown++;
            this.position = this.from + this.shown / this.fps;
            if (this.queue.length < this.fps)
                this.child?.stdout.resume();
            // The terminal is still taking earlier frames: skip this one rather than queue behind them.
            if (!this.needFrame && process.stdout.writableLength > BACKLOG_BYTES)
                return;
            this.frameBase64 = next;
            this.needFrame = false;
            this.onFrame();
        }
        else if (this.sourceDone) {
            if (this.loop && this.shown > 0 && !this.error) {
                this.play(0);
            }
            else {
                this.ended = true;
                this.playing = false;
                clearInterval(this.timer);
                this.onFrame();
            }
        }
    }
    toggle() {
        if (this.ended) {
            this.playing = true;
            this.play(0);
        }
        else {
            this.playing = !this.playing;
            this.anchor = undefined;
            if (this.playing)
                this.startAudio(this.position);
            else
                this.stopAudio();
        }
        this.onFrame();
    }
    seek(seconds) {
        this.play(seconds);
    }
    stop() {
        clearInterval(this.timer);
        this.timer = undefined;
        this.child?.kill("SIGKILL");
        this.child = undefined;
        this.stopAudio();
    }
    startAudio(from) {
        this.stopAudio();
        const start = String(Math.max(0, from));
        const input = this.source.audio ?? this.path;
        const inputArgs = this.source.audioArgs ?? [];
        this.audioFrom = Math.max(0, from);
        this.audioClockZero = undefined;
        this.audioStartedAt = Date.now();
        this.statsPartial = "";
        if (this.loop) {
            // A GIF has no sound to follow or to meter.
            this.anchor = { position: this.audioFrom, at: this.audioStartedAt };
            return;
        }
        // -stats makes ffplay print its audio clock a few dozen times a second, also at loglevel quiet.
        const audio = track(spawn("ffplay", [
            "-nodisp", "-autoexit", "-loglevel", "quiet", "-stats", "-ss", start, ...inputArgs, "-i", input,
        ], { stdio: ["ignore", "ignore", "pipe"] }));
        this.audio = audio;
        audio.stderr?.on("data", (chunk) => {
            if (this.audio === audio)
                this.readAudioClock(chunk.toString());
        });
        audio.on("error", () => {
            if (this.audio !== audio)
                return;
            this.audio = undefined;
            // No ffplay: nothing to wait for, the wall clock takes over now.
            if (this.playing && !this.anchor)
                this.anchor = { position: this.position, at: Date.now() };
        });
        audio.on("close", () => {
            if (this.audio !== audio)
                return;
            this.audio = undefined;
            // It ended without ever reporting a clock (no audio stream): do not wait out the timeout.
            if (this.playing && !this.anchor)
                this.anchor = { position: this.position, at: Date.now() };
        });
        // Real-time mono PCM; the level of each short window becomes one column of the wave.
        const meter = track(spawn("ffmpeg", [
            "-v", "error", "-nostdin", "-ss", start, "-re", ...inputArgs, "-i", input, "-vn",
            "-ac", "1", "-ar", String(METER_SAMPLE_RATE), "-f", "s16le", "-",
        ], { stdio: ["ignore", "pipe", "ignore"] }));
        this.audioMeter = meter;
        meter.stdout?.on("data", (chunk) => this.handleMeter(chunk));
        meter.on("error", () => {
            if (this.audioMeter === meter)
                this.audioMeter = undefined;
        });
        meter.on("close", () => {
            if (this.audioMeter === meter)
                this.audioMeter = undefined;
        });
    }
    /** ffplay's status lines are "   2.32 M-A:  0.000 ..." ("nan" until the sound starts), separated
     * by carriage returns. The number is its audio clock; whether it counts from the seek point or
     * from the start of the file depends on the container, so only its change since the first
     * report is used. */
    readAudioClock(text) {
        const lines = (this.statsPartial + text).split(/[\r\n]/);
        this.statsPartial = lines.pop() ?? "";
        const now = Date.now();
        for (const line of lines) {
            const clock = /^\s*(-?\d+(?:\.\d+)?)\s+\S-\S:/.exec(line)?.[1];
            if (clock === undefined)
                continue;
            this.audioClockZero ??= Number(clock);
            if (this.playing)
                this.anchor = { position: this.audioFrom + Number(clock) - this.audioClockZero, at: now };
        }
    }
    handleMeter(chunk) {
        const windowBytes = Math.round(METER_SAMPLE_RATE * METER_WINDOW_SECONDS) * 2;
        let buffer = this.meterPartial.length > 0 ? Buffer.concat([this.meterPartial, chunk]) : chunk;
        let changed = false;
        while (buffer.length >= windowBytes) {
            let sum = 0;
            for (let offset = 0; offset < windowBytes; offset += 2) {
                const sample = buffer.readInt16LE(offset) / 32768;
                sum += sample * sample;
            }
            const rms = Math.sqrt(sum / (windowBytes / 2));
            this.audioLevelDb = rms > 0 ? Math.max(METER_FLOOR_DB, 20 * Math.log10(rms)) : METER_FLOOR_DB;
            this.audioHistory.push(this.audioLevelDb);
            buffer = buffer.subarray(windowBytes);
            changed = true;
        }
        this.meterPartial = Buffer.from(buffer);
        if (this.audioHistory.length > METER_HISTORY)
            this.audioHistory.splice(0, this.audioHistory.length - METER_HISTORY);
        if (changed)
            this.onFrame();
    }
    stopAudio() {
        this.audio?.kill("SIGKILL");
        this.audio = undefined;
        this.audioMeter?.kill("SIGKILL");
        this.audioMeter = undefined;
    }
}
function takePngFrame(buffer) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const start = buffer.indexOf(signature);
    if (start < 0)
        return undefined;
    let offset = start + signature.length;
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
        const next = offset + 12 + length;
        if (next > buffer.length)
            return undefined;
        if (type === "IEND")
            return { png: buffer.subarray(start, next), rest: buffer.subarray(next) };
        offset = next;
    }
    return undefined;
}
/** One column per level in dB, newest on the right. Heights are scaled to the loudest visible
 * window so mastered music, which sits within a few dB, still shows its shape. */
export function audioWave(history, width) {
    if (width <= 0)
        return "";
    const glyphs = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const values = history.slice(-width);
    const top = Math.max(METER_FLOOR_DB + METER_RANGE_DB, ...values);
    const wave = values
        .map((db) => {
        const level = Math.max(0, Math.min(1, (db - (top - METER_RANGE_DB)) / METER_RANGE_DB));
        return glyphs[Math.round(level * (glyphs.length - 1))];
    })
        .join("");
    return " ".repeat(width - values.length) + wave;
}
//# sourceMappingURL=media.js.map