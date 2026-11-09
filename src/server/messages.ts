const SENSITIVE_KEY = /private.?key|mnemonic|seed|secret|api.?key|authorization.?key|openai|anthropic|model|prompt|password/i;

export function sensitiveKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) return key;
    const nested = sensitiveKey(child);
    if (nested) return nested;
  }
  return null;
}

const SECRET_TEXT =
  /(?:cag_|own_)[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:mnemonic|seed phrase|private key)\b/i;

export function secretMaterial(text: string): boolean {
  return SECRET_TEXT.test(text);
}

export function enrollMessage(owner: string, name: string, nonce: string): string {
  return `collective.agents.v1\naction: enroll\nowner: ${owner}\nname: ${name}\nnonce: ${nonce}`;
}

export function claimMessage(platformId: string, nonce: string): string {
  return `collective.agents.v1\naction: claim\nplatformId: ${platformId}\nnonce: ${nonce}`;
}

export function ownerSessionMessage(owner: string, nonce: string): string {
  return `collective.agents.v1\naction: owner-session\nowner: ${owner}\nnonce: ${nonce}`;
}

export function ownerCommandMessage(action: string, platformId: string, nonce: string, extra = ""): string {
  return `collective.agents.v1\naction: ${action}\nplatformId: ${platformId}\nnonce: ${nonce}${extra ? `\n${extra}` : ""}`;
}
