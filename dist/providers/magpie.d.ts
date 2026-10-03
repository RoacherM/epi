import type { Api, Model, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
/** Loopback Magpie accepts any key; `/login` stores a real one in auth.json, which takes precedence. */
export declare const MAGPIE_DEFAULT_KEY = "magpie";
/** Test seam: MMP_TEST_MAGPIE_URL points MMP at a local fake gateway instead of the real one. */
export declare function magpieBaseUrl(): string;
export declare function parseMagpieModels(value: unknown, baseUrl: string): Model<Api>[];
export declare function discoverMagpieModels(baseUrl: string, signal: AbortSignal, apiKey?: string, timeoutMs?: number): Promise<Model<Api>[]>;
/** The store entry for a fresh catalog, or undefined when the stored one already matches it. */
export declare function changedCatalogEntry(stored: ModelsStoreEntry | undefined, baseUrl: string, fresh: Model<Api>[]): ModelsStoreEntry | undefined;
/** Native publication lets Pi own persistence, concurrent-refresh generations and diagnostics.
 * A startup catalog is already saved by the caller, so the cache-only refreshes Pi starts while
 * loading never write: Pi supersedes them, and a short run can exit during the detached write. */
export declare function createMagpieProvider(baseUrl: string, initialModels?: Model<Api>[], allowNetwork?: boolean): Provider;
//# sourceMappingURL=magpie.d.ts.map