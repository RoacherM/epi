import type { Api, Model, Provider } from "@earendil-works/pi-ai";
/** Test seam: EPI_TEST_MAGPIE_URL points Epi at a local fake gateway instead of the real one. */
export declare function magpieBaseUrl(): string;
export declare function parseMagpieModels(value: unknown, baseUrl: string): Model<Api>[];
export declare function discoverMagpieModels(baseUrl: string, signal: AbortSignal, apiKey?: string, timeoutMs?: number): Promise<Model<Api>[]>;
/** Magpie's claude/ route continues its own upstream session when a request carries tool IDs it
 * issued, and then forwards only the tool results: a steer message sent after them is dropped
 * (dogfood D74, reproduced on the real gateway; its other routes are fine). Renaming the tool IDs
 * in that one request makes the gateway take the whole request instead. Returns undefined when
 * the request has no user text or image after the last tool call, so other requests go out unchanged. */
export declare function renameToolIdsAfterSteer(payload: unknown): unknown;
/** Catalog writes still running, so a session shutdown can wait for them: a process that exits
 * while Pi is taking the models-store lock leaves models-store.json.lock behind, and the next epi
 * waits up to 30 s for it (Fable F5: rpc's background refresh, then the client closes stdin). */
export declare function createWriteTracker(): {
    readonly closed: boolean;
    track<T>(write: Promise<T>): Promise<T>;
    /** Waits for running writes; refreshes that finish later do not write. */
    close(): Promise<void>;
};
type WriteTracker = ReturnType<typeof createWriteTracker>;
/** A plain Pi provider (decision MG2): Pi's own refresh brings the catalog in, saves it and
 * restores the saved one; nothing here knows whether a run selected Magpie. */
export declare function createMagpieProvider(baseUrl: string, writes?: WriteTracker): Provider;
export {};
//# sourceMappingURL=magpie.d.ts.map