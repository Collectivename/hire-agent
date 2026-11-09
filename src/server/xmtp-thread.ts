import "server-only";
import { randomBytes } from "node:crypto";
import type { StoredChatMessage } from "./chat";
import { AgentsError } from "./errors";
import { agentStore, type StoredAgent } from "./store";
import { openInboxKey, sealInboxKey } from "./xmtp";

const KEY = /^0x[0-9a-f]{64}$/;

type ThreadMode = "memory" | "network";

let mode: ThreadMode = "network";
const memoryThreads = new Map<string, StoredChatMessage[]>();

/** Tests keep the thread on an in-process XMTP log. The app uses the XMTP network. */
export function useOwnerThread(next: ThreadMode): void {
  mode = next;
  if (next === "memory") memoryThreads.clear();
}

function freshKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

function openedKey(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const opened = openInboxKey(sealed);
  return opened && KEY.test(opened) ? opened : null;
}

async function agentKey(agent: StoredAgent): Promise<string> {
  const existing = openedKey(agent.xmtpInboxKey);
  if (existing) return existing;
  const key = freshKey();
  const sealed = sealInboxKey(key);
  if (!sealed) {
    throw new AgentsError("NOT_READY", "The messaging key is not configured, so the XMTP thread cannot start.", 503);
  }
  await agentStore().saveAgent({ ...agent, xmtpInboxKey: sealed, updatedAt: Date.now() });
  agent.xmtpInboxKey = sealed;
  return key;
}

async function ownerKey(owner: string): Promise<string> {
  const sealId = `xmtp-owner-${owner}`;
  const existing = openedKey(await agentStore().getSeal(sealId));
  if (existing) return existing;
  const key = freshKey();
  const sealed = sealInboxKey(key);
  if (!sealed) {
    throw new AgentsError("NOT_READY", "The messaging key is not configured, so the XMTP thread cannot start.", 503);
  }
  await agentStore().saveSeal(sealId, sealed);
  return key;
}

function settle(messages: StoredChatMessage[], closedAt: number | null): StoredChatMessage[] {
  const answered = new Set(
    messages.filter((message) => message.fromRole === "agent" && message.replyToId).map((message) => message.replyToId)
  );
  return messages
    .map((message) => {
      const closed = closedAt != null && message.createdAt <= closedAt;
      const replied = answered.has(message.id);
      return message.fromRole === "owner" && message.replyExpected && (closed || replied)
        ? { ...message, answeredAt: message.answeredAt ?? message.createdAt + 1 }
        : message;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

function remember(platformId: string, message: StoredChatMessage): StoredChatMessage[] {
  const current = memoryThreads.get(platformId) ?? [];
  if (message.clientId) {
    const existing = current.find((row) => row.clientId === message.clientId && row.fromRole === message.fromRole);
    if (existing) return settle(current, null);
  }
  const next = settle([...current, message], null);
  memoryThreads.set(platformId, next);
  return next;
}

export async function listOwnerThread(agent: StoredAgent): Promise<StoredChatMessage[]> {
  const closedAt = agent.transferredAt ?? null;
  if (mode === "memory") return settle(memoryThreads.get(agent.platformId) ?? [], closedAt);
  const { listDm } = await import("./xmtp-network");
  return settle(await listDm(await agentKey(agent), await ownerKey(agent.owner), agent), closedAt);
}

export async function appendOwnerThread(agent: StoredAgent, message: StoredChatMessage): Promise<StoredChatMessage> {
  if (mode === "memory") {
    const next = remember(agent.platformId, message);
    return next.find((row) => row.id === message.id || (message.clientId != null && row.clientId === message.clientId)) ?? message;
  }
  const { sendDm } = await import("./xmtp-network");
  await sendDm(await agentKey(agent), await ownerKey(agent.owner), message);
  return message;
}
