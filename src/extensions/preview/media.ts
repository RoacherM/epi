// Pixels and sound: stills for images, video frames through ffmpeg, Quick Look thumbnails for
// formats the terminal cannot draw, and a player that streams frames at a fixed rate. ffmpeg,
// ffprobe and ffplay are looked up on PATH when a video is opened; nothing here is needed otherwise.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Readable } from "node:stream";

import type { ImageDimensions } from "@earendil-works/pi-tui";

import { piTui } from "../../tui/pi-tui.js";
import { type Entry, kindOf } from "./files.js";

const { getCellDimensions, getImageDimensions } = piTui;

const VIDEO_FPS = 10;
export const SEEK_SECONDS = 5;
const METER_SAMPLE_RATE = 8000;
const METER_WINDOW_SECONDS = 0.05;
const METER_HISTORY = 2000;
const METER_FLOOR_DB = -90;
const METER_RANGE_DB = 12;

export function mediaErrorText(error: unknown): string {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "ffmpeg not found: install ffmpeg to view video";
  return error instanceof Error ? error.message : String(error);
}

export interface Probe {
  width?: number;
  height?: number;
  codec?: string;
  duration?: number;
}

function run(command: string, args: string[], timeoutMs = 20_000): Promise<Buffer> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(Buffer.concat(chunks));
      else reject(new Error(stderr.trim().split("\n").pop() || `${command} exited with ${code}`));
    });
  });
}

export async function probe(path: string): Promise<Probe> {
  const out = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name:format=duration", "-of", "json", path,
  ]);
  const json = JSON.parse(out.toString()) as { streams?: { width?: number; height?: number; codec_name?: string }[]; format?: { duration?: string } };
  const stream = json.streams?.[0];
  const duration = Number(json.format?.duration);
  return {
    ...(stream?.width === undefined ? {} : { width: stream.width }),
    ...(stream?.height === undefined ? {} : { height: stream.height }),
    ...(stream?.codec_name === undefined ? {} : { codec: stream.codec_name }),
    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
  };
}

/** Quick Look thumbnail as PNG bytes for formats the terminal cannot draw directly (PDF/HEIC/etc.). */
async function quickLookPng(path: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "mmp-preview-"));
  try {
    await run("qlmanage", ["-t", "-s", "1024", "-o", dir, path]);
    return readFileSync(join(dir, `${basename(path)}.png`));
  } catch {
    throw new Error("Quick Look has no preview for this file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mimeFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  if (ext === ".avif") return "image/avif";
  return "image/png";
}

export interface Still {
  base64?: string;
  mimeType?: string;
  dimensions?: ImageDimensions;
  info?: Probe;
  error?: string;
}

/** Decoded stills by path, mtime and size. One decode runs at a time; while it runs only the
 * latest request waits, so holding j over a folder of photos does not spawn a process per file. */
export class StillCache {
  private readonly cache = new Map<string, Still>();
  private busy = false;
  private pending: { key: string; job: () => Promise<Still> } | undefined;

  constructor(private readonly onReady: () => void) {}

  get(key: string, job: () => Promise<Still>): Still | undefined {
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.busy) this.pending = { key, job };
    else this.start(key, job);
    return undefined;
  }

  private start(key: string, job: () => Promise<Still>): void {
    this.busy = true;
    void job()
      .catch((error: unknown): Still => ({ error: mediaErrorText(error) }))
      .then((still) => {
        this.cache.set(key, still);
        if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
        this.busy = false;
        const next = this.pending;
        this.pending = undefined;
        if (next && !this.cache.has(next.key)) this.start(next.key, next.job);
        this.onReady();
      });
  }
}

