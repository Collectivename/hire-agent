import { randomUUID } from "node:crypto";
import { AgentsError } from "../errors";
import { assertPublicDns, blockedHost } from "../public-url";
import { now } from "../workspace";
import { listServers, readSecret, removeServer, saveServer, writeSecret } from "./persist";
import type { McpSecret, McpServer, McpTool } from "./types";

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROTOCOL = "2025-03-26";
const HEADER = /^[A-Za-z0-9-]{1,40}$/;
const BANNED_HEADERS = new Set([
  "host",
  "content-type",
  "content-length",
  "connection",
  "transfer-encoding",
  "cookie",
  "set-cookie",
  "mcp-session-id",
  "accept",
  "accept-encoding",
  "location",
  "upgrade",
]);
const states = new Map<string, { platformId: string; name: string; expiresAt: number }>();

type RpcBody = { id?: unknown; result?: unknown; error?: { message?: string } };

export function assertServerName(value: string): string {
  const name = value.trim();
  if (!NAME.test(name)) throw new AgentsError("INVALID_PARAMS", "An MCP server name is lowercase letters, numbers, and dashes.", 400);
  return name;
}

export function headerNameOf(value: string): string {
  const name = value.trim();
  if (!HEADER.test(name) || BANNED_HEADERS.has(name.toLowerCase())) {
    throw new AgentsError("INVALID_PARAMS", "That MCP header name is not allowed.", 400);
  }
  return name;
}

/**
 * Remote MCP is Streamable HTTP on a public https host.
 * Loopback http is accepted only outside production so the runtime check can
 * stand up a server. Redirects are not followed: a public host must not bounce
 * the client at an internal address. Credentials belong in sealed storage.
 */
export async function assertServerUrl(value: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AgentsError("INVALID_PARAMS", "An MCP server needs an https URL.", 400);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AgentsError("INVALID_PARAMS", "An MCP URL cannot carry a credential.", 400);
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost";
  if (loopback) {
    if (process.env.NODE_ENV === "production" || url.protocol !== "http:") {
      throw new AgentsError("INVALID_PARAMS", "An MCP server needs a public https URL.", 400);
    }
    return url.toString();
  }
  if (url.protocol !== "https:" || blockedHost(host)) {
    throw new AgentsError("INVALID_PARAMS", "An MCP server needs a public https URL.", 400);
  }
  try {
    await assertPublicDns(url.toString());
  } catch (error) {
    if (error instanceof AgentsError && error.code === "ENDPOINT_UNPROVED") {
      throw new AgentsError("INVALID_PARAMS", "The MCP host did not resolve.", 400);
    }
    if (error instanceof AgentsError) {
      throw new AgentsError("INVALID_PARAMS", "An MCP server needs a public https URL.", 400);
    }
    throw error;
  }
  return url.toString();
}

export function mcpRedirectUri(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (raw) {
    try {
      const origin = new URL(raw.includes("://") ? raw : `https://${raw}`).origin;
      return `${origin}/api/agents/v1/mcp/callback`;
    } catch {
      // A bad site URL falls through to the development callback.
    }
  }
  if (process.env.NODE_ENV === "production") {
    throw new AgentsError("NOT_READY", "The public site URL is not configured.", 503);
  }
  return "http://localhost:3000/api/agents/v1/mcp/callback";
}

function blank(platformId: string, name: string, url: string): McpServer {
  return {
    platformId,
    name,
    description: "",
    url,
    transport: "streamable-http",
    auth: "none",
    headerName: "Authorization",
    enabled: true,
    approval: "auto",
    instructions: "",
    tools: [],
    sessionId: "",
    status: "new",
    lastError: "",
    authorizeUrl: "",
    tokenUrl: "",
    revokeUrl: "",
    clientId: "",
    redirectUri: "",
    scopes: "",
    updatedAt: now(),
  };
}

function redact(text: string, secret: McpSecret | null): string {
  let clean = text;
  for (const value of [secret?.bearer, secret?.headerValue, secret?.oauthClient, secret?.access, secret?.refresh]) {
    if (value && value.length > 8) clean = clean.split(value).join("[redacted]");
  }
  return clean.slice(0, 2_000);
}

function sessionHeader(value: string): string {
  return /^[\x21-\x7E]{1,200}$/.test(value) ? value : "";
}

