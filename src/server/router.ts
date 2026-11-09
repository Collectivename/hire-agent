import "server-only";
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { taxonomyDomain, taxonomySkill } from "../protocol/oasf-taxonomy";
import { canonicalJson, defaultPolicy, knownActions, slimNameFor, type Policy } from "../protocol";
import { agentMatchesCluster, hireCluster } from "./cluster";
import { actualBodyExceeds, contentLengthExceeds, hireConnection, rateLimit, resolveClientIp } from "./host";
import { actionView, launchBundleToken, requestAction, submitAction } from "./actions";
import {
  chatView,
  closePending,
  parseChatText,
  pendingOwnerMessages,
  type StoredChatMessage,
} from "./chat";
import { canonicalPubkey, randomId, randomToken, sha256Hex, verifyEd25519, verifyWalletSignature } from "./crypto";
import { directoryResults, unlistSupervisor } from "./directory";
import { AgentsError } from "./errors";
import { assertPublicDns, publicHttps } from "./public-url";
import { claimMessage, enrollMessage, ownerCommandMessage, ownerSessionMessage, secretMaterial, sensitiveKey } from "./messages";
import { agentReputation, jobsRoute, ownerReputation } from "./negotiate";
import { isSupervisor } from "./supervisor";
import { agentStore, publicAgent, type StoredAgent } from "./store";
import { runAgentTurn } from "./agent/loop";
import {
  confirmedRegistryTransaction,
  prepareRegistryRegistration,
  registrationDocument,
  registryMatch,
  registrationUri,
} from "./agent/registry";
import { beginOAuth, completeOAuth, connectServer, revokeOAuth, saveMcpConfig } from "./agent/mcp";
import { changeWorkspace, listServers, loadRuntime, loadWorkspace, saveRuntime, saveServer } from "./agent/persist";
import { chosenModel, connectProvider, disconnectProvider, listOwnerProviders, noteModelTurn, replaceProvider, runConnectedTask, selectModel } from "./providers";
import { allowedModel, modelProvider } from "./modal-policy";
import { deliverXmtp, pairId, sealInboxKey } from "./xmtp";
import { appendOwnerThread, listOwnerThread } from "./xmtp-thread";
import { assertServerCannotSign, createAgentWallet, walletProviderStatus, type SpikeResult } from "./wallet";
import { defaultWorkspace, putFile, selfFromIdentity, writeAgentSelf } from "./workspace";
import type { McpServer } from "./agent/types";

const WINDOW_MS = 60_000;
const BODY_MAX = 64 * 1024;
const NONCE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60_000;

type Caller = { role: "owner"; owner: string } | { role: "agent"; agent: StoredAgent };

function json(body: unknown, status = 200, extra?: Record<string, string>): NextResponse {
  const res = NextResponse.json(body, { status });
  if (extra) {
    for (const [key, value] of Object.entries(extra)) res.headers.set(key, value);
  }
  return res;
}

