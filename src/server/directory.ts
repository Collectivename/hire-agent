import "server-only";
import { PublicKey } from "@solana/web3.js";
import { taxonomySkill } from "../protocol/oasf-taxonomy";
import type { DirectoryHit } from "../protocol";
import { AgentsError } from "./errors";
import { loadWorkspace } from "./agent/persist";
import { agentStore, type StoredAgent } from "./store";
import { agentMatchesCluster } from "./cluster";
import {
  activeRegistry,
  registrationDocument,
  registrationOrigin,
  registrationPlatformId,
} from "./agent/registry";
import { isSupervisor } from "./supervisor";

/** Public 8004scan list. chain_id 101 is Solana mainnet on that API. */
export const SCAN_DIRECTORY_URL = "https://api.8004scan.io/api/v1/agents";
export const SOLANA_SCAN_CHAIN_ID = 101;
/** Metaplex Core program. Pinned to the same id the registry SDK uses. */
export const MPL_CORE_PROGRAM_ID = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const CORE_ASSET_KEY = 1;
/**
 * AssetV1 stores name and uri as Borsh strings and publishes no maximum.
 * The registry account caps its URI at 250 and its name at 32.
 * These bounds only reject a corrupt length prefix.
 */
const CORE_NAME_MAX = 200;
const CORE_URI_MAX = 250;
/** AgentAccount discriminator from 8004-solana 0.8.5. */
const AGENT_ACCOUNT_DISCRIMINATOR = Buffer.from([241, 119, 69, 140, 233, 9, 112, 50]);
const REGISTRY_URI_MAX = 250;
const REGISTRY_NAME_MAX = 32;
const REGISTRY_POINTER_MAX = 128;
const SCAN_PAGE_LIMIT = 20;
const SCAN_PAGE_CAP = 5;

export type RegistryRecord = {
  asset: string;
  owner: string;
  uri: string;
  atom: number;
  bump: number;
};

export type DirectoryIo = {
  list(skill: string, endpointHost: string): Promise<{ assets: string[]; complete: boolean }>;
  readAsset(asset: string): Promise<{ owner: string; uri: string } | null>;
  readRecord(asset: string): Promise<RegistryRecord | null>;
};

/**
 * AssetV1 prefix: key, owner, update authority, name, uri.
 * Update authority is 0, or 1/2 followed by a pubkey. Plugin bytes after the prefix are ignored.
 */
export function readCoreAsset(data: Uint8Array): { owner: string; uri: string } | null {
  const buf = Buffer.from(data);
  let offset = 0;
  const take = (size: number): Buffer | null => {
    if (size < 0 || offset + size > buf.length) return null;
    const slice = buf.subarray(offset, offset + size);
    offset += size;
    return slice;
  };
  const key = take(1);
  const ownerBytes = take(32);
  const authority = take(1);
  if (!key || key[0] !== CORE_ASSET_KEY || !ownerBytes || !authority || authority[0] > 2) return null;
  if (authority[0] !== 0 && !take(32)) return null;
  const name = readLengthPrefixed(buf, offset, CORE_NAME_MAX);
  if (!name) return null;
  offset = name.next;
  const uri = readLengthPrefixed(buf, offset, CORE_URI_MAX);
  if (!uri) return null;
  try {
    return { owner: new PublicKey(ownerBytes).toBase58(), uri: uri.text };
  } catch {
    return null;
  }
}

function readLengthPrefixed(buf: Buffer, offset: number, max: number): { text: string; next: number } | null {
  if (offset + 4 > buf.length) return null;
  const length = buf.readUInt32LE(offset);
  const start = offset + 4;
  if (length > max || start + length > buf.length) return null;
  const bytes = buf.subarray(start, start + length);
  const text = bytes.toString("utf8");
  if (Buffer.byteLength(text) !== length) return null;
  return { text, next: start + length };
}

export function parseScanPage(body: unknown): { assets: string[]; cursor: string | null; hasMore: boolean } {
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) {
    throw new AgentsError("DIRECTORY_UNAVAILABLE", "The skill index did not return agents.", 503);
  }
  const record = body as { items: unknown[]; next_cursor?: unknown; has_more?: unknown };
  const assets: string[] = [];
  for (const item of record.items) {
    if (!item || typeof item !== "object") continue;
    const row = item as { agent_id?: unknown; chain_id?: unknown; chain_type?: unknown; contract_address?: unknown };
    const target = activeRegistry();
    if (row.chain_id !== target.scanChainId && row.chain_id !== String(target.scanChainId)) continue;
    if (row.chain_type != null && row.chain_type !== "solana") continue;
    if (row.contract_address !== target.programId) continue;
    const asset = onCurveKey(row.agent_id);
    if (asset && !assets.includes(asset)) assets.push(asset);
  }
  const cursor = typeof record.next_cursor === "string" && record.next_cursor ? record.next_cursor : null;
  return { assets, cursor, hasMore: record.has_more === true && cursor != null };
}

function onCurveKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const key = new PublicKey(value);
    if (!PublicKey.isOnCurve(key.toBytes())) return null;
    return key.toBase58();
  } catch {
    return null;
  }
}

function sameKey(left: string, right: string): boolean {
  try {
    return new PublicKey(left).equals(new PublicKey(right));
  } catch {
    return false;
  }
}

/**
 * Seeds ["agent", asset] under the pinned registry program.
 * Confirmed against mainnet account 2YvWXCVXsaYNewMTkRdA8Gx9uX9FXxUxPu4X47BsBj4X.
 */
export function registryAgentAddress(asset: string): { address: string; bump: number } | null {
  const key = onCurveKey(asset);
  if (!key) return null;
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), new PublicKey(key).toBytes()],
    new PublicKey(activeRegistry().programId)
  );
  return { address: pda.toBase58(), bump };
}

/**
 * AgentAccount prefix from 8004-solana 0.8.5.
 * Bytes after the collection pointer are ignored. The live account carries extra trailing bytes.
 */
export function readRegistryRecord(data: Uint8Array): RegistryRecord | null {
  const buf = Buffer.from(data);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(AGENT_ACCOUNT_DISCRIMINATOR)) return null;
  let offset = 8 + 32 + 32;
  const ownerBytes = buf.subarray(offset, offset + 32);
  offset += 32;
  const assetBytes = buf.subarray(offset, offset + 32);
  offset += 32;
  if (ownerBytes.length !== 32 || assetBytes.length !== 32 || offset + 2 > buf.length) return null;
  const bump = buf[offset] ?? 0;
  const atom = buf[offset + 1] ?? 0;
  offset += 2;
  const walletTag = buf[offset];
  offset += 1;
  if (walletTag === 1) offset += 32;
  else if (walletTag !== 0) return null;
  offset += 32 + 8 + 32 + 8 + 32 + 8;
  if (offset >= buf.length) return null;
  const parentTag = buf[offset];
  offset += 1;
  if (parentTag === 1) offset += 32;
  else if (parentTag !== 0) return null;
  offset += 2;
  const uri = readLengthPrefixed(buf, offset, REGISTRY_URI_MAX);
  if (!uri) return null;
  const name = readLengthPrefixed(buf, uri.next, REGISTRY_NAME_MAX);
  if (!name) return null;
  const pointer = readLengthPrefixed(buf, name.next, REGISTRY_POINTER_MAX);
  if (!pointer) return null;
  try {
    return {
      asset: new PublicKey(assetBytes).toBase58(),
      owner: new PublicKey(ownerBytes).toBase58(),
      uri: uri.text,
      atom,
      bump,
    };
  } catch {
    return null;
  }
}

function hireableStatus(status: string): boolean {
  return status === "active" || status === "pending_credential";
}

/**
 * Chain membership, without a skill filter. The registry account and the asset both
 * point at our registration file, the owner matches, and ATOM is off.
 */
export function verifiedListing(input: {
  asset: string;
  chainOwner: string;
  chainUri: string;
  record: RegistryRecord | null;
  agent: StoredAgent | null;
}): DirectoryHit | null {
  const asset = onCurveKey(input.asset);
  const derived = asset ? registryAgentAddress(asset) : null;
  if (!asset || !derived || !input.record || !input.agent || !hireableStatus(input.agent.status)) return null;
  if (isSupervisor(input.agent.platformId)) return null;
  if (!agentMatchesCluster(input.agent)) return null;
  if (input.record.atom !== 0 || input.record.bump !== derived.bump) return null;
  if (!sameKey(input.record.asset, asset) || !sameKey(input.record.owner, input.chainOwner)) return null;
  if (input.record.uri !== input.chainUri) return null;
  if (!sameKey(input.agent.registryAsset ?? "", asset) || !sameKey(input.agent.owner, input.chainOwner)) return null;
  if (registrationPlatformId(input.chainUri) !== input.agent.platformId) return null;
  const file = registrationDocument(input.agent);
  const oasf = file.services.find((service) => service.name === "OASF");
  if (!oasf?.skills?.length) return null;
  const registration = file.registrations.find(
    (item) => sameKey(item.agentId, asset) && item.agentRegistry.endsWith(`:${activeRegistry().programId}`)
  );
  if (!registration) return null;
  return {
    platformId: input.agent.platformId,
    asset,
    owner: new PublicKey(input.chainOwner).toBase58(),
    uri: input.chainUri,
    skills: oasf.skills,
    domains: oasf.domains ?? [],
    name: input.agent.name,
    description: input.agent.publicDescription?.trim() || undefined,
  };
}

