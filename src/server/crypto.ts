import crypto from "crypto";
import bs58 from "bs58";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function randomId(prefix: string, bytes = 16): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString("base64url")}`;
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

export function verifyEd25519Bytes(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

export function verifyEd25519(publicKey: Uint8Array, message: string, signature: Uint8Array): boolean {
  return verifyEd25519Bytes(publicKey, Buffer.from(message, "utf8"), signature);
}

export function verifyWalletSignature(owner: string, message: string, signature: string): boolean {
  try {
    return verifyEd25519(bs58.decode(owner), message, bs58.decode(signature));
  } catch {
    return false;
  }
}

export function canonicalPubkey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const bytes = bs58.decode(value);
    if (bytes.length !== 32) return null;
    const again = bs58.encode(bytes);
    return again === value ? value : null;
  } catch {
    return null;
  }
}
