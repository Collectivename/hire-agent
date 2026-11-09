import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AgentsError } from "./errors";

/** Hosts the agent runtime must not call. Shared by endpoint proof and MCP. */
export function blockedHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name.endsWith(".local") ||
    name.includes(":") ||
    /^\d+$/.test(name) ||
    name === "metadata.google.internal" ||
    name === "metadata.goog" ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/.test(name) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(name)
  ) {
    return true;
  }
  return isIP(name) ? blockedIp(name) : false;
}

export function blockedIp(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (isIP(address) !== 6) return true;
  const first = address.toLowerCase().split("%")[0]?.split(":")[0] ?? "";
  if (address === "::" || address === "::1") return true;
  if (address.toLowerCase().startsWith("::ffff:")) {
    const mapped = address.slice(7);
    return isIP(mapped) === 4 ? blockedIp(mapped) : true;
  }
  const value = Number.parseInt(first || "0", 16);
  if (!Number.isFinite(value)) return true;
  if (value >= 0xfe80 && value <= 0xfebf) return true;
  if (value >= 0xfc00 && value <= 0xfdff) return true;
  if (value >= 0xff00) return true;
  return false;
}

export function publicHttps(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AgentsError("INVALID_PARAMS", "Endpoint must be an https URL.", 400);
  }
  if (url.protocol !== "https:") throw new AgentsError("INVALID_PARAMS", "Endpoint must be https.", 400);
  if (blockedHost(url.hostname)) {
    throw new AgentsError("INVALID_PARAMS", "Endpoint must be a public https host.", 400);
  }
  return url.toString();
}

export async function assertPublicDns(endpoint: string): Promise<void> {
  const host = new URL(endpoint).hostname;
  if (isIP(host) && blockedIp(host)) {
    throw new AgentsError("INVALID_PARAMS", "Endpoint must be a public https host.", 400);
  }
  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new AgentsError("ENDPOINT_UNPROVED", "Endpoint host did not resolve.", 400);
  }
  if (records.length === 0 || records.some((record) => blockedIp(record.address))) {
    throw new AgentsError("INVALID_PARAMS", "Endpoint must be a public https host.", 400);
  }
}
