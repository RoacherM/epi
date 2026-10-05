// A local, offline MCP Streamable HTTP server behind OAuth, for `epi mcp login/logout` tests
// (test/mcp-cli.test.mjs). One HTTP server plays both parts, the way pi-mcp's discovery
// (@earendil-works/pi-mcp's oauth/discovery.js) finds them with no protected resource metadata: the
// authorization server is the origin, with RFC 8414 metadata, dynamic client registration, an
// authorization endpoint that redirects straight back with a code (the "browser" is a plain fetch
// in the test), and a token endpoint. Every code exchanged issues a new access token, so a test can
// tell which sign-in a stored token came from.
//
// POST /mcp answers initialize and tools/list (one tool, "whoami") when the bearer token is one it
// issued, and 401 otherwise; notifications get 202 and GET (the server-to-client stream) 405.
import { createServer } from "node:http";

function readBody(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

export async function startOAuthMcpServer() {
  const issuedTokens = [];
  let codes = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, 200, {
        issuer: `${origin}/`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register" && request.method === "POST") {
      const metadata = JSON.parse(await readBody(request));
      json(response, 201, { client_id: `client-${Date.now()}`, redirect_uris: metadata.redirect_uris ?? [] });
      return;
    }
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", `code-${++codes}`);
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: redirect.href });
      response.end();
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const params = new URLSearchParams(await readBody(request));
      if (params.get("grant_type") !== "authorization_code") {
        json(response, 400, { error: "invalid_grant" });
        return;
      }
      const token = `token-${params.get("code")}`;
      issuedTokens.push(token);
      json(response, 200, { access_token: token, token_type: "Bearer" });
      return;
    }
    if (url.pathname === "/mcp") {
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      if (!token || !issuedTokens.includes(token)) {
        await readBody(request);
        json(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      if (request.method === "GET") {
        response.writeHead(405);
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(200);
        response.end();
        return;
      }
      const message = JSON.parse(await readBody(request));
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      const result =
        message.method === "initialize"
          ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "oauth-fixture", version: "1.0.0" } }
          : message.method === "tools/list"
            ? { tools: [{ name: "whoami", description: "Returns the caller's token.", inputSchema: { type: "object", properties: {} } }] }
            : undefined;
      if (result === undefined) {
        json(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
      } else {
        json(response, 200, { jsonrpc: "2.0", id: message.id, result });
      }
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/mcp`,
    issuedTokens,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