function rpcMessage(text: string, id: number): RpcBody | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = trimmed.startsWith("{")
    ? [trimmed]
    : trimmed
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line && line !== "[DONE]");
  for (const source of [...candidates].reverse()) {
    try {
      const parsed = JSON.parse(source) as RpcBody;
      if (parsed && String(parsed.id) === String(id)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

async function postRpc(
  server: McpServer,
  secret: McpSecret | null,
  method: string,
  params: unknown,
  notify = false
): Promise<{ status: number; sessionId: string; body: RpcBody | null }> {
  await assertServerUrl(server.url);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const sessionId = sessionHeader(server.sessionId);
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const access = secret?.access || secret?.bearer;
  if ((server.auth === "bearer" || server.auth === "oauth") && access) headers.authorization = `Bearer ${access}`;
  else if (server.auth === "header" && secret?.headerValue) headers[headerNameOf(server.headerName || "Authorization")] = secret.headerValue;
  const id = Math.floor(Math.random() * 1_000_000_000) + 1;
  const payload = notify ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", id, method, params };
  const response = await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status >= 300 && response.status < 400) {
    return { status: response.status, sessionId: "", body: null };
  }
  const text = await response.text();
  const returned = sessionHeader(response.headers.get("mcp-session-id") ?? "");
  return {
    status: response.status,
    sessionId: returned || sessionId,
    body: notify ? null : rpcMessage(text, id),
  };
}

function toolsFrom(result: unknown, approval: McpServer["approval"]): McpTool[] {
  const listed = (result as { tools?: unknown })?.tools;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { name?: unknown; description?: unknown; inputSchema?: unknown };
    if (typeof row.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(row.name)) return [];
    const schema = row.inputSchema && typeof row.inputSchema === "object" ? (row.inputSchema as Record<string, unknown>) : { type: "object" };
    const encoded = JSON.stringify(schema);
    return [
      {
        name: row.name,
        description: typeof row.description === "string" ? row.description.slice(0, 400) : "",
        inputSchema: encoded.length > 4_000 ? { type: "object" } : schema,
        enabled: true,
        approval,
      },
    ];
  });
}

function toolText(result: unknown, secret: McpSecret | null): string {
  if (!result || typeof result !== "object") return "The MCP tool returned nothing.";
  const row = result as { content?: unknown; isError?: unknown; text?: unknown };
  const parts = Array.isArray(row.content)
    ? row.content.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? [text] : [];
      })
    : [];
  const text = parts.join("\n") || (typeof row.text === "string" ? row.text : JSON.stringify(result));
  const clean = redact(text, secret).slice(0, 4_000);
  return row.isError === true ? `The MCP tool reported a failure.\n${clean}` : clean;
}

async function tokenRequest(url: string, body: URLSearchParams): Promise<{ access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null> {
  await assertServerUrl(url);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok || (response.status >= 300 && response.status < 400)) return null;
  return (await response.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null;
}

async function freshAccess(server: McpServer, secret: McpSecret | null): Promise<McpSecret | null> {
  if (server.auth !== "oauth" || !secret?.refresh || !server.tokenUrl) return secret;
  if (secret.expiresAt && secret.expiresAt > now() + 30_000) return secret;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: secret.refresh,
    client_id: server.clientId,
  });
  if (secret.oauthClient) body.set("client_secret", secret.oauthClient);
  const json = await tokenRequest(server.tokenUrl, body);
  if (typeof json?.access_token !== "string") {
    throw new AgentsError("PROVIDER_UNAVAILABLE", "The MCP OAuth token could not be refreshed.", 502);
  }
  const next: McpSecret = {
    ...secret,
    access: json.access_token,
    refresh: typeof json.refresh_token === "string" ? json.refresh_token : secret.refresh,
    expiresAt: now() + (typeof json.expires_in === "number" ? json.expires_in * 1000 : 3_600_000),
  };
  await writeSecret(server.platformId, server.name, next);
  return next;
}

function failed(server: McpServer, lastError: string): McpServer {
  return { ...server, status: "error", lastError: lastError.slice(0, 200), sessionId: "", updatedAt: now() };
}