/** Exact skill, the same category, or a related skill such as image generation for a logo. */
export function listedForSkill(skills: readonly string[], needed: string): boolean {
  const skill = taxonomySkill(needed);
  if (!skill) return false;
  if (skills.includes(skill)) return true;
  const category = skill.split("/").slice(0, -1).join("/");
  if (skills.some((held) => taxonomySkill(held)?.startsWith(`${category}/`))) return true;
  const focus = (skill.split("/").pop() ?? "").split("_").filter((part) => part.length >= 5);
  return skills.some((held) => {
    const last = (taxonomySkill(held)?.split("/").pop() ?? "").split("_");
    return last.some((part) => part.length >= 5 && focus.some((token) => part.startsWith(token) || token.startsWith(part)));
  });
}

/**
 * A scan row is a candidate. Membership requires the registry program's agent account
 * for that asset, the Core asset, and the registration file we serve.
 */
export function acceptListedAgent(input: {
  asset: string;
  chainOwner: string;
  chainUri: string;
  record: RegistryRecord | null;
  agent: StoredAgent | null;
  skill: string;
}): DirectoryHit | null {
  const skill = taxonomySkill(input.skill);
  const hit = skill ? verifiedListing(input) : null;
  if (!skill || !hit?.skills.includes(skill)) return null;
  return hit;
}

async function listScan(skill: string, endpointHost: string): Promise<{ assets: string[]; complete: boolean }> {
  const assets: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let page = 0; page < SCAN_PAGE_CAP; page += 1) {
      const url = new URL(SCAN_DIRECTORY_URL);
      url.searchParams.set("chain_id", String(activeRegistry().scanChainId));
      url.searchParams.set("oasf_skill", skill);
      url.searchParams.set("search", endpointHost);
      url.searchParams.set("search_type", "text");
      url.searchParams.set("search_fields", "endpoints");
      url.searchParams.set("limit", String(SCAN_PAGE_LIMIT));
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { accept: "application/json" },
      });
      if (res.status >= 300 && res.status < 400) {
        throw new AgentsError("DIRECTORY_UNAVAILABLE", "The skill index redirected.", 503);
      }
      if (!res.ok) throw new AgentsError("DIRECTORY_UNAVAILABLE", "The skill index could not be read.", 503);
      const parsed = parseScanPage(await res.json().catch(() => null));
      for (const asset of parsed.assets) {
        if (!assets.includes(asset)) assets.push(asset);
      }
      if (!parsed.hasMore || !parsed.cursor || seenCursors.has(parsed.cursor)) return { assets, complete: true };
      seenCursors.add(parsed.cursor);
      cursor = parsed.cursor;
    }
  } catch (error) {
    if (error instanceof AgentsError) throw error;
    console.error("[agents] directory search failed", error instanceof Error ? error.name : "error");
    throw new AgentsError("DIRECTORY_UNAVAILABLE", "The skill index could not be read.", 503);
  }
  return { assets, complete: false };
}

async function accountInfo(address: string): Promise<{ owner: PublicKey; data: Uint8Array; executable: boolean } | null> {
  const { hireConnection } = await import("./host");
  return hireConnection().getAccountInfo(new PublicKey(address), "confirmed");
}

export async function readRegistryAsset(asset: string): Promise<{ owner: string; uri: string } | null> {
  let info: { owner: PublicKey; data: Uint8Array; executable: boolean } | null;
  try {
    info = await accountInfo(asset);
  } catch (error) {
    console.error("[agents] directory asset read failed", error instanceof Error ? error.name : "error");
    throw new AgentsError("DIRECTORY_UNAVAILABLE", "The registry asset could not be read.", 503);
  }
  if (!info || info.executable || info.owner.toBase58() !== MPL_CORE_PROGRAM_ID) return null;
  return readCoreAsset(info.data);
}

export async function readRegistryAccount(asset: string): Promise<RegistryRecord | null> {
  const derived = registryAgentAddress(asset);
  if (!derived) return null;
  let info: { owner: PublicKey; data: Uint8Array; executable: boolean } | null;
  try {
    info = await accountInfo(derived.address);
  } catch (error) {
    console.error("[agents] directory account read failed", error instanceof Error ? error.name : "error");
    throw new AgentsError("DIRECTORY_UNAVAILABLE", "The registry account could not be read.", 503);
  }
  if (!info || info.executable || info.owner.toBase58() !== activeRegistry().programId) return null;
  const record = readRegistryRecord(info.data);
  if (!record || record.bump !== derived.bump || !sameKey(record.asset, asset)) return null;
  return record;
}

