import "server-only";
import path from "node:path";
import type { StoredChatMessage } from "./chat";
import { AgentsError } from "./errors";
import type { StoredAgent } from "./store";
import { messagingKey } from "./xmtp";

type TextBody = { kind?: string; value?: unknown };

type Dm = {
  sendText: (text: string) => Promise<unknown>;
  sync: () => Promise<void>;
  messages: () => Promise<{ content?: TextBody | string; fallback?: string }[]>;
  peerInboxId: () => Promise<string | null>;
};

type XmtpClient = {
  inboxId: string;
  conversations: {
    sync: () => Promise<void>;
    createDm: (inboxId: string) => Promise<Dm>;
    getDmByInboxId: (inboxId: string) => Promise<Dm | undefined>;
    listDms: () => Promise<Dm[]>;
  };
};

const clients = new Map<string, Promise<XmtpClient>>();
let turn: Promise<unknown> = Promise.resolve();

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = turn.then(work, work);
  turn = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function backendUrl(): string {
  const configured = process.env.XMTP_API_URL?.trim();
  if (!configured) {
    throw new AgentsError("NOT_READY", "Set XMTP_API_URL. The thread is an XMTP conversation.", 503);
  }
  return configured.replace(/\/$/, "");
}

function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const clean = message.replace(/0x[0-9a-fA-F]{8,}/g, "0x…").replace(/\s+/g, " ").trim();
  return clean ? `The XMTP client did not start. ${clean.slice(0, 180)}` : "The XMTP client did not start.";
}

async function clientFor(hexKey: string): Promise<XmtpClient> {
  const cached = clients.get(hexKey);
  if (cached) return cached;
  const opening = openClient(hexKey);
  clients.set(hexKey, opening);
  try {
    return await opening;
  } catch (error) {
    clients.delete(hexKey);
    throw error;
  }
}

async function openClient(hexKey: string): Promise<XmtpClient> {
  let sdk: {
    Client: { create: (signer: unknown, options: unknown) => Promise<XmtpClient> };
    LocalSigningKey: { fromHex: (key: string) => Promise<unknown> };
  };
  try {
    sdk = (await import("@xmtp/node-sdk")) as unknown as typeof sdk;
  } catch (error) {
    throw new AgentsError("NOT_READY", explain(error), 503);
  }
  try {
    const signer = await sdk.LocalSigningKey.fromHex(hexKey);
    return await sdk.Client.create(signer, {
      backend: { url: backendUrl() },
      storage: {
        location: { directory: path.join(process.cwd(), ".xmtp") },
        label: hexKey.slice(2, 14),
        encryptionKey: messagingKey(),
      },
    });
  } catch (error) {
    throw new AgentsError("NOT_READY", explain(error), 503);
  }
}

function envelope(message: StoredChatMessage): string {
  return JSON.stringify({
    v: 1,
    id: message.id,
    role: message.fromRole,
    replyExpected: message.replyExpected,
    replyToId: message.replyToId,
    text: message.text,
    at: message.createdAt,
    clientId: message.clientId,
  });
}

function textOf(content: TextBody | string | undefined): string | null {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return null;
  if (typeof content.value === "string") return content.value;
  return null;
}

async function peerDms(client: XmtpClient, peer: string): Promise<Dm[]> {
  await client.conversations.sync();
  const found: Dm[] = [];
  const direct = await client.conversations.getDmByInboxId(peer);
  if (direct) found.push(direct);
  for (const row of await client.conversations.listDms()) {
    if (found.includes(row)) continue;
    if ((await row.peerInboxId()) === peer) found.push(row);
  }
  return found;
}

async function dmForSend(agentKey: string, ownerKey: string, from: "owner" | "agent"): Promise<Dm> {
  const agent = await clientFor(agentKey);
  const owner = await clientFor(ownerKey);
  const sender = from === "owner" ? owner : agent;
  const peer = from === "owner" ? agent.inboxId : owner.inboxId;
  const deadline = Date.now() + (from === "agent" ? 8_000 : 0);
  let found = await peerDms(sender, peer);
  while (found.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    found = await peerDms(sender, peer);
  }
  return found[0] ?? sender.conversations.createDm(peer);
}

async function readDms(agentKey: string, ownerKey: string, agent: StoredAgent): Promise<StoredChatMessage[]> {
  const owner = await clientFor(ownerKey);
  const agentClient = await clientFor(agentKey);
  const dms = await peerDms(owner, agentClient.inboxId);
  const seen = new Set<string>();
  const messages: StoredChatMessage[] = [];
  for (const dm of dms) {
    await dm.sync();
    for (const row of await dm.messages()) {
      const message = readEnvelope(row.content ?? row.fallback, agent);
      if (!message || seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
  }
  return messages;
}

function readEnvelope(content: TextBody | string | undefined, agent: StoredAgent): StoredChatMessage | null {
  const raw = textOf(content);
  if (!raw || !raw.startsWith("{")) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.v !== 1 || typeof parsed.id !== "string" || typeof parsed.text !== "string" || typeof parsed.at !== "number") {
    return null;
  }
  if (parsed.role !== "owner" && parsed.role !== "agent") return null;
  return {
    id: parsed.id,
    clientId: typeof parsed.clientId === "string" ? parsed.clientId : null,
    platformId: agent.platformId,
    fromRole: parsed.role,
    fromWallet: parsed.role === "owner" ? agent.owner : null,
    fromPlatformId: parsed.role === "agent" ? agent.platformId : null,
    text: parsed.text,
    replyExpected: parsed.replyExpected === true,
    answeredAt: null,
    replyToId: typeof parsed.replyToId === "string" ? parsed.replyToId : null,
    createdAt: parsed.at,
  };
}

export function listDm(agentKey: string, ownerKey: string, agent: StoredAgent): Promise<StoredChatMessage[]> {
  return exclusive(() => readDms(agentKey, ownerKey, agent));
}

export function sendDm(agentKey: string, ownerKey: string, message: StoredChatMessage): Promise<void> {
  return exclusive(async () => {
    const dm = await dmForSend(agentKey, ownerKey, message.fromRole);
    await dm.sendText(envelope(message));
  });
}
