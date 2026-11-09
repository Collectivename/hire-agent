/** Owner inbox rules. Text is data. The speaker is the role field, not the prose. */

export const CHAT_TEXT_MAX = 1000;
export const CHAT_THREAD_MAX = 80;

export class ProtocolError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.status = status;
  }
}

export type StoredChatMessage = {
  id: string;
  clientId: string | null;
  platformId: string;
  fromRole: "owner" | "agent";
  fromWallet: string | null;
  fromPlatformId: string | null;
  text: string;
  replyExpected: boolean;
  answeredAt: number | null;
  replyToId: string | null;
  createdAt: number;
};

export type ChatMessageView = {
  id: string;
  from: { role: "owner"; wallet: string } | { role: "agent"; platformId: string };
  text: string;
  replyExpected: boolean;
  answeredAt: number | null;
  replyToId: string | null;
  createdAt: number;
};

function unsupportedControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)) return true;
  }
  return false;
}

export function parseChatText(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolError("INVALID_PARAMS", "text is required.", 400);
  const text = value.trim();
  if (!text || text.length > CHAT_TEXT_MAX) {
    throw new ProtocolError("INVALID_PARAMS", `text must be 1–${CHAT_TEXT_MAX} characters.`, 400);
  }
  if (unsupportedControl(text)) {
    throw new ProtocolError("INVALID_PARAMS", "text contains unsupported control characters.", 400);
  }
  return text;
}

export function chatView(message: StoredChatMessage): ChatMessageView | null {
  if (message.fromRole === "owner") {
    if (!message.fromWallet) return null;
    return {
      id: message.id,
      from: { role: "owner", wallet: message.fromWallet },
      text: message.text,
      replyExpected: message.replyExpected,
      answeredAt: message.answeredAt,
      replyToId: message.replyToId,
      createdAt: message.createdAt,
    };
  }
  if (!message.fromPlatformId || message.fromPlatformId !== message.platformId) return null;
  return {
    id: message.id,
    from: { role: "agent", platformId: message.fromPlatformId },
    text: message.text,
    replyExpected: message.replyExpected,
    answeredAt: message.answeredAt,
    replyToId: message.replyToId,
    createdAt: message.createdAt,
  };
}

/** Messages the current owner is still waiting on. A previous owner's notes are not pending. */
export function pendingOwnerMessages(messages: ChatMessageView[], owner: string): ChatMessageView[] {
  return messages.filter(
    (message) =>
      message.from.role === "owner" &&
      message.from.wallet === owner &&
      message.replyExpected &&
      message.answeredAt == null
  );
}

function needsReply(message: StoredChatMessage): boolean {
  return message.fromRole === "owner" && message.replyExpected && message.answeredAt == null;
}

export function trimThread(messages: StoredChatMessage[]): StoredChatMessage[] {
  const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  if (ordered.length <= CHAT_THREAD_MAX) return ordered;
  const pending = ordered.filter(needsReply);
  const rest = ordered.filter((message) => !needsReply(message));
  const room = CHAT_THREAD_MAX - pending.length;
  if (room < 0) return pending.slice(pending.length - CHAT_THREAD_MAX);
  const kept = rest.slice(Math.max(0, rest.length - room));
  return [...kept, ...pending].sort((a, b) => a.createdAt - b.createdAt);
}

export function applyOwnerMessage(
  messages: StoredChatMessage[],
  message: StoredChatMessage
): { messages: StoredChatMessage[]; saved: StoredChatMessage } {
  if (message.clientId) {
    const existing = messages.find((row) => row.clientId === message.clientId && row.fromRole === "owner");
    if (existing) return { messages, saved: existing };
  }
  return { messages: trimThread([...messages, message]), saved: message };
}

export function applyAgentReply(
  messages: StoredChatMessage[],
  reply: StoredChatMessage
): { messages: StoredChatMessage[]; saved: StoredChatMessage } {
  if (reply.clientId) {
    const existing = messages.find((row) => row.clientId === reply.clientId && row.fromRole === "agent");
    if (existing) return { messages, saved: existing };
  }
  let next = messages;
  if (reply.replyToId) {
    const index = next.findIndex((row) => row.id === reply.replyToId);
    if (index < 0) throw new ProtocolError("NOT_FOUND", "That message is not in this thread.", 404);
    const target = next[index]!;
    if (target.fromRole !== "owner") {
      throw new ProtocolError("INVALID_PARAMS", "Reply to the owner's message.", 400);
    }
    if (target.answeredAt == null) {
      const copy = next.slice();
      copy[index] = { ...target, answeredAt: reply.createdAt };
      next = copy;
    }
  }
  return { messages: trimThread([...next, reply]), saved: reply };
}

export function closePending(messages: StoredChatMessage[], at: number): StoredChatMessage[] {
  return messages.map((message) => (needsReply(message) ? { ...message, answeredAt: at } : message));
}
