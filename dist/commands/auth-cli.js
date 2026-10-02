// `mmp auth print-api-key|print-bearer-token|check` (docs/cli-design.md §3), mirroring Pi's own
// `runAuthCommand`/`resolveCredentialForPrint`/`checkProviderAuth` (dist/main.js,
// dist/cli/credential-print.js, dist/cli/auth-check.js -- none of the three are exported) using
// only ModelRuntime and resolveCliModel, which are. Credentials are read from MMP's own agent
// directory: host.ts sets PI_CODING_AGENT_DIR before this runs, so ModelRuntime's default auth/
// models paths already resolve under `~/.mmp/pi`, never `~/.pi/agent`.
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { MmpArgumentError } from "../errors.js";
const AUTH_KINDS = ["print-api-key", "print-bearer-token", "check"];
const DURATION_UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
/** Mirrors Pi's getAuthCredential (dist/cli/auth-command.js, not exported): an API key credential
 * carries it directly; an OAuth bearer token is embedded in the resolved Authorization header. */
function extractCredential(auth) {
    if (auth?.auth.apiKey)
        return auth.auth.apiKey;
    const authorization = Object.entries(auth?.auth.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
    return typeof authorization === "string" ? /^Bearer\s+(.+)$/i.exec(authorization)?.[1] : undefined;
}
function renderAuthHelp() {
    return `Usage:
  mmp auth print-api-key --provider <provider> [--model <model>]
  mmp auth print-bearer-token --provider <provider> [--model <model>] [--min-expiry <duration>]
  mmp auth check --provider <provider> [--model <model>] [--json] [--credentials] [--no-refresh]

Auth commands require at least one of --provider or --model. Checks refresh expired OAuth
credentials by default; --no-refresh prevents this. --credentials emits the credential, or
includes it in JSON output.
`;
}
/** `--min-expiry`'s value (`30m`, `1h`, `500ms`, ...) in milliseconds. */
function parseMinExpiry(value) {
    const match = value ? /^(\d+)(ms|s|m|h)$/i.exec(value) : undefined;
    if (!match) {
        throw new MmpArgumentError("--min-expiry must use a duration such as 30m or 1h");
    }
    return Number(match[1]) * DURATION_UNIT_MS[match[2].toLowerCase()];
}
function parseAuthArgv(argv) {
    const commandToken = argv[0];
    const kind = AUTH_KINDS.find((candidate) => candidate === commandToken);
    if (kind === undefined) {
        throw new MmpArgumentError(`Unknown auth command ${JSON.stringify(commandToken ?? "")}. Use "mmp auth print-api-key", "mmp auth print-bearer-token", or "mmp auth check".`);
    }
    let provider;
    let model;
    let json = false;
    let credentials = false;
    let noRefresh = false;
    let minExpiryMs;
    for (let index = 1; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--provider") {
            provider = argv[++index];
            continue;
        }
        if (argument === "--model") {
            model = argv[++index];
            continue;
        }
        if (argument === "--min-expiry") {
            if (kind !== "print-bearer-token") {
                throw new MmpArgumentError("--min-expiry is only supported by print-bearer-token");
            }
            minExpiryMs = parseMinExpiry(argv[++index]);
            continue;
        }
        if (argument === "--json" || argument === "--credentials" || argument === "--no-refresh") {
            if (kind !== "check") {
                throw new MmpArgumentError(`${argument} is only supported by auth check`);
            }
            if (argument === "--json")
                json = true;
            else if (argument === "--credentials")
                credentials = true;
            else
                noRefresh = true;
            continue;
        }
        throw new MmpArgumentError(`Unknown option ${argument} for mmp auth ${commandToken}`);
    }
    if (!provider && !model) {
        throw new MmpArgumentError(`mmp auth ${commandToken} requires --provider <provider> or --model <model>`);
    }
    return {
        kind,
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        json,
        credentials,
        noRefresh,
        ...(minExpiryMs === undefined ? {} : { minExpiryMs }),
    };
}
/** Mirrors Pi's resolveCredentialForPrint (dist/cli/credential-print.js): pick the provider (and
 * optionally the model), then read its resolved credential of the requested kind. */
