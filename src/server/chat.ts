import {
  applyAgentReply as applyAgentReplyProtocol,
  applyOwnerMessage,
  chatView,
  closePending,
  parseChatText as parseChatTextProtocol,
  pendingOwnerMessages,
  ProtocolError,
  trimThread,
  type ChatMessageView,
  type StoredChatMessage,
} from "../protocol";
import { AgentsError } from "./errors";

export {
  applyOwnerMessage,
  chatView,
  closePending,
  pendingOwnerMessages,
  trimThread,
  type ChatMessageView,
  type StoredChatMessage,
};

function rethrow(error: unknown): never {
  if (error instanceof ProtocolError) throw new AgentsError(error.code, error.message, error.status);
  throw error;
}

export function parseChatText(value: unknown): string {
  try {
    return parseChatTextProtocol(value);
  } catch (error) {
    rethrow(error);
  }
}

export function applyAgentReply(
  messages: StoredChatMessage[],
  reply: StoredChatMessage
): { messages: StoredChatMessage[]; saved: StoredChatMessage } {
  try {
    return applyAgentReplyProtocol(messages, reply);
  } catch (error) {
    rethrow(error);
  }
}
