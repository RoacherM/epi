// `epi auth print-api-key|print-bearer-token|check` (docs/cli-design.md §3), mirroring Pi's own
// `runAuthCommand`/`resolveCredentialForPrint`/`checkProviderAuth` (dist/main.js,
// dist/cli/credential-print.js, dist/cli/auth-check.js -- none of the three are exported) using
// only ModelRuntime and resolveCliModel, which are. Credentials are read from Epi's own agent
// directory: host.ts sets PI_CODING_AGENT_DIR before this runs, so ModelRuntime's default auth/
// models paths already resolve under `~/.epi/pi`, never `~/.pi/agent`.
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";

import { EpiArgumentError } from "../errors.js";

const AUTH_KINDS = ["print-api-key", "print-bearer-token", "check"] as const;
type AuthKind = (typeof AUTH_KINDS)[number];

const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

interface ParsedAuthArgs {
  kind: AuthKind;
  provider?: string;
  model?: string;
  json: boolean;
  credentials: boolean;
  noRefresh: boolean;
  minExpiryMs?: number;
}

interface ModelAuthLike {
  auth: { apiKey?: string; headers?: Record<string, string | null | undefined> };
}

/** Mirrors Pi's getAuthCredential (dist/cli/auth-command.js, not exported): an API key credential
 * carries it directly; an OAuth bearer token is embedded in the resolved Authorization header. */
function extractCredential(auth: ModelAuthLike | undefined): string | undefined {
  if (auth?.auth.apiKey) return auth.auth.apiKey;
  const authorization = Object.entries(auth?.auth.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];
  return typeof authorization === "string" ? /^Bearer\s+(.+)$/i.exec(authorization)?.[1] : undefined;
}

function renderAuthHelp(): string {
  return `Usage:
  epi auth print-api-key --provider <provider> [--model <model>]
  epi auth print-bearer-token --provider <provider> [--model <model>] [--min-expiry <duration>]
  epi auth check --provider <provider> [--model <model>] [--json] [--credentials] [--no-refresh]

Auth commands require at least one of --provider or --model. Checks refresh expired OAuth
credentials by default; --no-refresh prevents this. --credentials emits the credential, or
includes it in JSON output.
`;
}

/** `--min-expiry`'s value (`30m`, `1h`, `500ms`, ...) in milliseconds. */
function parseMinExpiry(value: string | undefined): number {
  const match = value ? /^(\d+)(ms|s|m|h)$/i.exec(value) : undefined;
  if (!match) {
    throw new EpiArgumentError("--min-expiry must use a duration such as 30m or 1h");
  }
  return Number(match[1]) * DURATION_UNIT_MS[match[2]!.toLowerCase()]!;
}

const AUTH_PREFIX_FLAGS = new Set(["-a", "--approve", "-na", "--no-approve", "--no-project"]);
const CHECK_ONLY_FLAGS = new Set(["--json", "--credentials", "--no-refresh"]);

function assertNoConflictingTrustFlags(rawArgv: readonly string[]): void {
  const sawApprove = rawArgv.includes("-a") || rawArgv.includes("--approve");
  const sawNoApprove = rawArgv.includes("-na") || rawArgv.includes("--no-approve");
  if (sawApprove && sawNoApprove) {
    throw new EpiArgumentError("--approve and --no-approve cannot be used together");
  }
}

function parseCheckFlag(
  kind: ParsedAuthArgs["kind"],
  argument: string,
  flags: { json: boolean; credentials: boolean; noRefresh: boolean },
): void {
  if (kind !== "check") {
    throw new EpiArgumentError(`${argument} is only supported by auth check`);
  }
  flags.json ||= argument === "--json";
  flags.credentials ||= argument === "--credentials";
  flags.noRefresh ||= argument === "--no-refresh";
}

function parseMinExpiryArg(kind: ParsedAuthArgs["kind"], value: string | undefined): number {
  if (kind !== "print-bearer-token") {
    throw new EpiArgumentError("--min-expiry is only supported by print-bearer-token");
  }
  return parseMinExpiry(value);
}

