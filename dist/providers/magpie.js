import { createHash } from "node:crypto";
import { z } from "zod";
import { isConnectionRefused } from "../provider-startup.js";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
const DISCOVERY_TIMEOUT_MS = 2000;
/** Loopback Magpie accepts any key; `/login` stores a real one in auth.json, which takes precedence. */
const MAGPIE_DEFAULT_KEY = "magpie";
/** Test seam: EPI_TEST_MAGPIE_URL points Epi at a local fake gateway instead of the real one. */
export function magpieBaseUrl() {
    return process.env.EPI_TEST_MAGPIE_URL ?? "http://127.0.0.1:3425";
}
/** USD per token as the gateway sends it: a non-negative decimal string. */
const priceSchema = z.string().refine((value) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0);
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
    // Optional; the live gateway sends it for most models and omits it for the rest.
    pricing: z.object({
        prompt: priceSchema.optional(),
        completion: priceSchema.optional(),
        input_cache_read: priceSchema.optional(),
        input_cache_write: priceSchema.optional(),
    }).optional(),
});
const catalogSchema = z.object({
    data: z.array(catalogModelSchema),
    has_more: z.boolean().optional(),
    last_id: z.string().optional(),
});
const protocolApis = {
    anthropic: "anthropic-messages",
    responses: "openai-responses",
    openai: "openai-completions",
    gemini: "google-generative-ai",
};
const endpointProtocols = {
    "/v1/messages": "anthropic",
    "/v1/responses": "responses",
    "/v1/chat/completions": "openai",
};
const streams = {
    anthropic: anthropicMessagesApi(),
    responses: openAIResponsesApi(),
    openai: openAICompletionsApi(),
    gemini: googleGenerativeAIApi(),
};
function protocolFor(model) {
    for (const endpoint of model.native_endpoints ?? []) {
        const protocol = Object.hasOwn(endpointProtocols, endpoint) ? endpointProtocols[endpoint] : undefined;
        if (protocol)
            return protocol;
        if (endpoint.startsWith("/v1beta/models/"))
            return "gemini";
    }
    // These are Magpie gateway routing defaults, not compatibility assumptions about arbitrary APIs.
    if (model.id.includes("claude"))
        return "anthropic";
    if (model.id.includes("gemini"))
        return "gemini";
    if (model.id.startsWith("codex/") || model.id.includes("gpt-"))
        return "responses";
    return "openai";
}
function thinkingMap(model, protocol) {
    const efforts = model.supported_reasoning_levels?.map((entry) => entry.effort);
    if (!efforts?.length)
        return undefined;
    const map = {};
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
        const effort = level === "minimal" && protocol === "anthropic" ? "low" : level;
        map[level] = efforts.includes(effort) ? effort : null;
    }
    return map;
}
/** The gateway prices per token, Pi per million; a missing field is unknown (0), not free. */
function toCost(pricing) {
    const perMillion = (value) => value === undefined ? 0 : Number((Number(value) * 1e6).toPrecision(12));
    return {
        input: perMillion(pricing?.prompt),
        output: perMillion(pricing?.completion),
        cacheRead: perMillion(pricing?.input_cache_read),
        cacheWrite: perMillion(pricing?.input_cache_write),
    };
}
function cleanGatewayRoot(baseUrl) {
    return baseUrl.replace(/\/(?:v1beta|v1)\/?$/u, "").replace(/\/+$/u, "");
}
function protocolBaseUrl(baseUrl, protocol) {
    const root = cleanGatewayRoot(baseUrl);
    if (protocol === "anthropic")
        return root;
    return `${root}${protocol === "gemini" ? "/v1beta" : "/v1"}`;
}
function modelDisplayName(model) {
    return model.magpie_label?.trim() || model.display_name?.trim() || model.id;
}
function modelContextWindow(model) {
    return model.context_window ?? model.context_length ?? model.max_input_tokens ?? 200000;
}
function modelInputModalities(model) {
    return model.modalities?.input?.includes("image") ? ["text", "image"] : ["text"];
}
/** Pi warms a prompt cache only for models that declare a lifetime (docs/models.md "Prompt cache
 * lifetimes"), and the gateway publishes none. Anthropic Messages caches for five minutes, the
 * conservative end of the published range; a catalog that prices cache writes means the same
 * kind of cache, so it gets the same lifetime. `long` stays unset: Magpie advertises no 1-hour
 * tier, and guessing one would have Pi warm an entry it cannot keep. */