function fail(error: unknown): NextResponse {
  if (error instanceof AgentsError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  console.error("[agents]", error instanceof Error ? error.name : "error");
  return json({ error: { code: "SERVER", message: "Request failed." } }, 500);
}

async function readBody(req: NextRequest, bucket: string, limit: number): Promise<Record<string, unknown>> {
  const ip = resolveClientIp(req.headers, process.env.NODE_ENV === "production");
  const gated = rateLimit(`${bucket}:${ip}`, limit, WINDOW_MS);
  if (!gated.ok) {
    throw new AgentsError("RATE_LIMITED", "Too many requests. Retry shortly.", 429);
  }
  if (contentLengthExceeds(req.headers.get("content-length"), BODY_MAX)) {
    throw new AgentsError("BODY_TOO_LARGE", "Request body is too large.", 413);
  }
  const text = await req.text();
  if (actualBodyExceeds(text, BODY_MAX)) {
    throw new AgentsError("BODY_TOO_LARGE", "Request body is too large.", 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentsError("INVALID_PARAMS", "JSON object required.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentsError("INVALID_PARAMS", "JSON object required.", 400);
  }
  const sensitive = sensitiveKey(parsed);
  if (sensitive) {
    throw new AgentsError("SENSITIVE_FIELD", "Model keys, secrets, and prompts are not accepted.", 400);
  }
  return parsed as Record<string, unknown>;
}

async function readProviderBody(req: NextRequest): Promise<{ provider: string; credential: string; choice: string; text: string; platformId: string }> {
  const ip = resolveClientIp(req.headers, process.env.NODE_ENV === "production");
  const gated = rateLimit(`agents-provider:${ip}`, 20, WINDOW_MS);
  if (!gated.ok) throw new AgentsError("RATE_LIMITED", "Too many requests. Retry shortly.", 429);
  const text = await req.text();
  if (actualBodyExceeds(text, 4096)) throw new AgentsError("BODY_TOO_LARGE", "Request body is too large.", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentsError("INVALID_PARAMS", "JSON object required.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentsError("INVALID_PARAMS", "JSON object required.", 400);
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "provider" && key !== "credential" && key !== "choice" && key !== "text" && key !== "platformId") {
      throw new AgentsError("SENSITIVE_FIELD", "Only provider, credential, and choice are accepted.", 400);
    }
  }
  return {
    provider: typeof record.provider === "string" ? record.provider : "",
    credential: typeof record.credential === "string" ? record.credential : "",
    choice: typeof record.choice === "string" ? record.choice : "",
    text: typeof record.text === "string" ? record.text : "",
    platformId: typeof record.platformId === "string" ? record.platformId : "",
  };
}

function mcpAuth(value: unknown): "none" | "bearer" | "header" | "oauth" | undefined {
  if (value == null || value === "") return undefined;
  if (value === "none" || value === "bearer" || value === "header" || value === "oauth") return value;
  throw new AgentsError("INVALID_PARAMS", "MCP auth must be none, bearer, header, or oauth.", 400);
}

function publicMcp(server: McpServer) {
  return {
    name: server.name,
    description: server.description,
    url: server.url,
    transport: server.transport,
    auth: server.auth,
    enabled: server.enabled,
    approval: server.approval,
    status: server.status,
    lastError: server.lastError,
    instructions: server.instructions,
    tools: server.tools.map((tool) => ({ name: tool.name, description: tool.description, enabled: tool.enabled, approval: tool.approval })),
    clientId: server.clientId,
    scopes: server.scopes,
  };
}

function stringField(body: Record<string, unknown>, key: string, max = 200): string {
  const value = body[key];
  if (typeof value !== "string") throw new AgentsError("INVALID_PARAMS", `${key} is required.`, 400);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new AgentsError("INVALID_PARAMS", `${key} is invalid.`, 400);
  return trimmed;
}

async function authenticate(req: NextRequest): Promise<Caller | null> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token.startsWith("own_") && !token.startsWith("cag_")) return null;
  const secret = await agentStore().getSecret(sha256Hex(token));
  if (!secret || secret.revokedAt || secret.expiresAt < Date.now()) return null;
  if (secret.kind === "owner-session") return { role: "owner", owner: secret.owner };
  const agent = await agentStore().getAgent(secret.platformId);
  if (!agent || agent.status === "removed" || !agentMatchesCluster(agent)) return null;
  return { role: "agent", agent };
}

async function issueNonce(purpose: string, subject: string): Promise<string> {
  const nonce = randomId("n", 16);
  await agentStore().putNonce(nonce, {
    kind: "nonce",
    purpose,
    subject,
    expiresAt: Date.now() + NONCE_TTL_MS,
    used: false,
  });
  return nonce;
}

async function requireCaller(req: NextRequest): Promise<Caller> {
  const caller = await authenticate(req);
  if (!caller) throw new AgentsError("UNAUTHORIZED", "A credential or owner session is required.", 401);
  return caller;
}

async function ownerAgent(caller: Caller, platformId: string): Promise<StoredAgent> {
  if (caller.role !== "owner") throw new AgentsError("OWNER_REQUIRED", "The owner session is required.", 403);
  const agent = await agentStore().getAgent(platformId);
  if (!agent || agent.owner !== caller.owner || !agentMatchesCluster(agent)) {
    throw new AgentsError("NOT_FOUND", "Agent not found.", 404);
  }
  return agent;
}

function agentFromCaller(caller: Caller, platformId: string | null): StoredAgent {
  if (caller.role === "agent") {
    if (platformId && platformId !== caller.agent.platformId) {
      throw new AgentsError("FORBIDDEN", "Credential is for a different agent.", 403);
    }
    return caller.agent;
  }
  throw new AgentsError("UNAUTHORIZED", "An agent credential is required.", 401);
}

async function signedOwnerAgent(
  body: Record<string, unknown>,
  purpose: string,
  extra = ""
): Promise<StoredAgent> {
  const platformId = stringField(body, "platformId", 80);
  const nonce = stringField(body, "nonce", 80);
  const signature = stringField(body, "signature", 200);
  const agent = await agentStore().getAgent(platformId);
  if (!agent || !agentMatchesCluster(agent)) throw new AgentsError("NOT_FOUND", "Agent not found.", 404);
  if (agent.status === "removed") throw new AgentsError("REMOVED", "A removed agent stays removed.", 403);
  const message = ownerCommandMessage(purpose, platformId, nonce, extra);
  await agentStore().consumeNonce(nonce, purpose, agent.owner);
  if (!verifyWalletSignature(agent.owner, message, signature)) {
    throw new AgentsError("BAD_SIGNATURE", "Owner signature does not match this request.", 400);
  }
  return agent;
}

function parsePolicy(body: Record<string, unknown>): Policy {
  const list = (key: string): string[] => {
    const value = body[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new AgentsError("INVALID_PARAMS", `${key} must be a list of strings.`, 400);
    }
    return value.map((item) => item.trim()).filter(Boolean);
  };
  const lamports = (key: string): string => {
    const value = stringField(body, key, 30);
    if (!/^\d+$/.test(value)) throw new AgentsError("INVALID_PARAMS", `${key} must be lamports.`, 400);
    return value;
  };
  const maxPerMinute = body.maxPerMinute;
  if (typeof maxPerMinute !== "number" || !Number.isInteger(maxPerMinute) || maxPerMinute < 0 || maxPerMinute > 60) {
    throw new AgentsError("INVALID_PARAMS", "maxPerMinute must be an integer from 0 to 60.", 400);
  }
  const allowedActions = list("allowedActions");
  const known = new Set(knownActions());
  if (allowedActions.some((action) => !known.has(action))) {
    throw new AgentsError("INVALID_PARAMS", "allowedActions contains an unknown action.", 400);
  }
  return {
    perTxCapLamports: lamports("perTxCapLamports"),
    dailyBudgetLamports: lamports("dailyBudgetLamports"),
    allowedActions,
    allowedPrograms: list("allowedPrograms"),
    allowedRecipients: list("allowedRecipients"),
    allowedMints: list("allowedMints"),
    maxPerMinute,
  };
}

async function revokeCredentials(platformId: string): Promise<void> {
  const store = agentStore();
  const secrets = await store.listActiveCredentials(platformId);
  const now = Date.now();
  for (const secret of secrets) {
    await store.putSecret(secret.hash, { ...secret, revokedAt: now });
  }
}

function assertNoSecret(text: string): void {
  if (secretMaterial(text)) {
    throw new AgentsError("SENSITIVE_FIELD", "Message text looks like a credential or key. It was not stored.", 400);
  }
}

function clearedListing(agent: StoredAgent): Pick<StoredAgent, "directorySkills" | "directoryDomains" | "directoryCid"> {
  return { directorySkills: [], directoryDomains: [], directoryCid: null };
}

function taxonomyList(value: unknown, accept: (item: string) => string | null, label: string, max = 8): string[] {
  if (!Array.isArray(value)) throw new AgentsError("INVALID_PARAMS", `${label} must be OASF taxonomy paths.`, 400);
  if (value.length > max) throw new AgentsError("INVALID_PARAMS", `List at most ${max} ${label.toLowerCase()}.`, 400);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new AgentsError("INVALID_PARAMS", `${label} must be OASF taxonomy paths.`, 400);
    const accepted = accept(item);
    if (!accepted) throw new AgentsError("INVALID_PARAMS", `${label} must be OASF taxonomy paths.`, 400);
    if (!out.includes(accepted)) out.push(accepted);
  }
  return out;
}

function revealFor(caller: Caller, agent: StoredAgent, signer: "owner" | "agent"): boolean {
  if (caller.role === "owner" && caller.owner === agent.owner) return true;
  return caller.role === "agent" && signer === "agent";
}

function optionalClientId(body: Record<string, unknown>): string | null {
  if (body.clientId == null) return null;
  return stringField(body, "clientId", 80);
}

function assertChatable(agent: StoredAgent): void {
  if (agent.status === "removed") throw new AgentsError("REMOVED", "A removed agent has no chat.", 403);
}

function chatResponse(messages: StoredChatMessage[], owner: string) {
  const views = messages.flatMap((message) => {
    const view = chatView(message);
    return view ? [view] : [];
  });
  return { owner, messages: views, pending: pendingOwnerMessages(views, owner) };
}