function parseAuthOptions(
  kind: ParsedAuthArgs["kind"],
  commandToken: string,
  argv: readonly string[],
): Omit<ParsedAuthArgs, "kind"> {
  let provider: string | undefined;
  let model: string | undefined;
  const checkFlags = { json: false, credentials: false, noRefresh: false };
  let minExpiryMs: number | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--provider") provider = argv[++index];
    else if (argument === "--model") model = argv[++index];
    else if (argument === "--min-expiry") minExpiryMs = parseMinExpiryArg(kind, argv[++index]);
    else if (CHECK_ONLY_FLAGS.has(argument)) parseCheckFlag(kind, argument, checkFlags);
    else throw new EpiArgumentError(`Unknown option ${argument} for epi auth ${commandToken}`);
  }
  if (!provider && !model) {
    throw new EpiArgumentError(`epi auth ${commandToken} requires --provider <provider> or --model <model>`);
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...checkFlags,
    ...(minExpiryMs === undefined ? {} : { minExpiryMs }),
  };
}

function parseAuthArgv(rawArgv: readonly string[]): ParsedAuthArgs {
  assertNoConflictingTrustFlags(rawArgv);
  const argv = rawArgv.filter((arg) => !AUTH_PREFIX_FLAGS.has(arg));
  const commandToken = argv[0];
  const kind = AUTH_KINDS.find((candidate) => candidate === commandToken);
  if (kind === undefined || commandToken === undefined) {
    throw new EpiArgumentError(
      `Unknown auth command ${JSON.stringify(commandToken ?? "")}. Use "epi auth print-api-key", "epi auth print-bearer-token", or "epi auth check".`,
    );
  }
  return { kind, ...parseAuthOptions(kind, commandToken, argv) };
}

type ProviderCandidate = { id: string; model?: ReturnType<typeof resolveCliModel>["model"] };

function resolveExplicitProvider(
  providerName: string,
  modelName: string | undefined,
  modelRuntime: ModelRuntime,
): ProviderCandidate[] {
  const provider = modelRuntime.getProvider(providerName);
  if (!provider) {
    throw new EpiArgumentError(`Unknown provider "${providerName}". Use --list-models to see available providers.`);
  }
  if (!modelName) return [{ id: provider.id }];
  const resolved = resolveCliModel({ cliProvider: provider.id, cliModel: modelName, modelRuntime });
  if (resolved.error || !resolved.model) {
    throw new EpiArgumentError(resolved.error ?? "Unable to resolve the requested provider/model");
  }
  return [{ id: provider.id, model: resolved.model }];
}

function resolveCandidateProviders(
  args: ParsedAuthArgs,
  modelRuntime: ModelRuntime,
  credentialTypes: ReadonlyMap<string, string>,
): ProviderCandidate[] {
  if (args.provider) {
    return resolveExplicitProvider(args.provider, args.model, modelRuntime);
  }
  const cliModelOpt = args.model === undefined ? {} : { cliModel: args.model };
  const matches: ProviderCandidate[] = [];
  for (const provider of modelRuntime.getProviders()) {
    if (!credentialTypes.has(provider.id)) continue;
    const resolved = resolveCliModel({ cliProvider: provider.id, ...cliModelOpt, modelRuntime });
    if (resolved.model && !resolved.error && !resolved.warning?.includes("Using custom model id")) {
      matches.push({ id: provider.id, model: resolved.model });
    }
  }
  if (matches.length === 0) {
    throw new EpiArgumentError(`Model "${args.model}" not found. Use --list-models to see available models.`);
  }
  return matches;
}

function missingCredentialError(
  args: ParsedAuthArgs,
  kind: "api_key" | "bearer_token",
  providerId: string | undefined,
  type: string | undefined,
): EpiArgumentError {
  if (args.provider && kind === "api_key" && type === "oauth") {
    return new EpiArgumentError(`Provider "${providerId}" is configured with OAuth, not an API key`);
  }
  if (args.provider && kind === "bearer_token" && type !== "oauth") {
    return new EpiArgumentError(`Provider "${providerId}" is not configured with an OAuth bearer token`);
  }
  return new EpiArgumentError(`No usable ${kind === "api_key" ? "API key" : "OAuth bearer token"} is configured`);
}

function credentialMatchesKind(kind: "api_key" | "bearer_token", type: string | undefined): boolean {
  return kind === "api_key" ? type !== "oauth" : type === "oauth";
}

/** Mirrors Pi's resolveCredentialForPrint (dist/cli/credential-print.js): pick the provider (and
 * optionally the model), then read its resolved credential of the requested kind. */