async function openServer(server: McpServer): Promise<McpServer> {
  const secret = await freshAccess(server, await readSecret(server.platformId, server.name));
  if ((server.auth === "bearer" || server.auth === "header" || server.auth === "oauth") && !secret) {
    throw new AgentsError("NOT_READY", "Connect the credential before opening this MCP server.", 409);
  }
  const opened = await postRpc(server, secret, "initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "collective-hire", version: "1.0.0" },
  });
  if (opened.status === 401) return failed(server, "authentication refused");
  if (opened.status >= 300 || !opened.body?.result) return failed(server, "The MCP server did not initialize.");
  const info = opened.body.result as { protocolVersion?: unknown; instructions?: unknown };
  if (info.protocolVersion !== PROTOCOL) return failed(server, "The MCP server speaks a protocol this runtime does not.");
  const session = { ...server, sessionId: opened.sessionId };
  await postRpc(session, secret, "notifications/initialized", {}, true);
  const collected: McpTool[] = [];
  let cursor = "";
  const seen = new Set<string>();
  for (let page = 0; page < 4 && collected.length < 32; page += 1) {
    const listed = await postRpc(session, secret, "tools/list", cursor ? { cursor } : {});
    if (listed.status >= 300 || listed.body?.error || !listed.body?.result) return failed(server, "The MCP server did not list its tools.");
    collected.push(...toolsFrom(listed.body.result, server.approval));
    const next = (listed.body.result as { nextCursor?: unknown }).nextCursor;
    if (typeof next !== "string" || !next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  const previous = new Map(server.tools.map((tool) => [tool.name, tool]));
  const tools = collected.slice(0, 32).map((tool) => {
    const kept = previous.get(tool.name);
    return kept ? { ...tool, enabled: kept.enabled, approval: kept.approval } : tool;
  });
  return {
    ...session,
    instructions: redact(typeof info.instructions === "string" ? info.instructions : "", secret),
    tools,
    status: "connected",
    lastError: "",
    updatedAt: now(),
  };
}

export async function connectServer(server: McpServer): Promise<McpServer> {
  try {
    const connected = await openServer(server);
    await saveServer(connected);
    return connected;
  } catch (error) {
    if (error instanceof AgentsError && (error.status === 503 || error.status === 409)) throw error;
    const lastError = error instanceof AgentsError ? error.message : "The MCP server could not be reached.";
    const saved = failed(server, lastError);
    await saveServer(saved);
    return saved;
  }
}

export async function callServerTool(server: McpServer, tool: string, args: Record<string, unknown>): Promise<string> {
  const allowed = server.tools.find((item) => item.name === tool);
  if (!server.enabled || server.status === "disabled" || !allowed?.enabled) {
    return `Tool ${tool} is disabled.`;
  }
  if ((allowed.approval ?? server.approval) === "prompt") return `Tool ${tool} needs the owner's approval.`;
  const required = allowed.inputSchema.required;
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && (args[key] == null || args[key] === "")) return `Tool ${tool} is missing ${key}.`;
    }
  }
  try {
    let secret = await freshAccess(server, await readSecret(server.platformId, server.name));
    let current = server.sessionId ? server : await connectServer(server);
    if (current.status !== "connected") return current.lastError || "The MCP server is not connected.";
    let response = await postRpc(current, secret, "tools/call", { name: tool, arguments: args });
    if (response.status >= 300 || response.body?.error || !response.body?.result) {
      current = await connectServer({ ...current, sessionId: "" });
      if (current.status !== "connected") return current.lastError || "The MCP server is not connected.";
      secret = (await readSecret(server.platformId, server.name)) ?? secret;
      response = await postRpc(current, secret, "tools/call", { name: tool, arguments: args });
    }
    if (response.body?.error) return `The MCP tool failed. ${redact(response.body.error.message ?? "", secret)}`.trim();
    if (response.status >= 300 || !response.body?.result) return "The MCP tool call failed.";
    return toolText(response.body.result, secret);
  } catch (error) {
    if (error instanceof AgentsError && error.status === 503) throw error;
    return error instanceof AgentsError ? error.message : "The MCP tool call failed.";
  }
}