export async function handleAgentsRequest(req: NextRequest, method: string, path: string[]): Promise<NextResponse> {
  try {
    const ip = resolveClientIp(req.headers, process.env.NODE_ENV === "production");
    const limited = rateLimit(`agents:${path.join("/")}:${ip}`, method === "GET" ? 120 : 30, WINDOW_MS);
    if (!limited.ok) {
      return json({ error: { code: "RATE_LIMITED", message: "Too many requests. Retry shortly." } }, 429, {
        "Retry-After": String(limited.retryAfter),
      });
    }
    return await route(req, method, path);
  } catch (error) {
    return fail(error);
  }
}

async function haltOpenWork(platformId: string): Promise<void> {
  await agentStore().expirePending(platformId);
  await agentStore().cancelOpenJobs(platformId);
}

async function route(req: NextRequest, method: string, path: string[]): Promise<NextResponse> {
  if (method === "GET" && path[0] === "mcp" && path[1] === "callback") {
    const code = req.nextUrl.searchParams.get("code") ?? "";
    const state = req.nextUrl.searchParams.get("state") ?? "";
    return json(await completeOAuth(state, code));
  }
  const jobPath = path[0] === "jobs" || (path[0] === "agents" && path[2] === "jobs");
  if (jobPath) return jobsRoute(req, method, path, await requireCaller(req));
  const key = `${method} ${path.join("/")}`;
  if (key === "GET ") {
    const caller = await requireCaller(req);
    if (caller.role === "owner") return json({ ok: true, role: "owner", owner: caller.owner });
    return json({
      ok: true,
      role: "agent",
      platformId: caller.agent.platformId,
      walletAddress: caller.agent.walletAddress,
      owner: caller.agent.owner,
    });
  }
  if (key === "GET wallet/status") return json({ providers: walletProviderStatus() });

  if (key === "POST owner-session/nonce") {
    const body = await readBody(req, "agents-owner-nonce", 20);
    const owner = canonicalPubkey(body.owner);
    if (!owner) throw new AgentsError("INVALID_PARAMS", "owner must be a canonical public key.", 400);
    const nonce = await issueNonce("owner-session", owner);
    return json({ nonce, message: ownerSessionMessage(owner, nonce) });
  }
  if (key === "POST owner-session") {
    const body = await readBody(req, "agents-owner-session", 20);
    const owner = canonicalPubkey(body.owner);
    const nonce = stringField(body, "nonce", 80);
    const signature = stringField(body, "signature", 200);
    if (!owner) throw new AgentsError("INVALID_PARAMS", "owner must be a canonical public key.", 400);
    const message = ownerSessionMessage(owner, nonce);
    await agentStore().consumeNonce(nonce, "owner-session", owner);
    if (!verifyWalletSignature(owner, message, signature)) {
      throw new AgentsError("BAD_SIGNATURE", "Owner signature does not match this request.", 400);
    }
    const token = randomToken("own");
    await agentStore().putSecret(sha256Hex(token), {
      kind: "owner-session",
      hash: sha256Hex(token),
      platformId: "",
      owner,
      expiresAt: Date.now() + SESSION_TTL_MS,
      revokedAt: null,
      createdAt: Date.now(),
    });
    return json({ token, expiresAt: Date.now() + SESSION_TTL_MS });
  }
  if (key === "POST enrollment/nonce") {
    const body = await readBody(req, "agents-enroll-nonce", 20);
    const owner = canonicalPubkey(body.owner);
    const name = stringField(body, "name", 32);
    if (!owner) throw new AgentsError("INVALID_PARAMS", "owner must be a canonical public key.", 400);
    const nonce = await issueNonce("enroll", owner);
    return json({ nonce, message: enrollMessage(owner, name, nonce) });
  }
  if (key === "POST enrollment") {
    const body = await readBody(req, "agents-enroll", 10);
    const owner = canonicalPubkey(body.owner);
    const name = stringField(body, "name", 32);
    const nonce = stringField(body, "nonce", 80);
    const signature = stringField(body, "signature", 200);
    if (body.provider != null && body.provider !== "privy") {
      throw new AgentsError("INVALID_PARAMS", "Agent wallets are created with Privy.", 400);
    }
    if (!owner) {
      throw new AgentsError("INVALID_PARAMS", "owner is required.", 400);
    }
    await agentStore().consumeNonce(nonce, "enroll", owner);
    if (!verifyWalletSignature(owner, enrollMessage(owner, name, nonce), signature)) {
      throw new AgentsError("BAD_SIGNATURE", "Owner signature does not match enrollment.", 400);
    }
    const platformId = randomId("agt");
    const wallet = await createAgentWallet(platformId, owner);
    const claimNonce = randomId("n", 16);
    const now = Date.now();
    const agent: StoredAgent = {
      platformId,
      owner,
      name,
      endpoint: null,
      endpointVerifiedAt: null,
      walletAddress: wallet.address,
      walletProvider: "privy",
      providerWalletId: wallet.providerWalletId,
      retiredWallets: [],
      status: "pending_credential",
      slimName: slimNameFor(platformId),
      directoryCid: null,
      oasf: null,
      runtimePublicKey: null,
      signCredentialIssuedAt: null,
      claimNonce,
      xmtpInboxKey: sealInboxKey(`0x${randomBytes(32).toString("hex")}`),
      network: hireCluster(),
      createdAt: now,
      updatedAt: now,
    };
    const store = agentStore();
    await store.saveAgent(agent);
    await store.savePolicy({ ...defaultPolicy(), platformId, updatedAt: now });
    await store.saveWorkspace(defaultWorkspace(platformId, name, now));
    await store.saveAudit({
      id: randomId("aud"),
      platformId,
      actionId: null,
      kind: "enroll",
      summary: "Wallet created. Spending is denied until the owner opens a policy.",
      verified: false,
      reported: true,
      detail: { walletAddress: wallet.address, provider: "privy" },
      createdAt: now,
    });
    return json({
      platformId,
      walletAddress: wallet.address,
      provider: "privy",
      claim: { nonce: claimNonce, message: claimMessage(platformId, claimNonce) },
      policy: defaultPolicy(),
    });
  }
  if (key === "POST credentials/claim") {
    const body = await readBody(req, "agents-claim", 20);
    const platformId = stringField(body, "platformId", 80);
    const nonce = stringField(body, "nonce", 80);
    const signature = stringField(body, "signature", 200);
    const publicKey = canonicalPubkey(body.publicKey);
    const agent = await agentStore().getAgent(platformId);
    if (!agent || !agent.claimNonce || agent.claimNonce !== nonce || !publicKey) {
      throw new AgentsError("NONCE_INVALID", "Claim challenge is invalid.", 400);
    }
    const message = claimMessage(platformId, nonce);
    if (!verifyEd25519(bs58.decode(publicKey), message, bs58.decode(signature))) {
      throw new AgentsError("BAD_SIGNATURE", "Runtime key did not sign the challenge.", 400);
    }
    const token = randomToken("cag");
    const now = Date.now();
    const hash = sha256Hex(token);
    await agentStore().claimRuntime({
      platformId,
      nonce,
      publicKey,
      secret: {
        kind: "credential",
        hash,
        platformId,
        owner: agent.owner,
        expiresAt: now + CREDENTIAL_TTL_MS,
        revokedAt: null,
        createdAt: now,
      },
    });
    return json({ credential: token, expiresAt: now + CREDENTIAL_TTL_MS });
  }
  if (key === "POST credentials/rotate") {
    const caller = await requireCaller(req);
    const agent = agentFromCaller(caller, null);
    if (agent.status !== "active") throw new AgentsError("PAUSED", "Agent is paused.", 403);
    await revokeCredentials(agent.platformId);
    const token = randomToken("cag");
    const now = Date.now();
    await agentStore().putSecret(sha256Hex(token), {
      kind: "credential",
      hash: sha256Hex(token),
      platformId: agent.platformId,
      owner: agent.owner,
      expiresAt: now + CREDENTIAL_TTL_MS,
      revokedAt: null,
      createdAt: now,
    });
    return json({ credential: token, expiresAt: now + CREDENTIAL_TTL_MS });
  }

  if (key === "GET mine") {
    const caller = await requireCaller(req);
    if (caller.role !== "owner") throw new AgentsError("OWNER_REQUIRED", "The owner session is required.", 403);
    const agents = (await agentStore().listByOwner(caller.owner)).filter(agentMatchesCluster);
    return json({ agents: agents.map(publicAgent) });
  }

  if (method === "GET" && path[0] === "agents" && path[2] === "registration" && path.length === 3) {
    const agent = await agentStore().getAgent(path[1]!);
    if (!agent) throw new AgentsError("NOT_FOUND", "Agent not found.", 404);
    return json(registrationDocument(await unlistSupervisor(agent)), 200, { "cache-control": "no-store" });
  }

  if (method === "POST" && path[0] === "agents" && path[2] === "registry" && path[3] === "prepare" && path.length === 4) {
    const body = await readBody(req, "agents-registry", 5);
    const asset = stringField(body, "asset", 50);
    const caller = await requireCaller(req);
    const agent = await ownerAgent(caller, path[1]!);
    const prepared = await prepareRegistryRegistration(agent, asset);
    await agentStore().saveAgent({
      ...agent,
      registryPendingAsset: prepared.asset,
      registryUri: prepared.uri,
      updatedAt: Date.now(),
    });
    return json(prepared);
  }

  if (method === "POST" && path[0] === "agents" && path[2] === "registry" && path[3] === "confirm" && path.length === 4) {
    const body = await readBody(req, "agents-registry", 10);
    const asset = stringField(body, "asset", 50);
    const signature = stringField(body, "signature", 100);
    const caller = await requireCaller(req);
    const agent = await ownerAgent(caller, path[1]!);
    if (agent.registryAsset) {
      throw new AgentsError("ALREADY_REGISTERED", "This agent already has a registry identifier.", 409);
    }
    if (agent.registryPendingAsset !== asset) {
      throw new AgentsError("INVALID_PARAMS", "Prepare registration for this asset first.", 400);
    }
    const uri = agent.registryUri || registrationUri(agent.platformId);
    const read = await confirmedRegistryTransaction(hireConnection(), signature);
    const problem = registryMatch({ ...read, owner: agent.owner, asset, uri, failed: read.failed });
    if (problem) throw new AgentsError("UNCONFIRMED", problem, 400);
    const now = Date.now();
    const saved = {
      ...agent,
      registryAsset: asset,
      registrySignature: signature,
      registryUri: uri,
      registryPendingAsset: null,
      updatedAt: now,
    };
    await agentStore().saveAgent(saved);
    await agentStore().saveAudit({
      id: randomId("aud"),
      platformId: agent.platformId,
      actionId: null,
      kind: "registry",
      summary: "Solana agent-registry asset saved as the public identifier.",
      verified: true,
      reported: true,
      detail: { asset, signature },
      createdAt: now,
    });
    return json({ agent: publicAgent(saved) });
  }

  if (method === "GET" && path[0] === "agents" && path.length === 2) {
    const agent = await agentStore().getAgent(path[1]!);
    if (!agent || !agentMatchesCluster(agent)) throw new AgentsError("NOT_FOUND", "Agent not found.", 404);
    const caller = await authenticate(req);
    const ownerView = caller?.role === "owner" && caller.owner === agent.owner;
    if (!ownerView) {
      return json({
        agent: publicAgent(agent),
        reputation: await agentReputation(agent.platformId),
        ownerReputation: await ownerReputation(agent.owner),
      });
    }
    const policy = await agentStore().getPolicy(agent.platformId);
    let balanceLamports: string | null = null;
    try {
      balanceLamports = String(await hireConnection().getBalance(new PublicKey(agent.walletAddress)));
    } catch {
      balanceLamports = null;
    }
    return json({
      agent: {
        ...agent,
        identifier: agent.registryAsset ?? null,
        claimNonce: agent.claimNonce ? "pending" : null,
      },
      policy,
      balanceLamports,
      balanceVerified: balanceLamports != null,
      reputation: await agentReputation(agent.platformId),
      ownerReputation: await ownerReputation(agent.owner),
    });
  }

  if (method === "POST" && path[0] === "owner-nonce") {
    const caller = await requireCaller(req);
    const body = await readBody(req, "agents-command-nonce", 30);
    const purpose = stringField(body, "purpose", 40);
    const platformId = stringField(body, "platformId", 80);
    const agent = await ownerAgent(caller, platformId);
    const allowed = new Set([
      "pause",
      "remove",
      "revoke",
      "transfer",
      "rotate-wallet",
      "endpoint",
      "policy",
      "grant",
      "sign-credential",
      "spike",
      "reset-runtime",
      "model",
      "approve-job",
      "reject-job",
      "revise-job",
    ]);
    if (!allowed.has(purpose)) throw new AgentsError("INVALID_PARAMS", "Unknown owner action.", 400);
    const extra = typeof body.extra === "string" ? body.extra.slice(0, 500) : "";
    const nonce = await issueNonce(purpose, agent.owner);
    return json({ nonce, message: ownerCommandMessage(purpose, platformId, nonce, extra) });
  }

  if (key === "POST agents/pause" || (method === "POST" && path[0] === "agents" && path[2] === "pause")) {
    const body = await readBody(req, "agents-pause", 20);
    const agent = await signedOwnerAgent(body, "pause");
    await haltOpenWork(agent.platformId);
    const next = { ...agent, status: "paused" as const, directoryCid: null, updatedAt: Date.now() };
    await agentStore().saveAgent(next);
    return json({ agent: publicAgent(next) });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "model") {
    const body = await readBody(req, "agents-model", 10);
    const provider = modelProvider(stringField(body, "provider", 40));
    const choice = allowedModel(provider, stringField(body, "choice", 80));
    const agent = await signedOwnerAgent(body, "model", `model: ${provider}/${choice}`);
    const link = await agentStore().getProvider(agent.owner, provider);
    if (!link || link.status !== "connected") {
      throw new AgentsError("NOT_FOUND", "That provider is not connected for this owner.", 404);
    }
    const saved = { ...agent, agentModel: { provider, modelId: choice }, updatedAt: Date.now() };
    await agentStore().saveAgent(saved);
    return json({ agent: publicAgent(saved) });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "remove") {
    const body = await readBody(req, "agents-remove", 10);
    const agent = await signedOwnerAgent(body, "remove");
    await revokeCredentials(agent.platformId);
    await haltOpenWork(agent.platformId);
    const next = { ...agent, ...clearedListing(agent), status: "removed" as const, updatedAt: Date.now() };
    await agentStore().saveAgent(next);
    return json({ agent: publicAgent(next) });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "revoke") {
    const body = await readBody(req, "agents-revoke", 20);
    const agent = await signedOwnerAgent(body, "revoke");
    await revokeCredentials(agent.platformId);
    return json({ revoked: true, platformId: agent.platformId });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "owner") {
    const body = await readBody(req, "agents-transfer", 10);
    const nextOwner = canonicalPubkey(body.nextOwner);
    if (!nextOwner) throw new AgentsError("INVALID_PARAMS", "nextOwner must be a canonical public key.", 400);
    const agent = await signedOwnerAgent(body, "transfer", `owner: ${nextOwner}`);
    await revokeCredentials(agent.platformId);
    await haltOpenWork(agent.platformId);
    const saved = { ...agent, owner: nextOwner, transferredAt: Date.now(), updatedAt: Date.now() };
    await agentStore().saveAgent(saved);
    await agentStore().updateThread(agent.platformId, (messages) => ({
      messages: closePending(messages, Date.now()),
      result: null,
    }));
    return json({ agent: publicAgent(saved) });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "wallet") {
    const body = await readBody(req, "agents-rotate-wallet", 10);
    if (body.provider != null && body.provider !== "privy") {
      throw new AgentsError("INVALID_PARAMS", "Agent wallets are created with Privy.", 400);
    }
    const agent = await signedOwnerAgent(body, "rotate-wallet", "provider: privy");
    await revokeCredentials(agent.platformId);
    await agentStore().expirePending(agent.platformId);
    const created = await createAgentWallet(agent.platformId, agent.owner);
    const saved = {
      ...agent,
      retiredWallets: [...agent.retiredWallets, { address: agent.walletAddress, retiredAt: Date.now() }],
      walletAddress: created.address,
      walletProvider: "privy" as const,
      providerWalletId: created.providerWalletId,
      updatedAt: Date.now(),
    };
    await agentStore().saveAgent(saved);
    return json({ agent: publicAgent(saved) });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "endpoint") {
    const body = await readBody(req, "agents-endpoint", 10);
    const endpoint = publicHttps(stringField(body, "endpoint", 300));
    const agent = await signedOwnerAgent(body, "endpoint", `endpoint: ${endpoint}`);
    if (!agent.runtimePublicKey) {
      throw new AgentsError("NOT_READY", "The agent runtime must claim a credential before an endpoint can be proved.", 400);
    }
    const challenge = claimMessage(agent.platformId, randomId("ep", 8));
    await assertPublicDns(endpoint);
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new AgentsError("ENDPOINT_UNPROVED", "Endpoint redirected. Refusing to follow.", 400);
    }
    const proof = (await response.json().catch(() => null)) as { signature?: unknown } | null;
    if (!response.ok || typeof proof?.signature !== "string") {
      throw new AgentsError("ENDPOINT_UNPROVED", "Endpoint did not sign the challenge.", 400);
    }
    if (!verifyEd25519(bs58.decode(agent.runtimePublicKey), challenge, bs58.decode(proof.signature))) {
      throw new AgentsError("ENDPOINT_UNPROVED", "Endpoint signature does not match the agent runtime key.", 400);
    }
    const saved = { ...agent, endpoint, endpointVerifiedAt: Date.now(), updatedAt: Date.now() };
    await agentStore().saveAgent(saved);
    return json({ agent: publicAgent(saved) });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "policy") {
    const body = await readBody(req, "agents-policy", 20);
    const policy = parsePolicy(body);
    const agent = await signedOwnerAgent(body, "policy", `policy: ${sha256Hex(canonicalJson(policy))}`);
    await agentStore().savePolicy({ ...policy, platformId: agent.platformId, updatedAt: Date.now() });
    await agentStore().expirePending(agent.platformId);
    return json({ policy });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "grants") {
    const body = await readBody(req, "agents-grant", 20);
    const callerPlatformId = stringField(body, "callerPlatformId", 80);
    if (typeof body.allowed !== "boolean") throw new AgentsError("INVALID_PARAMS", "allowed must be boolean.", 400);
    const agent = await signedOwnerAgent(
      body,
      "grant",
      `caller: ${callerPlatformId}\nallowed: ${body.allowed ? "true" : "false"}`
    );
    await agentStore().saveGrant({
      platformId: agent.platformId,
      callerPlatformId,
      allowed: body.allowed,
      updatedAt: Date.now(),
    });
    return json({ platformId: agent.platformId, callerPlatformId, allowed: body.allowed });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "sign-credential") {
    const body = await readBody(req, "agents-sign-credential", 10);
    if (body.issued !== true) {
      throw new AgentsError("INVALID_PARAMS", "Confirm that the sign credential was installed. Do not send the secret.", 400);
    }
    const agent = await signedOwnerAgent(body, "sign-credential");
    const saved = { ...agent, signCredentialIssuedAt: Date.now(), updatedAt: Date.now() };
    await agentStore().saveAgent(saved);
    return json({ signCredentialIssuedAt: saved.signCredentialIssuedAt });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "spike") {
    const body = await readBody(req, "agents-spike", 5);
    const agent = await signedOwnerAgent(body, "spike");
    const result: SpikeResult = await assertServerCannotSign(
      agent.providerWalletId,
      agent.walletAddress
    );
    if (result !== "server_cannot_sign") {
      await haltOpenWork(agent.platformId);
      await agentStore().saveAgent({ ...agent, status: "paused", directoryCid: null, updatedAt: Date.now() });
    }
    return json({ result, paused: result !== "server_cannot_sign" });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "reset-runtime") {
    const body = await readBody(req, "agents-reset-runtime", 10);
    const agent = await signedOwnerAgent(body, "reset-runtime");
    await revokeCredentials(agent.platformId);
    await haltOpenWork(agent.platformId);
    const claimNonce = randomId("n", 16);
    const saved = {
      ...agent,
      ...clearedListing(agent),
      claimNonce,
      runtimePublicKey: null,
      status: "pending_credential" as const,
      endpointVerifiedAt: null,
      updatedAt: Date.now(),
    };
    await agentStore().saveAgent(saved);
    return json({ claim: { nonce: claimNonce, message: claimMessage(agent.platformId, claimNonce) } });
  }
  if (method === "GET" && path[0] === "providers" && path.length === 1) {
    const caller = await requireCaller(req);
    if (caller.role !== "owner") throw new AgentsError("OWNER_REQUIRED", "The owner session connects a provider.", 403);
    return listOwnerProviders(caller.owner);
  }
  if (method === "POST" && path[0] === "providers" && path.length === 2) {
    const caller = await requireCaller(req);
    if (caller.role !== "owner") throw new AgentsError("OWNER_REQUIRED", "The owner session connects a provider.", 403);
    const body = await readProviderBody(req);
    if (path[1] === "connect") return connectProvider(caller.owner, body.provider, body.credential);
    if (path[1] === "replace") return replaceProvider(caller.owner, body.provider, body.credential);
    if (path[1] === "disconnect") return disconnectProvider(caller.owner, body.provider);
    if (path[1] === "model") return selectModel(caller.owner, body.provider, body.choice);
    throw new AgentsError("NOT_FOUND", "Unknown agents route.", 404);
  }
  if (method === "POST" && path[0] === "runtime" && path[1] === "turn") {
    const caller = await requireCaller(req);
    const owner = caller.role === "owner" ? caller.owner : caller.agent.owner;
    const body = await readProviderBody(req);
    if (caller.role === "agent" || body.platformId) {
      const agent = caller.role === "agent" ? caller.agent : await ownerAgent(caller, body.platformId);
      const spoken = await runAgentTurn(agent, body.text, "task");
      return json({ text: spoken.text, run: spoken.run, provider: spoken.run.provider, modelId: spoken.run.modelId });
    }
    noteModelTurn(owner);
    return runConnectedTask(owner, body.provider, body.text, body.choice);
  }
  if (path[0] === "agents" && path[2] === "workspace" && path.length === 3) {
    const caller = await requireCaller(req);
    const agent = await ownerAgent(caller, path[1]!);
    if (method === "GET") {
      const workspace = await loadWorkspace(agent.platformId, agent.name);
      const files = Object.fromEntries(Object.entries(workspace.files).map(([filePath, file]) => [filePath, file.content]));
      return json({ version: workspace.version, bootstrapComplete: workspace.bootstrapComplete, files });
    }
    if (method === "POST") {
      const body = await readBody(req, "agents-workspace", 20);
      const filePath = stringField(body, "path", 180);
      const workspace = await changeWorkspace(agent.platformId, agent.name, (draft) => {
        if (body.op === "delete") {
          putFile(draft, filePath, "");
          return;
        }
        if (typeof body.content !== "string") throw new AgentsError("INVALID_PARAMS", "content is required.", 400);
        const self = filePath === "IDENTITY.md" ? selfFromIdentity(body.content) : null;
        if (self) {
          const posted = /^Description:\s*\S/m.test(body.content) ? body.content : undefined;
          writeAgentSelf(draft, self.name, self.description, posted);
          return;
        }
        putFile(draft, filePath, body.content);
      });
      return json({ version: workspace.version, path: filePath });
    }
  }
  if (path[0] === "agents" && path[2] === "mcp" && path.length === 3) {
    const caller = await requireCaller(req);
    const agent = await ownerAgent(caller, path[1]!);
    if (method === "GET") {
      const servers = await listServers(agent.platformId);
      return json({ servers: servers.map(publicMcp) });
    }
    if (method === "POST") {
      const body = await readBody(req, "agents-mcp", 20);
      const action = stringField(body, "action", 40);
      if (action === "save" || action === "connect") {
        const server = await saveMcpConfig(agent.platformId, {
          name: stringField(body, "name", 40),
          url: stringField(body, "url", 300),
          description: typeof body.description === "string" ? body.description : "",
          auth: mcpAuth(body.auth),
          headerName: typeof body.headerName === "string" ? body.headerName : undefined,
          bearer: typeof body.bearer === "string" ? body.bearer : undefined,
          headerValue: typeof body.headerValue === "string" ? body.headerValue : undefined,
          authorizeUrl: typeof body.authorizeUrl === "string" ? body.authorizeUrl : undefined,
          tokenUrl: typeof body.tokenUrl === "string" ? body.tokenUrl : undefined,
          revokeUrl: typeof body.revokeUrl === "string" ? body.revokeUrl : undefined,
          clientId: typeof body.clientId === "string" ? body.clientId : undefined,
          oauthClient: typeof body.oauthClient === "string" ? body.oauthClient : undefined,
          scopes: typeof body.scopes === "string" ? body.scopes : undefined,
        });
        const connected = action === "connect" ? await connectServer(server) : server;
        return json({ server: publicMcp(connected) });
      }
      const name = stringField(body, "name", 40);
      const server = (await listServers(agent.platformId)).find((item) => item.name === name);
      if (!server) throw new AgentsError("NOT_FOUND", "That MCP server is not connected.", 404);
      if (action === "tool") {
        const tool = stringField(body, "tool", 64);
        const next = {
          ...server,
          tools: server.tools.map((item) =>
            item.name === tool
              ? {
                  ...item,
                  enabled: typeof body.enabled === "boolean" ? body.enabled : item.enabled,
                  approval: body.approval === "prompt" || body.approval === "auto" ? body.approval : item.approval,
                }
              : item
          ),
          updatedAt: Date.now(),
        };
        await saveServer(next);
        return json({ server: publicMcp(next) });
      }
      if (action === "disable" || action === "enable") {
        const next = { ...server, enabled: action === "enable", status: action === "disable" ? ("disabled" as const) : server.status, updatedAt: Date.now() };
        await saveServer(next);
        return json({ server: publicMcp(next) });
      }
      if (action === "begin-oauth") return json({ url: beginOAuth(server) });
      if (action === "revoke") {
        await revokeOAuth(server);
        return json({ revoked: true });
      }
      throw new AgentsError("INVALID_PARAMS", "Unknown MCP action.", 400);
    }
  }
  if (method === "GET" && path[0] === "agents" && path[2] === "runtime" && path.length === 3) {
    const caller = await requireCaller(req);
    const agent = await ownerAgent(caller, path[1]!);
    const runtime = await loadRuntime(agent.platformId);
    const workspace = await loadWorkspace(agent.platformId, agent.name);
    return json({ version: workspace.version, bootstrapComplete: workspace.bootstrapComplete, runtime });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "heartbeat" && path.length === 3) {
    const caller = await requireCaller(req);
    const agent = await ownerAgent(caller, path[1]!);
    const spoken = await runAgentTurn(agent, "heartbeat", "heartbeat");
    return json({ text: spoken.text, run: spoken.run, skipped: spoken.skipped ?? "" });
  }
  if (path[0] === "agents" && path[2] === "peers" && path[4] === "messages" && path.length === 5) {
    const caller = await requireCaller(req);
    const agent = caller.role === "agent" ? caller.agent : await ownerAgent(caller, path[1]!);
    if (caller.role === "agent" && caller.agent.platformId !== path[1]) {
      throw new AgentsError("FORBIDDEN", "An agent speaks only as itself.", 403);
    }
    const other = await agentStore().getAgent(path[3]!);
    const readable = (status: string) => status === "active" || status === "pending_credential";
    if (!other || !agentMatchesCluster(other)) {
      throw new AgentsError("NOT_FOUND", "Both agents have to be active.", 404);
    }
    const thread = pairId(agent.platformId, other.platformId);
    if (method === "GET" && caller.role === "owner" && readable(agent.status) && readable(other.status)) {
      return json({ messages: await agentStore().listPeer(thread) });
    }
    if (other.status !== "active" || agent.status !== "active") {
      throw new AgentsError("NOT_FOUND", "Both agents have to be active.", 404);
    }
    if (method === "GET") {
      const messages = await agentStore().listPeer(thread);
      return json({ messages });
    }
    if (method === "POST") {
      const body = await readBody(req, "agents-peer", 30);
      const text = parseChatText(body.text);
      assertNoSecret(text);
      const message = {
        id: randomId("msg"),
        fromPlatformId: agent.platformId,
        toPlatformId: other.platformId,
        text,
        createdAt: Date.now(),
      };
      await chosenModel(other.owner);
      await agentStore().appendPeer(thread, message);
      let wake = await deliverXmtp({
        kind: "text",
        fromPlatformId: agent.platformId,
        toPlatformId: other.platformId,
        messageId: message.id,
        text,
      });
      const spoken = await runAgentTurn(other, text, "chat", true);
      const reply = {
        id: randomId("msg"),
        fromPlatformId: other.platformId,
        toPlatformId: agent.platformId,
        text: spoken.text,
        createdAt: Date.now(),
      };
      await agentStore().appendPeer(thread, reply);
      wake = await deliverXmtp({
        kind: "text",
        fromPlatformId: other.platformId,
        toPlatformId: agent.platformId,
        messageId: reply.id,
        text: spoken.text,
      });
      const jobs = await agentStore().listJobsForAgent(agent.platformId);
      return json({ message, reply, wake, jobCount: jobs.length });
    }
  }
  if (method === "GET" && path[0] === "agents" && path[2] === "messages" && path.length === 3) {
    const caller = await requireCaller(req);
    const agent = await ownerAgent(caller, path[1]!);
    const runtime = await loadRuntime(agent.platformId);
    return json({ ...chatResponse(await listOwnerThread(agent), agent.owner), ask: runtime.ownerAsk ?? null });
  }
  if (method === "POST" && path[0] === "agents" && path[2] === "messages" && path.length === 3) {
    const caller = await requireCaller(req);
    const body = await readBody(req, "agents-chat", 30);
    const agent = await ownerAgent(caller, path[1]!);
    assertChatable(agent);
    const text = parseChatText(body.text);
    assertNoSecret(text);
    const replyExpected = body.replyExpected === undefined ? true : body.replyExpected;
    if (typeof replyExpected !== "boolean") {
      throw new AgentsError("INVALID_PARAMS", "replyExpected must be a boolean.", 400);
    }
    const now = Date.now();
    const message: StoredChatMessage = {
      id: randomId("msg"),
      clientId: optionalClientId(body),
      platformId: agent.platformId,
      fromRole: "owner",
      fromWallet: agent.owner,
      fromPlatformId: null,
      text,
      replyExpected,
      answeredAt: null,
      replyToId: null,
      createdAt: now,
    };
    if (replyExpected) await chosenModel(agent.owner);
    const saved = await appendOwnerThread(agent, message);
    let run: Awaited<ReturnType<typeof runAgentTurn>>["run"] | null = null;
    if (saved.id === message.id) {
      await agentStore().saveAudit({
        id: randomId("aud"),
        platformId: agent.platformId,
        actionId: null,
        kind: "chat.owner",
        summary: replyExpected
          ? "Owner sent a message on XMTP. The chosen model replies in the sandbox."
          : "Owner sent a note on XMTP.",
        verified: false,
        reported: true,
        detail: { messageId: saved.id, fromRole: "owner", replyExpected: String(replyExpected) },
        createdAt: now,
      });
      if (replyExpected) {
        const spoken = await runAgentTurn(agent, text, "chat");
        run = spoken.run;
        await appendOwnerThread(agent, {
          id: randomId("msg"),
          clientId: null,
          platformId: agent.platformId,
          fromRole: "agent",
          fromWallet: null,
          fromPlatformId: agent.platformId,
          text: spoken.text,
          replyExpected: false,
          answeredAt: null,
          replyToId: saved.id,
          createdAt: now + 1,
        });
      } else {
        const runtime = await loadRuntime(agent.platformId);
        if (runtime.ownerAsk) await saveRuntime({ ...runtime, ownerAsk: null });
      }
    }
    const view = chatView(saved);
    if (!view) throw new AgentsError("SERVER", "Message could not be labeled.", 500);
    const runtime = await loadRuntime(agent.platformId);
    return json({
      message: view,
      wake: "sent",
      ask: runtime.ownerAsk ?? null,
      ...(run ? { run } : {}),
      ...chatResponse(await listOwnerThread(agent), agent.owner),
    });
  }
  if (key === "GET inbox") {
    const caller = await requireCaller(req);
    const agent = agentFromCaller(caller, null);
    return json({
      platformId: agent.platformId,
      walletAddress: agent.walletAddress,
      ...chatResponse(await listOwnerThread(agent), agent.owner),
    });
  }
  if (key === "POST inbox") {
    const caller = await requireCaller(req);
    const body = await readBody(req, "agents-inbox", 30);
    const agent = agentFromCaller(caller, null);
    assertChatable(agent);
    const text = parseChatText(body.text);
    assertNoSecret(text);
    const replyToId = body.replyToId == null || body.replyToId === "" ? null : stringField(body, "replyToId", 80);
    const now = Date.now();
    const reply: StoredChatMessage = {
      id: randomId("msg"),
      clientId: optionalClientId(body),
      platformId: agent.platformId,
      fromRole: "agent",
      fromWallet: null,
      fromPlatformId: agent.platformId,
      text,
      replyExpected: false,
      answeredAt: null,
      replyToId,
      createdAt: now,
    };
    const saved = await appendOwnerThread(agent, reply);
    if (saved.id === reply.id) {
      await agentStore().saveAudit({
        id: randomId("aud"),
        platformId: agent.platformId,
        actionId: null,
        kind: "chat.agent",
        summary: "Agent replied on the XMTP conversation.",
        verified: false,
        reported: true,
        detail: { messageId: saved.id, fromRole: "agent", replyToId: saved.replyToId ?? "" },
        createdAt: now,
      });
    }
    const view = chatView(saved);
    if (!view) throw new AgentsError("SERVER", "Message could not be labeled.", 500);
    return json({
      message: view,
      ...chatResponse(await listOwnerThread(agent), agent.owner),
    });
  }
  if (method === "GET" && path[0] === "agents" && path[2] === "audit") {
    const caller = await requireCaller(req);
    const agent = await ownerAgent(caller, path[1]!);
    const rows = await agentStore().listAudit(agent.platformId);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return json({
      audit: rows.map((row) => ({
        ...row,
        label: row.verified ? "verified" : "reported",
      })),
    });
  }
  if (method === "GET" && path[0] === "agents" && path[2] === "actions" && path.length === 3) {
    const caller = await requireCaller(req);
    const agent = await ownerAgent(caller, path[1]!);
    const actions = await agentStore().listActions(agent.platformId);
    return json({ actions: actions.map((action) => actionView(action, false)) });
  }
  if (method === "GET" && path[0] === "agents" && path[2] === "actions" && path.length === 4) {
    const caller = await requireCaller(req);
    const agent = await ownerAgent(caller, path[1]!);
    const action = await agentStore().getAction(path[3]!);
    if (!action || action.platformId !== agent.platformId) throw new AgentsError("NOT_FOUND", "Action not found.", 404);
    return json({ action: actionView(action, true), bundleToken: await launchBundleToken(action) });
  }
  if (key === "POST directory/publish") {
    const caller = await requireCaller(req);
    const body = await readBody(req, "agents-publish", 10);
    const platformId = caller.role === "agent" ? caller.agent.platformId : stringField(body, "platformId", 80);
    const agent = caller.role === "agent" ? caller.agent : await ownerAgent(caller, platformId);
    if (agent.status !== "active" && agent.status !== "pending_credential") {
      throw new AgentsError("PAUSED", "Paused or removed agents are not listed.", 403);
    }
    if (!agent.registryAsset) {
      throw new AgentsError("NOT_READY", "Register the agent on Solana before listing a skill.", 409);
    }
    if (isSupervisor(agent.platformId)) {
      await unlistSupervisor(agent);
      throw new AgentsError("INVALID_PARAMS", "The supervisor reviews deliveries. It is not listed for hire.", 409);
    }
    const skills = taxonomyList(body.skills, taxonomySkill, "Skills", 5);
    const domains = skills.length === 0 || body.domains == null ? [] : taxonomyList(body.domains, taxonomyDomain, "Domains");
    const workspace = await loadWorkspace(agent.platformId, agent.name);
    const described = /^Description:\s*(.+)$/m.exec(workspace.files["IDENTITY.md"]?.content ?? "")?.[1]?.trim() ?? "";
    const saved = {
      ...agent,
      directorySkills: skills,
      directoryDomains: domains,
      directoryCid: null,
      publicDescription: skills.length ? described.slice(0, 280) : "",
      updatedAt: Date.now(),
    };
    await agentStore().saveAgent(saved);
    await agentStore().saveAudit({
      id: randomId("aud"),
      platformId: agent.platformId,
      actionId: null,
      kind: "directory",
      summary: skills.length ? "OASF skills listed on the registration file." : "OASF skills removed from the registration file.",
      verified: true,
      reported: true,
      detail: { skills: skills.join(","), domains: domains.join(",") },
      createdAt: Date.now(),
    });
    return json({ platformId: agent.platformId, skills, domains, uri: registrationUri(agent.platformId) });
  }
  if (method === "GET" && path[0] === "directory" && path[1] === "search" && path.length === 2) {
    const skill = req.nextUrl.searchParams.get("skill") ?? "";
    if (skill.length > 160) throw new AgentsError("INVALID_PARAMS", "Skill must be an OASF 0.8 taxonomy path.", 400);
    return json(await directoryResults(skill), 200, { "cache-control": "no-store" });
  }
  if (key === "POST directory/search") {
    const body = await readBody(req, "agents-search", 30);
    const skill = typeof body.skill === "string" ? body.skill : "";
    if (skill.length > 160) throw new AgentsError("INVALID_PARAMS", "Skill must be an OASF 0.8 taxonomy path.", 400);
    return json(await directoryResults(skill), 200, { "cache-control": "no-store" });
  }
  if (key === "POST tasks") {
    await requireCaller(req);
    throw new AgentsError(
      "INVALID_PARAMS",
      "Jobs are negotiated at POST /jobs. A complete message does not pay.",
      400
    );
  }
  if (method === "POST" && path[0] === "actions" && path.length === 2) {
    const caller = await requireCaller(req);
    const body = await readBody(req, "agents-action", 20);
    const name = path[1]!;
    if (!knownActions().includes(name)) throw new AgentsError("INVALID_PARAMS", "Unknown action.", 400);
    const agent =
      caller.role === "agent"
        ? caller.agent
        : await ownerAgent(caller, stringField(body, "platformId", 80));
    const result = await requestAction(agent, name, body);
    const reveal =
      result.decision.signer === "none"
        ? false
        : revealFor(caller, agent, result.decision.signer);
    return json({
      decision: result.decision,
      action: actionView(result.action, reveal),
      read: reveal ? result.read : undefined,
      bundleToken: reveal ? result.bundleToken : undefined,
    });
  }
  if (method === "POST" && path[0] === "actions" && path[2] === "submit") {
    const caller = await requireCaller(req);
    const body = await readBody(req, "agents-submit", 20);
    const name = path[1]!;
    const actionId = stringField(body, "actionId", 80);
    const signed = body.signedTransactions;
    if (!Array.isArray(signed) || signed.some((item) => typeof item !== "string")) {
      throw new AgentsError("INVALID_PARAMS", "signedTransactions must be a list of base64 transactions.", 400);
    }
    const agent =
      caller.role === "agent"
        ? caller.agent
        : await ownerAgent(caller, stringField(body, "platformId", 80));
    const action = await submitAction(agent, name, actionId, signed as string[], caller.role);
    return json({ action: actionView(action, true) });
  }

  throw new AgentsError("NOT_FOUND", "Unknown agents route.", 404);
}