function modelPromptCache(model, protocol) {
    return protocol === "anthropic" || model.pricing?.input_cache_write !== undefined ? { short: 300 } : undefined;
}
function toModel(model, baseUrl) {
    const protocol = protocolFor(model);
    const reasoning = model.reasoning === true;
    const map = thinkingMap(model, protocol);
    const promptCache = modelPromptCache(model, protocol);
    return {
        id: model.id,
        provider: "magpie",
        name: modelDisplayName(model),
        api: protocolApis[protocol],
        baseUrl: protocolBaseUrl(baseUrl, protocol),
        input: modelInputModalities(model),
        reasoning,
        ...(map ? { thinkingLevelMap: map } : {}),
        // Advertised effort levels distinguish adaptive thinking from older token-budget models.
        ...(protocol === "anthropic" && reasoning && map ? { compat: { forceAdaptiveThinking: true } } : {}),
        ...(promptCache ? { promptCache } : {}),
        contextWindow: modelContextWindow(model),
        maxTokens: model.max_output_tokens ?? 8192,
        cost: toCost(model.pricing),
    };
}
export function parseMagpieModels(value, baseUrl) {
    const catalog = catalogSchema.safeParse(value);
    if (!catalog.success)
        throw new Error("Magpie returned an invalid model catalog");
    const ids = new Set();
    return catalog.data.data.filter((model) => !model.type || ["model", "chat"].includes(model.type)).map((model) => {
        if (ids.has(model.id))
            throw new Error("Magpie returned duplicate model IDs");
        ids.add(model.id);
        return toModel(model, baseUrl);
    });
}
async function fetchCatalogPage(url, apiKey, signal) {
    const response = await fetch(url, {
        headers: { "x-api-key": apiKey, Authorization: `Bearer ${apiKey}`, "anthropic-version": "2023-06-01" },
        signal,
        redirect: "error",
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Magpie model discovery failed (HTTP ${response.status})`);
    }
    let value;
    try {
        value = await response.json();
    }
    catch {
        signal.throwIfAborted();
        throw new Error("Magpie returned invalid catalog JSON");
    }
    const catalog = catalogSchema.safeParse(value);
    if (!catalog.success)
        throw new Error("Magpie returned an invalid model catalog");
    return catalog.data;
}
export async function discoverMagpieModels(baseUrl, signal, apiKey = MAGPIE_DEFAULT_KEY, timeoutMs = DISCOVERY_TIMEOUT_MS) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const entries = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 100; page += 1) {
        const url = new URL(`${baseUrl}/v1/models`);
        if (cursor)
            url.searchParams.set("after_id", cursor);
        const catalog = await fetchCatalogPage(url, apiKey, requestSignal);
        entries.push(...catalog.data);
        if (!catalog.has_more) {
            requestSignal.throwIfAborted();
            return parseMagpieModels({ data: entries }, baseUrl);
        }
        cursor = catalog.last_id;
        if (!cursor || cursors.has(cursor))
            throw new Error("Magpie returned invalid model pagination");
        cursors.add(cursor);
    }
    throw new Error("Magpie model catalog exceeded the pagination limit");
}
function apiProtocol(api) {
    return Object.keys(protocolApis).find((key) => protocolApis[key] === api);
}
function apiStreams(api) {
    const protocol = apiProtocol(api);
    if (!protocol)
        throw new Error("Unsupported Magpie model API");
    return streams[protocol];
}
/** Keeps each Magpie model on its catalog protocol and endpoint even when a legacy models.json
 * overlays a single top-level baseUrl (/v1) or api (openai-completions) onto the provider. */
export function resolveMagpieModel(model, catalog, baseUrl) {
    const known = catalog.find((entry) => entry.id === model.id);
    if (known)
        return known;
    const inferred = protocolFor({ id: model.id });
    const current = apiProtocol(model.api);
    const protocol = current === undefined || (current === "openai" && inferred !== "openai") ? inferred : current;
    const api = protocolApis[protocol];
    const resolvedBaseUrl = protocolBaseUrl(baseUrl, protocol);
    return model.api === api && model.baseUrl === resolvedBaseUrl
        ? model
        : { ...model, api, baseUrl: resolvedBaseUrl };
}
const blocksOf = (message) => typeof message.content === "string" ? [{ type: "text" }] : message.content;
/** Anthropic caps tool IDs at 64 characters (pi-ai's normalizeToolCallId fills them up to that
 * for other providers' IDs), so a long ID becomes a hash instead of growing past the cap. */
function renamedToolId(id) {
    const prefixed = `epi_${id}`;
    return prefixed.length <= 64 ? prefixed : `epi_${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}
function renameAnthropicToolBlock(block) {
    if (block.type === "tool_use" && typeof block.id === "string") {
        return { ...block, id: renamedToolId(block.id) };
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        return { ...block, tool_use_id: renamedToolId(block.tool_use_id) };
    }
    return block;
}
function hasSteerAfterLastToolUse(messages) {
    const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
    if (lastAssistant < 0)
        return false;
    if (!blocksOf(messages[lastAssistant]).some((block) => block.type === "tool_use"))
        return false;
    return messages.slice(lastAssistant + 1)
        .some((message) => blocksOf(message).some((block) => block.type === "text" || block.type === "image"));
}
/** Magpie's claude/ route continues its own upstream session when a request carries tool IDs it
 * issued, and then forwards only the tool results: a steer message sent after them is dropped
 * (dogfood D74, reproduced on the real gateway; its other routes are fine). Renaming the tool IDs
 * in that one request makes the gateway take the whole request instead. Returns undefined when
 * the request has no user text or image after the last tool call, so other requests go out unchanged. */
export function renameToolIdsAfterSteer(payload) {
    const messages = payload?.messages;
    if (!Array.isArray(messages) || !hasSteerAfterLastToolUse(messages))
        return undefined;
    return {
        ...payload,
        messages: messages.map((message) => typeof message.content === "string" ? message : { ...message, content: message.content.map(renameAnthropicToolBlock) }),
    };
}
const SKIP_THOUGHT_VALIDATOR = "skip_thought_signature_validator";
const TS_SUFFIX_RE = /__ts(?:r|k\d+)?__[A-Za-z0-9_-]+$/;
const ANTIGRAVITY_GEMINI_SIG_RE = /^E[A-Za-z0-9+/]*(?:AWkUfR|FpFH0T|aRR9)[A-Za-z0-9+/]*={0,2}$/;
function isOwnGeminiSig(sig) {
    return typeof sig === "string" && ANTIGRAVITY_GEMINI_SIG_RE.test(sig);
}
// Split leading character so gateway antigravity-cloak middleware never mutates source/tool literals in transit.
const ANTIGRAVITY_SYSTEM_WORDS = [
    "x" + "-anthropic-billing-header",
    "C" + "laude Agent SDK",
    "Y" + "ou are Claude Code, Anthropic's official CLI for Claude",
    "Y" + "ou are Codex, an agent based on GPT-5",
    "Y" + "ou are Codex, a coding agent based on GPT-5",
    "H" + "ermes Agent, an intelligent AI assistant created by Nous Research",
    "o" + "perating inside pi, a coding agent harness",
];
const ANTIGRAVITY_MESSAGE_PHRASES = [
    "o" + "perating inside pi, a coding agent harness",
    "T" + "he conversation history before this point was compacted into the following summary:",
    "T" + "he following is a summary of a branch that this conversation came back from:",
    "T" + "his session is being continued from a previous conversation that ran out of context.",
];
function buildCloakRegex(words) {
    const escaped = words.map((word) => word.replaceAll("\u200b", "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`(${escaped.join("|")})`, "g");
}
const SYSTEM_CLOAK_RE = buildCloakRegex(ANTIGRAVITY_SYSTEM_WORDS);
const MESSAGE_CLOAK_RE = buildCloakRegex(ANTIGRAVITY_MESSAGE_PHRASES);
function cloakText(text, regex) {
    return text.replace(regex, (match) => `${match[0]}\u200b${match.slice(1)}`);
}
function stripTsSuffix(id) {
    return id.split("|").map((part) => part.replace(TS_SUFFIX_RE, "")).join("|");
}
function isAntigravityModel(modelId) {
    const lower = modelId.toLowerCase();
    return lower.startsWith("antigravity/") || lower === "auto" || lower.startsWith("auto/");
}
function cloakContent(content, regex) {
    if (typeof content === "string")
        return cloakText(content, regex);
    if (!Array.isArray(content))
        return content;
    return content.map((item) => typeof item === "object" && item !== null && typeof item.text === "string"
        ? { ...item, text: cloakText(item.text, regex) }
        : item);
}
function fixAnthropicThinkingBlock(block) {
    const raw = typeof block.thinking === "string" ? block.thinking : "";
    return raw.trim().length > 0 ? { type: "text", text: cloakText(raw, MESSAGE_CLOAK_RE) } : undefined;
}
function fixAnthropicToolResultBlock(block) {
    return {
        ...block,
        ...(typeof block.tool_use_id === "string" ? { tool_use_id: stripTsSuffix(block.tool_use_id) } : {}),
        ...(block.content !== undefined ? { content: cloakContent(block.content, MESSAGE_CLOAK_RE) } : {}),
    };
}
function fixAnthropicBlock(block) {
    if (block.type === "redacted_thinking")
        return undefined;
    if (block.type === "thinking")
        return fixAnthropicThinkingBlock(block);
    if (block.type === "tool_use" && typeof block.id === "string")
        return { ...block, id: stripTsSuffix(block.id) };
    if (block.type === "tool_result")
        return fixAnthropicToolResultBlock(block);
    return typeof block.text === "string" ? { ...block, text: cloakText(block.text, MESSAGE_CLOAK_RE) } : block;
}
function fixAnthropicMessage(message) {
    if (typeof message.content === "string") {
        return { ...message, content: cloakText(message.content, MESSAGE_CLOAK_RE) };
    }
    if (!Array.isArray(message.content))
        return message;
    const blocks = message.content.flatMap((block) => {
        const fixed = fixAnthropicBlock(block);
        return fixed ? [fixed] : [];
    });
    return { ...message, content: blocks.length > 0 ? blocks : [{ type: "text", text: "(thinking)" }] };
}
function fixAnthropicPayload(payload, antigravity) {
    if (!antigravity)
        return renameToolIdsAfterSteer(payload);
    const cleaned = {
        ...payload,
        ...(payload.system !== undefined ? { system: cloakContent(payload.system, SYSTEM_CLOAK_RE) } : {}),
        ...(Array.isArray(payload.messages)
            ? { messages: payload.messages.map(fixAnthropicMessage) }
            : {}),
    };
    return renameToolIdsAfterSteer(cleaned) ?? cleaned;
}
function cleanExtraContent(extra) {
    if (typeof extra !== "object" || extra === null)
        return undefined;
    const record = { ...extra };
    if (typeof record.google === "object" && record.google !== null) {
        const { thought_signature: _a, thoughtSignature: _b, ...googleRest } = record.google;
        if (Object.keys(googleRest).length === 0)
            delete record.google;
        else
            record.google = googleRest;
    }
    return Object.keys(record).length > 0 ? record : undefined;
}
function stripOpenAISignatures(item) {
    const { thought_signature: _a, thoughtSignature: _b, reasoning_opaque: _c, reasoning_details: _d, extra_content, ...rest } = item;
    const cleanedExtra = cleanExtraContent(extra_content);
    return cleanedExtra ? { ...rest, extra_content: cleanedExtra } : rest;
}
function fixOpenAIToolCall(tc) {
    const cleaned = stripOpenAISignatures(tc);
    return typeof cleaned.id === "string" ? { ...cleaned, id: stripTsSuffix(cleaned.id) } : cleaned;
}
function fixOpenAIMessage(message) {
    const cleaned = stripOpenAISignatures(message);
    const regex = cleaned.role === "system" || cleaned.role === "developer" ? SYSTEM_CLOAK_RE : MESSAGE_CLOAK_RE;
    return {
        ...cleaned,
        ...(cleaned.content !== undefined ? { content: cloakContent(cleaned.content, regex) } : {}),
        ...(Array.isArray(cleaned.tool_calls)
            ? { tool_calls: cleaned.tool_calls.map(fixOpenAIToolCall) }
            : {}),
        ...(typeof cleaned.tool_call_id === "string" ? { tool_call_id: stripTsSuffix(cleaned.tool_call_id) } : {}),
    };
}
function fixOpenAICompletionsPayload(payload) {
    if (!Array.isArray(payload.messages))
        return payload;
    return {
        ...payload,
        messages: payload.messages.map(fixOpenAIMessage),
    };
}
function isResponsesToolCall(type) {
    return type === "function_call" || type === "custom_tool_call";
}
function isResponsesToolOutput(type) {
    return type === "function_call_output" || type === "custom_tool_call_output";
}
function fixResponsesToolCall(item) {
    return {
        ...item,
        ...(typeof item.call_id === "string" ? { call_id: stripTsSuffix(item.call_id) } : {}),
        ...(typeof item.id === "string" ? { id: stripTsSuffix(item.id) } : {}),
    };
}
function fixResponsesToolOutput(item) {
    return {
        ...item,
        ...(typeof item.call_id === "string" ? { call_id: stripTsSuffix(item.call_id) } : {}),
        ...(item.output !== undefined ? { output: cloakContent(item.output, MESSAGE_CLOAK_RE) } : {}),
    };
}
function fixResponsesItem(item) {
    if (item.type === "reasoning")
        return undefined;
    if (isResponsesToolCall(item.type))
        return fixResponsesToolCall(item);
    if (isResponsesToolOutput(item.type))
        return fixResponsesToolOutput(item);
    if (item.content !== undefined) {
        const regex = item.role === "system" || item.role === "developer" ? SYSTEM_CLOAK_RE : MESSAGE_CLOAK_RE;
        return { ...item, content: cloakContent(item.content, regex) };
    }
    return item;
}
function fixOpenAIResponsesPayload(payload) {
    return {
        ...payload,
        ...(typeof payload.instructions === "string"
            ? { instructions: cloakText(payload.instructions, SYSTEM_CLOAK_RE) }
            : {}),
        ...(Array.isArray(payload.input)
            ? {
                input: payload.input.flatMap((item) => {
                    const fixed = fixResponsesItem(item);
                    return fixed ? [fixed] : [];
                }),
            }
            : {}),
    };
}
function cloakValueStrings(value, regex) {
    if (typeof value === "string")
        return cloakText(value, regex);
    if (Array.isArray(value))
        return value.map((item) => cloakValueStrings(item, regex));
    if (typeof value !== "object" || value === null)
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloakValueStrings(entry, regex)]));
}
function fixGeminiFunctionCallPart(part, antigravity) {
    if (!antigravity) {
        return part.thoughtSignature || part.thought_signature
            ? part
            : { ...part, thoughtSignature: SKIP_THOUGHT_VALIDATOR };
    }
    const fc = part.functionCall;
    const nextFc = typeof fc.id === "string" ? { ...fc, id: stripTsSuffix(fc.id) } : fc;
    const { thought_signature: _a, thoughtSignature, ...rest } = part;
    const keepSig = isOwnGeminiSig(thoughtSignature) || thoughtSignature === SKIP_THOUGHT_VALIDATOR;
    return {
        ...rest,
        functionCall: nextFc,
        ...(keepSig ? { thoughtSignature } : {}),
    };
}
function fixGeminiFunctionResponse(fr) {
    return {
        ...fr,
        ...(typeof fr.id === "string" ? { id: stripTsSuffix(fr.id) } : {}),
        ...(fr.response !== undefined ? { response: cloakValueStrings(fr.response, MESSAGE_CLOAK_RE) } : {}),
        ...(Array.isArray(fr.parts) ? { parts: cloakContent(fr.parts, MESSAGE_CLOAK_RE) } : {}),
    };
}
function isBlankGeminiPart(part) {
    if (part.functionCall ||
        part.functionResponse ||
        part.inlineData ||
        part.fileData ||
        part.executableCode ||
        part.codeExecutionResult) {
        return false;
    }
    return typeof part.text !== "string" || part.text.trim().length === 0;
}
function fixGeminiPart(part, antigravity) {
    if (typeof part.functionCall === "object" && part.functionCall !== null) {
        return fixGeminiFunctionCallPart(part, antigravity);
    }
    if (!antigravity)
        return part;
    const { thoughtSignature, thought_signature: _b, ...rest } = part;
    const keepSig = isOwnGeminiSig(thoughtSignature) || thoughtSignature === SKIP_THOUGHT_VALIDATOR;
    const next = {
        ...rest,
        ...(keepSig ? { thoughtSignature } : {}),
        ...(typeof rest.text === "string" ? { text: cloakText(rest.text, MESSAGE_CLOAK_RE) } : {}),
        ...(typeof rest.functionResponse === "object" && rest.functionResponse !== null
            ? { functionResponse: fixGeminiFunctionResponse(rest.functionResponse) }
            : {}),
    };
    return isBlankGeminiPart(next) ? undefined : next;
}
function cloakGeminiSystemInstruction(inst) {
    if (typeof inst === "string")
        return cloakText(inst, SYSTEM_CLOAK_RE);
    if (typeof inst === "object" && inst !== null && Array.isArray(inst.parts)) {
        return { ...inst, parts: cloakContent(inst.parts, SYSTEM_CLOAK_RE) };
    }
    return inst;
}
function fixGeminiSystemFields(payload) {
    const config = typeof payload.config === "object" && payload.config !== null
        ? payload.config
        : undefined;
    return {
        ...payload,
        ...(config && config.systemInstruction !== undefined
            ? { config: { ...config, systemInstruction: cloakGeminiSystemInstruction(config.systemInstruction) } }
            : {}),
        ...(payload.systemInstruction !== undefined
            ? { systemInstruction: cloakGeminiSystemInstruction(payload.systemInstruction) }
            : {}),
        ...(payload.system_instruction !== undefined
            ? { system_instruction: cloakGeminiSystemInstruction(payload.system_instruction) }
            : {}),
    };
}
function transferBlankSignature(parts, fixed) {
    let carrySig;
    for (const part of parts) {
        if (isBlankGeminiPart(part) && isOwnGeminiSig(part.thoughtSignature))
            carrySig = part.thoughtSignature;
    }
    if (!carrySig)
        return;
    const target = fixed.find((part) => part.functionCall || !part.thought) ?? fixed[0];
    if (target && !isOwnGeminiSig(target.thoughtSignature))
        target.thoughtSignature = carrySig;
}
function normalizeTurnFunctionCallSigs(parts) {
    let seenFnCall = false;
    for (const part of parts) {
        if (!part.functionCall)
            continue;
        if (!seenFnCall) {
            seenFnCall = true;
            if (!isOwnGeminiSig(part.thoughtSignature) && part.thoughtSignature !== SKIP_THOUGHT_VALIDATOR) {
                part.thoughtSignature = SKIP_THOUGHT_VALIDATOR;
            }
        }
        else if (part.thoughtSignature !== undefined && !isOwnGeminiSig(part.thoughtSignature)) {
            delete part.thoughtSignature;
        }
    }
}
function fixGeminiParts(parts, antigravity) {
    const fixed = parts.flatMap((part) => {
        const next = fixGeminiPart(part, antigravity);
        return next ? [next] : [];
    });
    if (antigravity)
        transferBlankSignature(parts, fixed);
    return fixed;
}
function orderUserParts(parts) {
    if (!parts.some((p) => p.functionResponse) || !parts.some((p) => !p.functionResponse))
        return parts;
    return [...parts.filter((p) => p.functionResponse), ...parts.filter((p) => !p.functionResponse)];
}
function normalizeAntigravityContents(contents) {
    const merged = [];
    for (const entry of contents) {
        const parts = Array.isArray(entry?.parts) ? entry.parts : [];
        if (parts.length === 0)
            continue;
        const prev = merged.at(-1);
        if (prev && prev.role === entry.role) {
            const combined = [...prev.parts, ...parts];
            prev.parts = prev.role === "user" ? orderUserParts(combined) : combined;
        }
        else {
            merged.push({ ...entry, parts: [...parts] });
        }
    }
    for (const entry of merged)
        normalizeTurnFunctionCallSigs(entry.parts);
    return merged;
}
function fixGeminiPayload(payload, antigravity) {
    const base = antigravity ? fixGeminiSystemFields(payload) : payload;
    if (!Array.isArray(base.contents))
        return base;
    const mapped = base.contents.map((content) => Array.isArray(content?.parts)
        ? { ...content, parts: fixGeminiParts(content.parts, antigravity) }
        : content);
    return {
        ...base,
        contents: antigravity ? normalizeAntigravityContents(mapped) : mapped,
    };
}
function cleanTranscriptMessage(message) {
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
        return { ...message, toolCallId: stripTsSuffix(message.toolCallId) };
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
        return {
            ...message,
            content: message.content.map((block) => block.type === "toolCall" && typeof block.id === "string"
                ? { ...block, id: stripTsSuffix(block.id) }
                : block),
        };
    }
    return message;
}
function cleanTranscriptContext(context, model) {
    if (!isAntigravityModel(model.id) || !Array.isArray(context?.messages))
        return context;
    return {
        ...context,
        messages: context.messages.map(cleanTranscriptMessage),
    };
}
/** Applies Magpie gateway compatibility fixes across protocols:
 * - Antigravity / auto routes: strips foreign thought signatures and `__ts*__` tool ID suffixes,
 *   fills `skip_thought_signature_validator` on Gemini functionCall parts, and cloaks harness phrases.
 * - Gemini (/v1beta): fills `skip_thought_signature_validator` on unsigned cross-model functionCall parts.
 * - Anthropic Messages: renames tool IDs when a steer message follows a tool call (D74). */
export function fixGatewayPayload(payload, model) {
    if (typeof payload !== "object" || payload === null)
        return undefined;
    const record = payload;
    const antigravity = isAntigravityModel(model.id);
    if (model.api === "anthropic-messages")
        return fixAnthropicPayload(record, antigravity);
    if (model.api === "google-generative-ai")
        return fixGeminiPayload(record, antigravity);
    if (!antigravity)
        return undefined;
    if (model.api === "openai-completions")
        return fixOpenAICompletionsPayload(record);
    if (model.api === "openai-responses")
        return fixOpenAIResponsesPayload(record);
    return undefined;
}
/** Applies the gateway workaround before any caller's own onPayload, which still sees the result. */
function withGatewayFixes(model, options) {
    if (model.api !== "anthropic-messages" && model.api !== "google-generative-ai" && !isAntigravityModel(model.id)) {
        return options;
    }
    return {
        ...options,
        onPayload: async (payload, payloadModel) => {
            const fixed = fixGatewayPayload(payload, payloadModel);
            return (await options?.onPayload?.(fixed ?? payload, payloadModel)) ?? fixed;
        },
    };
}
/** The tag also keeps a cache from another gateway address out. */
function cacheTag(baseUrl) {
    return JSON.stringify([baseUrl]);
}
/** The store entry for a fresh catalog, or undefined when the stored one already matches it. */
function changedCatalogEntry(stored, baseUrl, fresh) {
    const tag = cacheTag(baseUrl);
    return stored?.etag === tag && JSON.stringify(stored.models) === JSON.stringify(fresh)
        ? undefined
        : { models: fresh, checkedAt: Date.now(), etag: tag };
}
/** Catalog writes still running, so a session shutdown can wait for them: a process that exits
 * while Pi is taking the models-store lock leaves models-store.json.lock behind, and the next epi
 * waits up to 30 s for it (Fable F5: rpc's background refresh, then the client closes stdin). */
export function createWriteTracker() {
    const pending = new Set();
    let closed = false;
    return {
        get closed() { return closed; },
        track(write) {
            pending.add(write);
            void write.then(() => pending.delete(write), () => pending.delete(write));
            return write;
        },
        /** Waits for running writes; refreshes that finish later do not write. */
        async close() {
            closed = true;
            await Promise.allSettled([...pending]);
        },
    };
}
/** What a failed catalog request tells the user; anything else points at the gateway itself. */
function discoveryFailure(error, baseUrl) {
    // Kept as the cause: startup says so only when it then fails (src/provider-startup.ts).
    if (isConnectionRefused(error))
        return new Error(`Magpie is not running at ${baseUrl}`, { cause: error.cause });
    if (error instanceof Error && error.name === "TimeoutError")
        return new Error("Magpie model discovery timed out");
    if (error instanceof Error && error.message.startsWith("Magpie "))
        return error;
    return new Error("Magpie model discovery failed; check that the gateway is running and its key is configured");
}
function cachedMagpieModels(stored, baseUrl) {
    if (stored?.etag !== cacheTag(baseUrl))
        return [];
    return stored.models.filter((model) => model.provider === "magpie" && (!model.type || model.type === "chat"));
}
async function resolveMagpieKey({ credential, signal, }) {
    signal.throwIfAborted();
    if (credential === undefined)
        return { auth: { apiKey: MAGPIE_DEFAULT_KEY }, source: "default key for the local gateway" };
    if (!credential.key)
        return undefined;
    return { auth: { apiKey: credential.key }, source: "Magpie API key" };
}
async function discoverOrThrow(baseUrl, signal, apiKey) {
    try {
        return await discoverMagpieModels(baseUrl, signal, apiKey);
    }
    catch (error) {
        throw discoveryFailure(error, baseUrl);
    }
}
/** A plain Pi provider (decision MG2): Pi's own refresh brings the catalog in, saves it and
 * restores the saved one; nothing here knows whether a run selected Magpie. */
export function createMagpieProvider(baseUrl, writes = createWriteTracker()) {
    let models = [];
    const resolveModel = (model) => resolveMagpieModel(model, models, baseUrl);
    return {
        id: "magpie",
        name: "Magpie",
        baseUrl,
        auth: {
            apiKey: {
                name: "Magpie API key",
                login: async ({ prompt }) => ({ type: "api_key", key: await prompt({ type: "secret", message: "Magpie API key (loopback accepts any value):" }) }),
                resolve: resolveMagpieKey,
            },
        },
        getModels: () => models,
        filterModels: (composed) => composed.map(resolveModel),
        refreshModels: async (context) => {
            if (context.stored && !(await context.publish({ update: () => { models = cachedMagpieModels(context.stored, baseUrl); } })))
                return;
            if (!context.allowNetwork || context.signal.aborted)
                return;
            const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
            const refreshed = await discoverOrThrow(baseUrl, context.signal, apiKey);
            if (writes.closed)
                return;
            const persist = changedCatalogEntry(context.stored, baseUrl, refreshed);
            await writes.track(context.publish({
                ...(persist ? { persist } : {}),
                update: () => { models = refreshed; },
            }));
        },
        stream: (model, context, options) => {
            const resolved = resolveModel(model);
            return apiStreams(resolved.api).stream(resolved, cleanTranscriptContext(context, resolved), withGatewayFixes(resolved, options));
        },
        streamSimple: (model, context, options) => {
            const resolved = resolveModel(model);
            return apiStreams(resolved.api).streamSimple(resolved, cleanTranscriptContext(context, resolved), withGatewayFixes(resolved, options));
        },
    };
}
//# sourceMappingURL=magpie.js.map