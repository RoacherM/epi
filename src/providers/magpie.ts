import { createHash } from "node:crypto";
import { z } from "zod";
import type { Api, Model, ModelsStoreEntry, Provider, ProviderStreams, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";

type MagpieProtocol = "anthropic" | "responses" | "openai" | "gemini";

const DISCOVERY_TIMEOUT_MS = 2000;
/** Loopback Magpie accepts any key; `/login` stores a real one in auth.json, which takes precedence. */
export const MAGPIE_DEFAULT_KEY = "magpie";

/** Test seam: MMP_TEST_MAGPIE_URL points MMP at a local fake gateway instead of the real one. */
export function magpieBaseUrl(): string {
  return process.env.MMP_TEST_MAGPIE_URL ?? "http://127.0.0.1:3425";
}

const catalogModelSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  magpie_label: z.string().optional(),
  type: z.string().optional(),
  context_window: z.number().int().positive().optional(),
  context_length: z.number().int().positive().optional(),
  max_input_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  modalities: z.object({ input: z.array(z.string()).optional() }).optional(),
  reasoning: z.boolean().optional(),
  supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional(),
  native_endpoints: z.array(z.string()).optional(),
});
const catalogSchema = z.object({
  data: z.array(catalogModelSchema),
  has_more: z.boolean().optional(),
  last_id: z.string().optional(),
});
type CatalogModel = z.infer<typeof catalogModelSchema>;

const protocolApis: Record<MagpieProtocol, Api> = {
  anthropic: "anthropic-messages",
  responses: "openai-responses",
  openai: "openai-completions",
  gemini: "google-generative-ai",
};
const endpointProtocols: Record<string, MagpieProtocol> = {
  "/v1/messages": "anthropic",
  "/v1/responses": "responses",
  "/v1/chat/completions": "openai",
};
const streams: Record<MagpieProtocol, ProviderStreams> = {
  anthropic: anthropicMessagesApi(),
  responses: openAIResponsesApi(),
  openai: openAICompletionsApi(),
  gemini: googleGenerativeAIApi(),
};

function protocolFor(model: CatalogModel): MagpieProtocol {
  for (const endpoint of model.native_endpoints ?? []) {
    const protocol = Object.hasOwn(endpointProtocols, endpoint) ? endpointProtocols[endpoint] : undefined;
    if (protocol) return protocol;
    if (endpoint.startsWith("/v1beta/models/")) return "gemini";
  }
  // These are Magpie gateway routing defaults, not compatibility assumptions about arbitrary APIs.
  if (model.id.includes("claude")) return "anthropic";
  if (model.id.includes("gemini")) return "gemini";
  if (model.id.startsWith("codex/") || model.id.includes("gpt-")) return "responses";
  return "openai";
}

function thinkingMap(model: CatalogModel, protocol: MagpieProtocol): ThinkingLevelMap | undefined {
  const efforts = model.supported_reasoning_levels?.map((entry) => entry.effort);
  if (!efforts?.length) return undefined;
  const map: ThinkingLevelMap = {};
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const effort = level === "minimal" && protocol === "anthropic" ? "low" : level;
    map[level] = efforts.includes(effort) ? effort : null;
  }
  return map;
}

