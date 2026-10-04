import type { ImageDimensions } from "@earendil-works/pi-tui";
import { type Entry } from "./files.js";
export declare const SEEK_SECONDS = 5;
export declare function mediaErrorText(error: unknown): string;
export interface Probe {
    width?: number;
    height?: number;
    codec?: string;
    duration?: number;
}
export declare function probe(path: string): Promise<Probe>;
export interface Still {
    base64?: string;
    mimeType?: string;
    dimensions?: ImageDimensions;
    info?: Probe;
    error?: string;
}
/** Decoded stills by path, mtime and size. One decode runs at a time; while it runs only the
 * latest request waits, so holding j over a folder of photos does not spawn a process per file. */
export declare class StillCache {
    private readonly onReady;
    private readonly cache;
    private busy;
    private pending;
    constructor(onReady: () => void);
    get(key: string, job: () => Promise<Still>): Still | undefined;
    private start;
}
export declare function stillJob(entry: Entry): () => Promise<Still>;
/** Inputs for a stream whose audio lives elsewhere or needs request headers (web video). */
interface PlayerSource {
    audio?: string;
    videoArgs?: string[];
    audioArgs?: string[];
}
/** Streams PNG frames from ffmpeg and shows them at VIDEO_FPS, by the clock: a frame that is late
 * (a slow redraw, a busy terminal) is dropped, so the picture stays with the sound instead of
 * falling behind it. Pausing stops taking frames; the pipe's backpressure then stalls ffmpeg, so
 * no signals are needed. */
export declare class Player {
    private readonly path;
    readonly width: number;
    readonly height: number;
    private readonly loop;
    private readonly onFrame;
    private readonly source;
    frameBase64: string | undefined;
    position: number;
    playing: boolean;
    ended: boolean;
    error: string | undefined;
    imageId: number | undefined;
    audioLevelDb: number | undefined;
    /** RMS level in dB of each METER_WINDOW_SECONDS of audio, oldest first. */
    audioHistory: number[];
    private child;
    private audio;
    private audioMeter;
    private meterPartial;
    private queue;
    private partial;
    private timer;
    private from;
    /** Frames taken from the queue since `from`, drawn or dropped. */
    private shown;
    /** Time spent playing since `from`, and when it was last added to. */
    private playedMs;
    private lastTick;
    private sourceDone;
    private needFrame;
    constructor(path: string, width: number, height: number, loop: boolean, onFrame: () => void, source?: PlayerSource);
    play(from: number): void;
    private tick;
    toggle(): void;
    seek(seconds: number): void;
    stop(): void;
    private startAudio;
    private handleMeter;
    private stopAudio;
}
/** One column per level in dB, newest on the right. Heights are scaled to the loudest visible
 * window so mastered music, which sits within a few dB, still shows its shape. */
export declare function audioWave(history: number[], width: number): string;
export {};
//# sourceMappingURL=media.d.ts.map