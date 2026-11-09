import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "./crypto";

export type XmtpPointer = {
  kind: "pointer";
  fromPlatformId: string;
  toPlatformId: string;
  messageId: string;
  jobId: string;
  turn: string;
};

export type XmtpText = {
  kind: "text";
  fromPlatformId: string;
  toPlatformId: string;
  messageId: string;
  text: string;
};

export type XmtpDelivery = XmtpPointer | XmtpText;

export type XmtpGateway = {
  send(delivery: XmtpDelivery): Promise<void>;
};

let gateway: XmtpGateway | null = null;

export function useXmtpGateway(next: XmtpGateway | null): void {
  gateway = next;
}

function inboxKey(): Buffer {
  const raw = process.env.AGENT_INBOX_KEY?.trim();
  if (raw) return Buffer.from(sha256Hex(raw), "hex");
  const directory = path.join(process.cwd(), ".xmtp");
  const file = path.join(directory, "seal.key");
  try {
    const existing = readFileSync(file);
    if (existing.length === 32) return existing;
  } catch {
    // The first thread creates the local seal.
  }
  mkdirSync(directory, { recursive: true });
  const created = randomBytes(32);
  writeFileSync(file, created, { mode: 0o600 });
  return created;
}

/** 32 bytes that seal XMTP identity keys. A configured key wins; otherwise the local seal file is used. */
export function messagingKey(): Uint8Array {
  return new Uint8Array(inboxKey());
}

/** Encrypt a messaging key. The agent and the browser never receive it. */
export function sealInboxKey(plaintext: string): string | null {
  const key = inboxKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${body.toString("base64url")}`;
}

export function openInboxKey(sealed: string): string | null {
  const key = inboxKey();
  const [iv, tag, body] = sealed.split(".");
  if (!iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function pairId(a: string, b: string): string {
  return [a, b].sort().join("__");
}

/**
 * Deliver on XMTP when a client is configured.
 * A conversation carries its text. A job wake carries only the pointer.
 * XMTP_ENV still selects this pointer gateway. The owner thread uses XMTP_API_URL.
 */
export async function deliverXmtp(delivery: XmtpDelivery): Promise<"sent" | "skipped"> {
  const env = process.env.XMTP_ENV?.trim();
  if (!env) return "skipped";
  if (gateway) {
    await gateway.send(delivery);
    return "sent";
  }
  return "skipped";
}