function toModel(model: CatalogModel, baseUrl: string): Model<Api> {
  const protocol = protocolFor(model);
  const input: ("text" | "image")[] = ["text"];
  if (model.modalities?.input?.includes("image")) input.push("image");
  const reasoning = model.reasoning === true;
  const map = thinkingMap(model, protocol);
  return {
    id: model.id,
    provider: "magpie",
    name: model.magpie_label?.trim() || model.display_name?.trim() || model.id,
    api: protocolApis[protocol],
    baseUrl: baseUrl + (protocol === "anthropic" ? "" : protocol === "gemini" ? "/v1beta" : "/v1"),
    input,
    reasoning,
    ...(map ? { thinkingLevelMap: map } : {}),
    // Advertised effort levels distinguish adaptive thinking from older token-budget models.
    ...(protocol === "anthropic" && reasoning && map ? { compat: { forceAdaptiveThinking: true } } : {}),
    contextWindow: model.context_window ?? model.context_length ?? model.max_input_tokens ?? 200000,
    maxTokens: model.max_output_tokens ?? 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export function parseMagpieModels(value: unknown, baseUrl: string): Model<Api>[] {
  const catalog = catalogSchema.safeParse(value);
  if (!catalog.success) throw new Error("Magpie returned an invalid model catalog");
  const ids = new Set<string>();
  return catalog.data.data.filter((model) => !model.type || ["model", "chat"].includes(model.type)).map((model) => {
    if (ids.has(model.id)) throw new Error("Magpie returned duplicate model IDs");
    ids.add(model.id);
    return toModel(model, baseUrl);
  });
}

export async function discoverMagpieModels(
  baseUrl: string,
  signal: AbortSignal,
  apiKey = MAGPIE_DEFAULT_KEY,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<Model<Api>[]> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const entries: CatalogModel[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(`${baseUrl}/v1/models`);
    if (cursor) url.searchParams.set("after_id", cursor);
    const response = await fetch(url, {
      headers: { "x-api-key": apiKey, Authorization: `Bearer ${apiKey}`, "anthropic-version": "2023-06-01" },
      signal: requestSignal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Magpie model discovery failed (HTTP ${response.status})`);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      requestSignal.throwIfAborted();
      throw new Error("Magpie returned invalid catalog JSON");
    }
    const catalog = catalogSchema.safeParse(value);
    if (!catalog.success) throw new Error("Magpie returned an invalid model catalog");
    entries.push(...catalog.data.data);
    if (!catalog.data.has_more) {
      requestSignal.throwIfAborted();
      return parseMagpieModels({ data: entries }, baseUrl);
    }
    cursor = catalog.data.last_id;
    if (!cursor || cursors.has(cursor)) throw new Error("Magpie returned invalid model pagination");
    cursors.add(cursor);
  }
  throw new Error("Magpie model catalog exceeded the pagination limit");
}

function apiStreams(api: Api): ProviderStreams {
  const protocol = (Object.keys(protocolApis) as MagpieProtocol[]).find((key) => protocolApis[key] === api);
  if (!protocol) throw new Error("Unsupported Magpie model API");
  return streams[protocol];
}

type AnthropicBlock = { type: string; id?: string; tool_use_id?: string };
type AnthropicMessage = { role: string; content: string | AnthropicBlock[] };

const blocksOf = (message: AnthropicMessage): AnthropicBlock[] =>
  typeof message.content === "string" ? [{ type: "text" }] : message.content;

/** Anthropic caps tool IDs at 64 characters (pi-ai's normalizeToolCallId fills them up to that
 * for other providers' IDs), so a long ID becomes a hash instead of growing past the cap. */
function renamedToolId(id: string): string {
  const prefixed = `mmp_${id}`;
  return prefixed.length <= 64 ? prefixed : `mmp_${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

/** Magpie's claude/ route continues its own upstream session when a request carries tool IDs it
 * issued, and then forwards only the tool results: a steer message sent after them is dropped
 * (dogfood D74, reproduced on the real gateway; its other routes are fine). Renaming the tool IDs
 * in that one request makes the gateway take the whole request instead. Returns undefined when
 * the request has no user text or image after the last tool call, so other requests go out unchanged. */
export function renameToolIdsAfterSteer(payload: unknown): unknown {
  const messages = (payload as { messages?: AnthropicMessage[] }).messages;
  if (!Array.isArray(messages)) return undefined;
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
  if (lastAssistant < 0 || !blocksOf(messages[lastAssistant]!).some((block) => block.type === "tool_use")) return undefined;
  const steered = messages.slice(lastAssistant + 1)
    .some((message) => blocksOf(message).some((block) => block.type === "text" || block.type === "image"));
  if (!steered) return undefined;
  const rename = (block: AnthropicBlock): AnthropicBlock =>
    block.type === "tool_use" && block.id !== undefined ? { ...block, id: renamedToolId(block.id) }
      : block.type === "tool_result" && block.tool_use_id !== undefined ? { ...block, tool_use_id: renamedToolId(block.tool_use_id) }
        : block;
  return {
    ...(payload as object),
    messages: messages.map((message) =>
      typeof message.content === "string" ? message : { ...message, content: message.content.map(rename) }),
  };
}

/** Applies the gateway workaround before any caller's own onPayload, which still sees the result. */
function withGatewayFixes<T extends { onPayload?: (payload: unknown, model: Model<Api>) => unknown }>(
  model: Model<Api>,
  options: T | undefined,
): T | undefined {
  if (model.api !== "anthropic-messages") return options;
  return {
    ...options,
    onPayload: async (payload: unknown, payloadModel: Model<Api>) => {
      const fixed = renameToolIdsAfterSteer(payload);
      return (await options?.onPayload?.(fixed ?? payload, payloadModel)) ?? fixed;
    },
  } as T;
}

/** The tag also keeps a cache from another gateway address out. */
function cacheTag(baseUrl: string): string {
  return JSON.stringify([baseUrl]);
}

/** The store entry for a fresh catalog, or undefined when the stored one already matches it. */
export function changedCatalogEntry(
  stored: ModelsStoreEntry | undefined,
  baseUrl: string,
  fresh: Model<Api>[],
): ModelsStoreEntry | undefined {
  const tag = cacheTag(baseUrl);
  return stored?.etag === tag && JSON.stringify(stored.models) === JSON.stringify(fresh)
    ? undefined
    : { models: fresh, checkedAt: Date.now(), etag: tag };
}

/** Connection refused: nothing listens at the gateway address. */
function isGatewayAbsent(error: unknown): boolean {
  return error instanceof Error && typeof error.cause === "object" && error.cause !== null &&
    "code" in error.cause && error.cause.code === "ECONNREFUSED";
}

/** Catalog writes still running, so a session shutdown can wait for them: a process that exits
 * while Pi is taking the models-store lock leaves models-store.json.lock behind, and the next mmp
 * waits up to 30 s for it (Fable F5: rpc's background refresh, then the client closes stdin). */
export function createWriteTracker() {
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  return {
    get closed() { return closed; },
    track<T>(write: Promise<T>): Promise<T> {
      pending.add(write);
      void write.then(() => pending.delete(write), () => pending.delete(write));
      return write;
    },
    /** Waits for running writes; refreshes that finish later do not write. */
    async close(): Promise<void> {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
}
export type WriteTracker = ReturnType<typeof createWriteTracker>;

/** What a failed catalog request tells the user; anything else points at the gateway itself. */
function discoveryFailure(error: unknown, baseUrl: string): Error {
  // Kept as the cause: startup says so only when it then fails (src/provider-startup.ts).
  if (isGatewayAbsent(error)) return new Error(`Magpie is not running at ${baseUrl}`, { cause: (error as Error).cause });
  if (error instanceof Error && error.name === "TimeoutError") return new Error("Magpie model discovery timed out");
  if (error instanceof Error && error.message.startsWith("Magpie ")) return error;
  return new Error("Magpie model discovery failed; check that the gateway is running and its key is configured");
}

/** A plain Pi provider (decision MG2): Pi's own refresh brings the catalog in, saves it and
 * restores the saved one; nothing here knows whether a run selected Magpie. */
export function createMagpieProvider(baseUrl: string, writes: WriteTracker = createWriteTracker()): Provider {
  let models: Model<Api>[] = [];
  const cachedModels = (stored: ModelsStoreEntry | undefined): Model<Api>[] =>
    stored?.etag === cacheTag(baseUrl)
      ? stored.models.filter((model): model is Model<Api> => model.provider === "magpie" && (!model.type || model.type === "chat"))
      : [];
  return {
    id: "magpie",
    name: "Magpie",
    baseUrl,
    auth: {
      apiKey: {
        name: "Magpie API key",
        login: async ({ prompt }) => ({ type: "api_key", key: await prompt({ type: "secret", message: "Magpie API key (loopback accepts any value):" }) }),
        resolve: async ({ credential, signal }) => {
          signal.throwIfAborted();
          if (credential === undefined) return { auth: { apiKey: MAGPIE_DEFAULT_KEY }, source: "default key for the local gateway" };
          if (!credential.key) return undefined;
          return { auth: { apiKey: credential.key }, source: "Magpie API key" };
        },
      },
    },
    getModels: () => models,
    refreshModels: async (context) => {
      if (context.stored && !(await context.publish({ update: () => { models = cachedModels(context.stored); } }))) return;
      if (!context.allowNetwork || context.signal.aborted) return;
      const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
      let refreshed: Model<Api>[];
      try {
        refreshed = await discoverMagpieModels(baseUrl, context.signal, apiKey);
      } catch (error) {
        throw discoveryFailure(error, baseUrl);
      }
      if (writes.closed) return;
      const persist = changedCatalogEntry(context.stored, baseUrl, refreshed);
      await writes.track(context.publish({
        ...(persist ? { persist } : {}),
        update: () => { models = refreshed; },
      }));
    },
    stream: (model, context, options) => apiStreams(model.api).stream(model, context, withGatewayFixes(model, options)),
    streamSimple: (model, context, options) => apiStreams(model.api).streamSimple(model, context, withGatewayFixes(model, options)),
  };
}