export function stillJob(entry: Entry): () => Promise<Still> {
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

/** Inputs for a stream whose audio lives elsewhere or needs request headers (web video). */
interface PlayerSource {
  audio?: string;
  videoArgs?: string[];
  audioArgs?: string[];
}

/** Streams RGBA frames from ffmpeg and shows them at VIDEO_FPS. Pausing stops taking frames;
 * the pipe's backpressure then stalls ffmpeg, so no signals are needed. */
export class Player {
  frameBase64: string | undefined;
  position = 0;
  playing = true;
  ended = false;
  error: string | undefined;
  imageId: number | undefined;
  audioLevelDb: number | undefined;
  /** RMS level in dB of each METER_WINDOW_SECONDS of audio, oldest first. */
  audioHistory: number[] = [];

  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private audio: ReturnType<typeof spawn> | undefined;
  private audioMeter: ReturnType<typeof spawn> | undefined;
  private meterPartial = Buffer.alloc(0);
  private queue: string[] = [];
  private partial = Buffer.alloc(0);
  private timer: NodeJS.Timeout | undefined;
  private from = 0;
  private shown = 0;
  private sourceDone = false;
  private needFrame = true;

  constructor(
    private readonly path: string,
    readonly width: number,
    readonly height: number,
    private readonly loop: boolean,
    private readonly onFrame: () => void,
    private readonly source: PlayerSource = {},
  ) {}

  play(from: number): void {
    this.stop();
    this.from = Math.max(0, from);
    this.position = this.from;
    this.shown = 0;
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
    const maxWidthPx = Math.max(16, Math.floor(this.width * cell.widthPx));
    const maxHeightPx = Math.max(16, Math.floor(this.height * cell.heightPx));
    const vf = `fps=${VIDEO_FPS},scale=w='min(${maxWidthPx},iw)':h='min(${maxHeightPx},ih)':force_original_aspect_ratio=decrease`;
    const child = spawn("ffmpeg", [
      "-v", "error", "-nostdin", "-ss", String(this.from), ...(this.source.videoArgs ?? []), "-i", this.path, "-an",
      "-vf", vf,
      "-f", "image2pipe", "-vcodec", "png", "-compression_level", "3", "-",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    if (this.playing) this.startAudio(this.from);
    child.stdout.on("data", (chunk: Buffer) => {
      let buffer = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk;
      while (true) {
        const frame = takePngFrame(buffer);
        if (!frame) break;
        this.queue.push(frame.png.toString("base64"));
        buffer = frame.rest;
      }
      this.partial = Buffer.from(buffer);
      if (this.queue.length > 3 * VIDEO_FPS) child.stdout.pause();
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.error = mediaErrorText(error);
      this.onFrame();
    });
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.sourceDone = true;
      if (code !== 0 && this.shown === 0 && this.queue.length === 0) this.error ??= stderr.trim().split("\n").pop() || "ffmpeg failed";
    });
    this.timer = setInterval(() => this.tick(), 1000 / VIDEO_FPS);
  }

  private tick(): void {
    if (!this.playing && !this.needFrame) return;
    const next = this.queue.shift();
    if (next) {
      this.frameBase64 = next;
      this.needFrame = false;
      if (this.playing) this.shown++;
      this.position = this.from + this.shown / VIDEO_FPS;
      if (this.queue.length < VIDEO_FPS) this.child?.stdout.resume();
      this.onFrame();
    } else if (this.sourceDone) {
      if (this.loop && this.shown > 0 && !this.error) {
        this.play(0);
      } else {
        this.ended = true;
        this.playing = false;
        clearInterval(this.timer);
        this.onFrame();
      }
    }
  }

  toggle(): void {
    if (this.ended) {
      this.playing = true;
      this.play(0);
    } else {
      this.playing = !this.playing;
      if (this.playing) this.startAudio(this.position);
      else this.stopAudio();
    }
    this.onFrame();
  }

  seek(seconds: number): void {
    this.play(seconds);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.child?.kill("SIGKILL");
    this.child = undefined;
    this.stopAudio();
  }

  private startAudio(from: number): void {
    this.stopAudio();
    const start = String(Math.max(0, from));
    const input = this.source.audio ?? this.path;
    const inputArgs = this.source.audioArgs ?? [];
    const audio = spawn("ffplay", [
      "-nodisp", "-autoexit", "-loglevel", "quiet", "-ss", start, ...inputArgs, "-i", input,
    ], { stdio: "ignore" });
    this.audio = audio;
    audio.on("error", () => {
      if (this.audio === audio) this.audio = undefined;
    });
    audio.on("close", () => {
      if (this.audio === audio) this.audio = undefined;
    });

    // Real-time mono PCM; the level of each short window becomes one column of the wave.
    const meter = spawn("ffmpeg", [
      "-v", "error", "-nostdin", "-ss", start, "-re", ...inputArgs, "-i", input, "-vn",
      "-ac", "1", "-ar", String(METER_SAMPLE_RATE), "-f", "s16le", "-",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    this.audioMeter = meter;
    meter.stdout?.on("data", (chunk: Buffer) => this.handleMeter(chunk));
    meter.on("error", () => {
      if (this.audioMeter === meter) this.audioMeter = undefined;
    });
    meter.on("close", () => {
      if (this.audioMeter === meter) this.audioMeter = undefined;
    });
  }

  private handleMeter(chunk: Buffer): void {
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
    if (this.audioHistory.length > METER_HISTORY) this.audioHistory.splice(0, this.audioHistory.length - METER_HISTORY);
    if (changed) this.onFrame();
  }

  private stopAudio(): void {
    this.audio?.kill("SIGKILL");
    this.audio = undefined;
    this.audioMeter?.kill("SIGKILL");
    this.audioMeter = undefined;
  }
}

function takePngFrame(buffer: Buffer): { png: Buffer; rest: Buffer } | undefined {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const start = buffer.indexOf(signature);
  if (start < 0) return undefined;
  let offset = start + signature.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const next = offset + 12 + length;
    if (next > buffer.length) return undefined;
    if (type === "IEND") return { png: buffer.subarray(start, next), rest: buffer.subarray(next) };
    offset = next;
  }
  return undefined;
}

/** One column per level in dB, newest on the right. Heights are scaled to the loudest visible
 * window so mastered music, which sits within a few dB, still shows its shape. */
export function audioWave(history: number[], width: number): string {
  if (width <= 0) return "";
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