/** Drop a stored skill listing so the registration file stops advertising the supervisor for hire. */
export async function unlistSupervisor(agent: StoredAgent): Promise<StoredAgent> {
  if (!isSupervisor(agent.platformId)) return agent;
  const skills = Array.isArray(agent.directorySkills) ? agent.directorySkills : [];
  const domains = Array.isArray(agent.directoryDomains) ? agent.directoryDomains : [];
  if (skills.length === 0 && domains.length === 0 && agent.directoryCid == null) return agent;
  const next = {
    ...agent,
    directorySkills: [] as string[],
    directoryDomains: [] as string[],
    directoryCid: null,
    updatedAt: Date.now(),
  };
  await agentStore().saveAgent(next);
  return next;
}

export async function searchDirectory(
  skillInput: string,
  io?: DirectoryIo
): Promise<{ skill: string; hits: DirectoryHit[]; complete: boolean }> {
  const skill = taxonomySkill(skillInput);
  if (!skill) throw new AgentsError("INVALID_PARAMS", "Skill must be an OASF 0.8 taxonomy path.", 400);
  const listed = await (io?.list ?? listScan)(skill, new URL(registrationOrigin()).host);
  const readAsset = io?.readAsset ?? readRegistryAsset;
  const readRecord = io?.readRecord ?? readRegistryAccount;
  const hits: DirectoryHit[] = [];
  for (const asset of listed.assets) {
    const [chain, record] = await Promise.all([readAsset(asset), readRecord(asset)]);
    if (!chain || !record) continue;
    const platformId = registrationPlatformId(record.uri);
    const loaded = platformId ? await agentStore().getAgent(platformId) : null;
    const agent = loaded ? await unlistSupervisor(loaded) : null;
    const hit = acceptListedAgent({ asset, chainOwner: chain.owner, chainUri: chain.uri, record, agent, skill });
    if (hit) hits.push(hit);
  }
  return { skill, hits, complete: listed.complete };
}

/** Agents published on Collective, verified on chain. An empty skill returns every listing. */
export async function browseDirectory(
  skillInput = "",
  io?: Pick<DirectoryIo, "readAsset" | "readRecord">
): Promise<{ skill: string; hits: DirectoryHit[]; complete: boolean }> {
  const requested = skillInput.trim();
  const skill = requested ? taxonomySkill(requested) : "";
  if (requested && !skill) throw new AgentsError("INVALID_PARAMS", "Skill must be an OASF 0.8 taxonomy path.", 400);
  const published = await agentStore().listPublished();
  const readAsset = io?.readAsset ?? readRegistryAsset;
  const readRecord = io?.readRecord ?? readRegistryAccount;
  const hits: DirectoryHit[] = [];
  await Promise.all(
    published.map(async (agent) => {
      const asset = agent.registryAsset ?? "";
      if (!asset) return;
      try {
        const [chain, record] = await Promise.all([readAsset(asset), readRecord(asset)]);
        if (!chain || !record) return;
        const hit = verifiedListing({
          asset,
          chainOwner: chain.owner,
          chainUri: chain.uri,
          record,
          agent,
        });
        if (!hit) return;
        if (skill && !listedForSkill(hit.skills, skill)) return;
        if (!hit.description) {
          const workspace = await loadWorkspace(agent.platformId, agent.name);
          const described = /^Description:\s*(.+)$/m.exec(workspace.files["IDENTITY.md"]?.content ?? "")?.[1]?.trim() ?? "";
          if (described) hit.description = described.slice(0, 280);
        }
        hits.push(hit);
      } catch (error) {
        if (error instanceof AgentsError && error.code === "DIRECTORY_UNAVAILABLE") return;
        throw error;
      }
    })
  );
  hits.sort((left, right) => (left.name ?? left.platformId).localeCompare(right.name ?? right.platformId));
  return { skill: skill || "", hits, complete: true };
}

/** Published Collective agents, plus the external skill index when a skill is chosen. */
export async function directoryResults(skillInput: string): Promise<{ skill: string; hits: DirectoryHit[]; complete: boolean }> {
  const listed = await browseDirectory(skillInput);
  if (!skillInput.trim()) return listed;
  try {
    const scanned = await searchDirectory(skillInput);
    const hits = [...listed.hits];
    for (const hit of scanned.hits) {
      if (!hits.some((row) => row.platformId === hit.platformId)) hits.push(hit);
    }
    return { skill: scanned.skill, hits, complete: listed.complete && scanned.complete };
  } catch {
    return { ...listed, complete: false };
  }
}