async function resolvePrintCredential(args, modelRuntime, signal) {
    const kind = args.kind === "print-api-key" ? "api_key" : "bearer_token";
    const credentialTypes = new Map((await modelRuntime.listCredentials({ signal })).map((credential) => [credential.providerId, credential.type]));
    // `Model<Api>` isn't exported by pi-coding-agent; resolveCliModel's own return type carries it,
    // and getAuth's model overload accepts it structurally, so an inferred/loose type is enough here.
    const providers = [];
    if (args.provider) {
        const provider = modelRuntime.getProvider(args.provider);
        if (!provider) {
            throw new MmpArgumentError(`Unknown provider "${args.provider}". Use --list-models to see available providers.`);
        }
        if (args.model) {
            const resolved = resolveCliModel({ cliProvider: provider.id, cliModel: args.model, modelRuntime });
            if (resolved.error || !resolved.model) {
                throw new MmpArgumentError(resolved.error ?? "Unable to resolve the requested provider/model");
            }
            providers.push({ id: provider.id, model: resolved.model });
        }
        else {
            providers.push({ id: provider.id });
        }
    }
    else {
        for (const provider of modelRuntime.getProviders()) {
            if (!credentialTypes.has(provider.id))
                continue;
            const resolved = resolveCliModel({ cliProvider: provider.id, ...(args.model === undefined ? {} : { cliModel: args.model }), modelRuntime });
            if (resolved.model && !resolved.error && !resolved.warning?.includes("Using custom model id")) {
                providers.push({ id: provider.id, model: resolved.model });
            }
        }
        if (providers.length === 0) {
            throw new MmpArgumentError(`Model "${args.model}" not found. Use --list-models to see available models.`);
        }
    }
    const credentials = [];
    for (const provider of providers) {
        const type = credentialTypes.get(provider.id);
        if (kind === "api_key" && type === "oauth")
            continue;
        if (kind === "bearer_token" && type !== "oauth")
            continue;
        const authOptions = {
            ...(kind === "bearer_token" ? { minOAuthValidityMs: args.minExpiryMs ?? 30 * 60_000 } : {}),
            signal,
        };
        const auth = provider.model
            ? await modelRuntime.getAuth(provider.model, authOptions)
            : await modelRuntime.getAuth(provider.id, authOptions);
        const value = extractCredential(auth);
        if (value)
            credentials.push({ providerId: provider.id, value });
    }
    if (credentials.length === 1)
        return credentials[0].value;
    if (credentials.length === 0) {
        const providerId = providers[0]?.id;
        const type = providerId ? credentialTypes.get(providerId) : undefined;
        if (args.provider && kind === "api_key" && type === "oauth") {
            throw new MmpArgumentError(`Provider "${providerId}" is configured with OAuth, not an API key`);
        }
        if (args.provider && kind === "bearer_token" && type !== "oauth") {
            throw new MmpArgumentError(`Provider "${providerId}" is not configured with an OAuth bearer token`);
        }
        throw new MmpArgumentError(`No usable ${kind === "api_key" ? "API key" : "OAuth bearer token"} is configured`);
    }
    throw new MmpArgumentError(`Multiple configured providers matched (${credentials.map(({ providerId }) => providerId).join(", ")}). Specify --provider.`);
}
/** Mirrors Pi's checkProviderAuth (dist/cli/auth-check.js). */
async function checkProviderAuth(args, modelRuntime, refresh) {
    let provider = args.provider;
    if (args.model) {
        const resolved = resolveCliModel({ ...(args.provider === undefined ? {} : { cliProvider: args.provider }), cliModel: args.model, modelRuntime });
        if (resolved.error || !resolved.model) {
            throw new MmpArgumentError(resolved.error ?? `Unable to resolve model "${args.model}"`);
        }
        provider = resolved.model.provider;
    }
    if (!provider) {
        throw new MmpArgumentError("Unable to resolve an auth provider");
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
    }
    catch {
        return { status: "invalid", provider, reason: "invalid_state" };
    }
}
export async function runAuthCommand(argv) {
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
    let credential;
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
//# sourceMappingURL=auth-cli.js.map