export async function saveMcpConfig(
  platformId: string,
  input: {
    name: string;
    url: string;
    description?: string;
    auth?: McpServer["auth"];
    headerName?: string;
    bearer?: string;
    headerValue?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    revokeUrl?: string;
    clientId?: string;
    oauthClient?: string;
    scopes?: string;
  }
): Promise<McpServer> {
  const name = assertServerName(input.name);
  const url = await assertServerUrl(input.url);
  const existing = (await listServers(platformId)).find((server) => server.name === name);
  const server: McpServer = {
    ...(existing ?? blank(platformId, name, url)),
    description: (input.description ?? existing?.description ?? "").slice(0, 280),
    url,
    auth: input.auth ?? existing?.auth ?? (input.bearer ? "bearer" : "none"),
    headerName: headerNameOf(input.headerName ?? existing?.headerName ?? "Authorization"),
    authorizeUrl: input.authorizeUrl ? await assertServerUrl(input.authorizeUrl) : existing?.authorizeUrl ?? "",
    tokenUrl: input.tokenUrl ? await assertServerUrl(input.tokenUrl) : existing?.tokenUrl ?? "",
    revokeUrl: input.revokeUrl ? await assertServerUrl(input.revokeUrl) : existing?.revokeUrl ?? "",
    clientId: (input.clientId ?? existing?.clientId ?? "").slice(0, 200),
    scopes: (input.scopes ?? existing?.scopes ?? "").slice(0, 200),
    updatedAt: now(),
  };
  if (input.bearer || input.headerValue || input.oauthClient) {
    const prior = (await readSecret(platformId, name)) ?? {};
    await writeSecret(platformId, name, {
      ...prior,
      ...(input.bearer ? { bearer: input.bearer } : {}),
      ...(input.headerValue ? { headerValue: input.headerValue } : {}),
      ...(input.oauthClient ? { oauthClient: input.oauthClient } : {}),
    });
  }
  await saveServer(server);
  return server;
}

export async function beginOAuth(server: McpServer): Promise<string> {
  if (!server.authorizeUrl || !server.clientId) {
    throw new AgentsError("NOT_READY", "This MCP server has no OAuth authorization URL.", 409);
  }
  const redirectUri = mcpRedirectUri();
  await saveServer({ ...server, auth: "oauth", redirectUri, updatedAt: now() });
  const at = now();
  for (const [key, row] of states) {
    if (row.expiresAt < at) states.delete(key);
  }
  const state = randomUUID();
  states.set(state, { platformId: server.platformId, name: server.name, expiresAt: at + 10 * 60_000 });
  const url = new URL(server.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", server.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  if (server.scopes) url.searchParams.set("scope", server.scopes);
  return url.toString();
}

export async function completeOAuth(state: string, code: string): Promise<{ authorized: true; name: string }> {
  const pending = states.get(state);
  states.delete(state);
  if (!pending || pending.expiresAt < now() || !code.trim()) {
    throw new AgentsError("NONCE_INVALID", "The MCP authorization state is invalid.", 400);
  }
  const server = (await listServers(pending.platformId)).find((item) => item.name === pending.name);
  if (!server?.tokenUrl || !server.redirectUri) throw new AgentsError("NOT_FOUND", "The MCP server is not configured.", 404);
  const secret = (await readSecret(server.platformId, server.name)) ?? {};
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: server.redirectUri,
    client_id: server.clientId,
  });
  if (secret.oauthClient) body.set("client_secret", secret.oauthClient);
  const json = await tokenRequest(server.tokenUrl, body);
  if (typeof json?.access_token !== "string") {
    throw new AgentsError("PROVIDER_UNAVAILABLE", "The MCP authorization code was refused.", 502);
  }
  await writeSecret(server.platformId, server.name, {
    ...secret,
    access: json.access_token,
    refresh: typeof json.refresh_token === "string" ? json.refresh_token : secret.refresh,
    expiresAt: now() + (typeof json.expires_in === "number" ? json.expires_in * 1000 : 3_600_000),
  });
  await saveServer({ ...server, auth: "oauth", status: "new", updatedAt: now() });
  return { authorized: true, name: server.name };
}

export async function revokeOAuth(server: McpServer): Promise<void> {
  const secret = await readSecret(server.platformId, server.name);
  if (server.revokeUrl && secret?.access) {
    const body = new URLSearchParams({ token: secret.access });
    if (secret.oauthClient) body.set("client_secret", secret.oauthClient);
    await tokenRequest(server.revokeUrl, body).catch(() => null);
  }
  await removeServer(server.platformId, server.name);
}

export function toolId(server: string, tool: string): string {
  const clean = `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  return (clean.match(/^[A-Za-z_]/) ? clean : `tool_${clean}`).slice(0, 64);
}

export function findMcpCall(servers: McpServer[], name: string): { server: McpServer; tool: string } | null {
  for (const server of servers) {
    for (const tool of server.tools) {
      if (toolId(server.name, tool.name) === name) return { server, tool: tool.name };
    }
  }
  return null;
}
