import type { ImageDimensions } from "@earendil-works/pi-tui";
import { type Entry } from "./files.js";
export declare const SEEK_SECONDS = 5;
export declare function stopMediaProcesses(): void;
export interface Probe {
    width?: number;
    height?: number;
    codec?: string;
    duration?: number;
    /** Frames per second of the video stream. */
    fps?: number;
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
    /** The source's frame rate (ffprobe); DEFAULT_FPS when unknown. */
    fps?: number;
    audio?: string;
    videoArgs?: string[];
    audioArgs?: string[];
}
/** Streams PNG frames from ffmpeg and shows them at the source's frame rate, following the sound:
 * ffplay reports where its audio is (`-stats`), and the frame for that moment is drawn. A frame
 * that is late (a slow redraw, a busy terminal) is dropped, so the picture never falls behind.
 * Until the sound starts the first frame waits; without sound the wall clock is used. Pausing
 * stops taking frames; the pipe's backpressure then stalls ffmpeg, so no signals are needed. */
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
    private readonly fps;
    /** A position in the clip known at a wall-clock time: the last one ffplay reported, or where the
     * wall clock took over. Undefined while waiting for the sound to start, and while paused. */
    private anchor;
    /** Where this audio run started in the clip, ffplay's first reported clock, and when it was started. */
    private audioFrom;
    private audioClockZero;
    private audioStartedAt;
    private statsPartial;
    private sourceDone;
    private needFrame;
    constructor(path: string, width: number, height: number, loop: boolean, onFrame: () => void, source?: PlayerSource);
    play(from: number): void;
    /** Where playback is now, or undefined while the first frame waits for the sound. */
    private clipTime;
    private tick;
    toggle(): void;
    seek(seconds: number): void;
    stop(): void;
    private startAudio;
    /** ffplay's status lines are "   2.32 M-A:  0.000 ..." ("nan" until the sound starts), separated
     * by carriage returns. The number is its audio clock; whether it counts from the seek point or
     * from the start of the file depends on the container, so only its change since the first
     * report is used. */
    private readAudioClock;
    private handleMeter;
    private stopAudio;
}
/** One column per level in dB, newest on the right. Heights are scaled to the loudest visible
 * window so mastered music, which sits within a few dB, still shows its shape. */
export declare function audioWave(history: number[], width: number): string;
export {};
//# sourceMappingURL=media.d.ts.map