async function resolvePrintCredential(
  args: ParsedAuthArgs,
  modelRuntime: ModelRuntime,
  signal: AbortSignal,
): Promise<string> {
  const kind = args.kind === "print-api-key" ? "api_key" : "bearer_token";
  const credentialTypes = new Map(
    (await modelRuntime.listCredentials({ signal })).map((credential) => [credential.providerId, credential.type]),
  );
  const providers = resolveCandidateProviders(args, modelRuntime, credentialTypes);
  const authOptions = {
    ...(kind === "bearer_token" ? { minOAuthValidityMs: args.minExpiryMs ?? 30 * 60_000 } : {}),
    signal,
  };
  const credentials: { providerId: string; value: string }[] = [];
  for (const provider of providers) {
    if (!credentialMatchesKind(kind, credentialTypes.get(provider.id))) continue;
    const auth = provider.model
      ? await modelRuntime.getAuth(provider.model, authOptions)
      : await modelRuntime.getAuth(provider.id, authOptions);
    const value = extractCredential(auth);
    if (value) credentials.push({ providerId: provider.id, value });
  }
  if (credentials.length === 1) return credentials[0]!.value;
  if (credentials.length === 0) {
    const providerId = providers[0]?.id;
    throw missingCredentialError(args, kind, providerId, providerId ? credentialTypes.get(providerId) : undefined);
  }
  throw new EpiArgumentError(
    `Multiple configured providers matched (${credentials.map(({ providerId }) => providerId).join(", ")}). Specify --provider.`,
  );
}

type CheckStatus = "ready" | "not_ready" | "invalid";
interface CheckResult {
  status: CheckStatus;
  provider: string;
  reason?: string;
  authType?: string;
}

/** Mirrors Pi's checkProviderAuth (dist/cli/auth-check.js). */
async function checkProviderAuth(args: ParsedAuthArgs, modelRuntime: ModelRuntime, refresh: boolean): Promise<CheckResult> {
  let provider = args.provider;
  if (args.model) {
    const resolved = resolveCliModel({ ...(args.provider === undefined ? {} : { cliProvider: args.provider }), cliModel: args.model, modelRuntime });
    if (resolved.error || !resolved.model) {
      throw new EpiArgumentError(resolved.error ?? `Unable to resolve model "${args.model}"`);
    }
    provider = resolved.model.provider;
  }
  if (!provider) {
    throw new EpiArgumentError("Unable to resolve an auth provider");
  }
  if (modelRuntime.getError()) {
    return { status: "invalid", provider, reason: "invalid_state" };
  }
  if (!modelRuntime.getProvider(provider)) {
    return { status: "not_ready", provider, reason: "provider_not_found" };
  }
  try {
    const auth = await modelRuntime.checkAuth(provider);
    if (!auth) {
      return { status: "not_ready", provider, reason: "credentials_not_configured" };
    }
    if (refresh && !(await modelRuntime.getAuth(provider))) {
      return { status: "not_ready", provider, reason: "credentials_not_configured" };
    }
    return { status: "ready", provider, authType: auth.type };
  } catch {
    return { status: "invalid", provider, reason: "invalid_state" };
  }
}

export async function runAuthCommand(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(renderAuthHelp());
    return 0;
  }
  const args = parseAuthArgv(argv);
  const signal = AbortSignal.timeout(15_000);

  if (args.kind !== "check") {
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal });
    const credential = await resolvePrintCredential(args, modelRuntime, signal);
    process.stdout.write(`${credential}\n`);
    return 0;
  }

  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal, refreshOnCreate: false });
  let result = await checkProviderAuth(args, modelRuntime, !args.noRefresh);
  let credential: string | undefined;
  if (args.credentials && result.status === "ready") {
    // No exported read-only credential store (Pi's ReadOnlyAuthStorage isn't exported): reading the
    // raw credential here goes through getAuth like the refreshing path does, even under
    // --no-refresh. Documented deviation (see the report).
    credential = extractCredential(await modelRuntime.getAuth(result.provider));
    if (!credential) {
      result = { status: "not_ready", provider: result.provider, reason: "credential_not_available" };
    }
  }
  const output = args.json
    ? JSON.stringify({ ...result, ...(credential ? { credentials: credential } : {}) })
    : (credential ?? result.status);
  process.stdout.write(`${output}\n`);
  return result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
}
