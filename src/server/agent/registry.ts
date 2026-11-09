import "server-only";
import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { taxonomyDomain, taxonomySkill } from "../../protocol/oasf-taxonomy";
import { hireCluster } from "../cluster";
import { AgentsError } from "../errors";
import { SOLANA_DEVNET, SOLANA_MAINNET } from "../jobs";
import { secretMaterial } from "../messages";
import { isSupervisor } from "../supervisor";
import type { StoredAgent } from "../store";

/**
 * Pinned mainnet Agent Registry program.
 * SDK cluster defaults have pointed at devnet before, so prepare never trusts them.
 * https://solana.com/agent-registry
 */
export const AGENT_REGISTRY_PROGRAM_ID = "8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ";
/** Present in the SDK config only. Registration leaves ATOM off. */
export const ATOM_ENGINE_PROGRAM_ID = "AToMw53aiPQ8j7iHVb4fGt6nzUNxUhcPc3tbPBZuzVVb";
/** Pinned devnet program from 8004-solana 0.8.5. The hackathon page registers here. */
export const DEVNET_AGENT_REGISTRY_PROGRAM_ID = "8oo4J9tBB3Hna1jRQ3rWvJjojqM5DYTDJo5cejUuJy3C";
export const DEVNET_ATOM_ENGINE_PROGRAM_ID = "AToMufS4QD6hEXvcvBDg9m1AHeCLpmZQsyfYa5h9MwAF";
/** Published on a marketing page. It is not the SDK devnet program. */
const REJECTED_REGISTRY_PROGRAM_ID = "6MuHv4dY4p9E4hSCEPr9dgbCSpMhq8x1vrUexbMVjfw1";

export type RegistryTarget = {
  cluster: "mainnet" | "devnet";
  sdkCluster: "mainnet-beta" | "devnet";
  programId: string;
  atomEngine: string;
  chain: string;
  scanChainId: number;
};

const MAINNET_REGISTRY: RegistryTarget = {
  cluster: "mainnet",
  sdkCluster: "mainnet-beta",
  programId: AGENT_REGISTRY_PROGRAM_ID,
  atomEngine: ATOM_ENGINE_PROGRAM_ID,
  chain: SOLANA_MAINNET,
  scanChainId: 101,
};

const DEVNET_REGISTRY: RegistryTarget = {
  cluster: "devnet",
  sdkCluster: "devnet",
  programId: DEVNET_AGENT_REGISTRY_PROGRAM_ID,
  atomEngine: DEVNET_ATOM_ENGINE_PROGRAM_ID,
  chain: SOLANA_DEVNET,
  scanChainId: 103,
};

/** The request cluster. A stored agent keeps the cluster it was enrolled on. */
export function activeRegistry(): RegistryTarget {
  return hireCluster() === "devnet" ? DEVNET_REGISTRY : MAINNET_REGISTRY;
}

export function registryForAgent(agent: { network?: string | null }): RegistryTarget {
  return agent.network === "devnet" ? DEVNET_REGISTRY : MAINNET_REGISTRY;
}

export type RegistrationService = {
  name: string;
  endpoint: string;
  version?: string;
  skills?: string[];
  domains?: string[];
};

/**
 * OASF service in the registration file, as published in the ERC-8004 registration guide.
 * Skill and domain strings are paths from the agntcy/oasf tag v0.8.0.
 * The schema browser is https://schema.oasf.outshift.com/0.8.0.
 */
export const OASF_TAXONOMY_ENDPOINT = "https://github.com/agntcy/oasf/";
export const OASF_TAXONOMY_VERSION = "v0.8.0";

export type RegistrationFile = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  name: string;
  description: string;
  services: RegistrationService[];
  x402Support: true;
  active: boolean;
  registrations: { agentId: string; agentRegistry: string }[];
  supportedTrust: ["reputation"];
};

export type PreparedRegistry = {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  asset: string;
  uri: string;
  programId: string;
};

type RegistryInstruction = {
  programId: string;
  accounts: string[];
  data: Buffer;
};

type RegistryParts = {
  accountKeys: string[];
  signerCount: number;
  instructions: RegistryInstruction[];
};

type ReadableMessage = {
  staticAccountKeys: PublicKey[];
  header: { numRequiredSignatures: number };
  compiledInstructions: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[];
  serialize(): Uint8Array;
};

/** sha256("global:register_with_options")[0..8], the instruction this SDK uses when ATOM is off. */
const REGISTER_WITH_OPTIONS = Buffer.from([177, 175, 96, 41, 59, 166, 13, 6]);
const REGISTER_ASSET_ACCOUNT = 3;
const REGISTER_OWNER_ACCOUNT = 5;

type SdkPrepared = {
  transaction?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  signed?: boolean;
  success?: boolean;
  asset?: PublicKey;
};

function siteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new AgentsError("REGISTRY_UNAVAILABLE", "The public site URL is not configured.", 503);
  }
  return "http://localhost:3000";
}

export function registrationUri(platformId: string): string {
  return `${siteOrigin()}/api/agents/v1/agents/${encodeURIComponent(platformId)}/registration`;
}

export function registrationOrigin(): string {
  return siteOrigin();
}

/** The platform id is accepted only when the URI is exactly the registration URL we issued. */
export function registrationPlatformId(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  let origin: string;
  try {
    origin = siteOrigin();
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  const marker = "/api/agents/v1/agents/";
  const tail = "/registration";
  if (!url.pathname.startsWith(marker) || !url.pathname.endsWith(tail)) return null;
  let platformId = "";
  try {
    platformId = decodeURIComponent(url.pathname.slice(marker.length, -tail.length));
  } catch {
    return null;
  }
  if (!/^agt_[A-Za-z0-9_-]{8,64}$/.test(platformId)) return null;
  if (uri !== registrationUri(platformId)) return null;
  return platformId;
}

function listedTaxonomy(values: unknown, accept: (value: string) => string | null): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const accepted = accept(value);
    if (!accepted || out.includes(accepted)) continue;
    out.push(accepted);
    if (out.length === 8) break;
  }
  return out;
}

function publicText(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed || secretMaterial(trimmed)) return fallback;
  return trimmed.slice(0, 200);
}

export function registryProgramIds(): { agentRegistry: string; atomEngine: string } {
  const active = activeRegistry();
  return {
    agentRegistry: active.programId,
    atomEngine: active.atomEngine,
  };
}

export function registrationDocument(agent: StoredAgent): RegistrationFile {
  const asset = agent.registryAsset || agent.registryPendingAsset || "";
  const target = registryForAgent(agent);
  const profilePath = target.cluster === "devnet" ? "/devnet/hire/" : "/agents/";
  const profile = `${siteOrigin()}${profilePath}${encodeURIComponent(agent.platformId)}`;
  const services: RegistrationService[] = [{ name: "web", endpoint: profile }];
  const skills = isSupervisor(agent.platformId) ? [] : listedTaxonomy(agent.directorySkills, taxonomySkill);
  const domains = isSupervisor(agent.platformId) ? [] : listedTaxonomy(agent.directoryDomains, taxonomyDomain);
  if (skills.length > 0) {
    const oasf: RegistrationService = {
      name: "OASF",
      endpoint: OASF_TAXONOMY_ENDPOINT,
      version: OASF_TAXONOMY_VERSION,
      skills,
    };
    if (domains.length > 0) oasf.domains = domains;
    services.push(oasf);
  }
  if (agent.endpointVerifiedAt && agent.endpoint?.startsWith("https://") && !secretMaterial(agent.endpoint)) {
    services.push({ name: "A2A", endpoint: agent.endpoint });
  }
  if (agent.walletAddress && !secretMaterial(agent.walletAddress)) {
    services.push({ name: "agentWallet", endpoint: `${target.chain}:${agent.walletAddress}` });
  }
  const registrations = asset
    ? [{ agentId: asset, agentRegistry: `${target.chain}:${target.programId}` }]
    : [];
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: publicText(agent.name, "Collective agent"),
    description: publicText(agent.publicDescription ?? "", "Collective agent. The owner chose the model that answers for it."),
    services,
    x402Support: true,
    active: agent.status === "active" || agent.status === "pending_credential",
    registrations,
    supportedTrust: ["reputation"],
  };
}

export function withIdentifier(system: string, asset: string | null | undefined): string {
  if (!asset) return system;
  let canonical = "";
  try {
    const key = new PublicKey(asset);
    if (!PublicKey.isOnCurve(key.toBytes())) return system;
    canonical = key.toBase58();
  } catch {
    return system;
  }
  return `${system}\n\n## Public identifier\n${canonical}\nThis Solana agent-registry asset is the public identifier. The platform id stays internal.`;
}

export function payloadHasSecret(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/secret|private.?key|mnemonic|seed/i.test(key)) return true;
    if (typeof child === "string" && key !== "transaction" && /BEGIN [A-Z ]*PRIVATE KEY|secretKey|\bmnemonic\b/.test(child)) {
      return true;
    }
    if (child && typeof child === "object" && payloadHasSecret(child)) return true;
  }
  return false;
}

function registrationInstruction(
  instruction: RegistryInstruction,
  uri: string,
  asset: string,
  owner: string,
  programId: string
): "ok" | "atom" | "no" {
  if (instruction.programId !== programId) return "no";
  const uriBytes = Buffer.from(uri, "utf8");
  const data = instruction.data;
  const expected = 8 + 4 + uriBytes.length + 1;
  if (data.length !== expected || !data.subarray(0, 8).equals(REGISTER_WITH_OPTIONS)) return "no";
  if (data.readUInt32LE(8) !== uriBytes.length) return "no";
  if (!data.subarray(12, 12 + uriBytes.length).equals(uriBytes)) return "no";
  if (instruction.accounts[REGISTER_ASSET_ACCOUNT] !== asset || instruction.accounts[REGISTER_OWNER_ACCOUNT] !== owner) return "no";
  const atom = data[data.length - 1];
  if (atom === 1) return "atom";
  if (atom !== 0) return "no";
  return "ok";
}

export function registryMatch(input: RegistryParts & {
  owner: string;
  asset: string;
  uri: string;
  failed: boolean;
}): string | null {
  if (input.failed) return "The registry transaction failed.";
  if (input.signerCount < 2 || input.accountKeys.length < input.signerCount) {
    return "The registry transaction is missing its signers.";
  }
  const signers = input.accountKeys.slice(0, input.signerCount);
  if (signers[0] !== input.owner) return "The registry transaction was not paid by the agent owner.";
  if (!signers.includes(input.asset)) return "The asset key did not sign the registry transaction.";
  const active = activeRegistry();
  const foreign = active.cluster === "devnet"
    ? [AGENT_REGISTRY_PROGRAM_ID, REJECTED_REGISTRY_PROGRAM_ID]
    : [DEVNET_AGENT_REGISTRY_PROGRAM_ID, REJECTED_REGISTRY_PROGRAM_ID];
  if (input.accountKeys.some((key) => foreign.includes(key))) {
    return active.cluster === "devnet"
      ? "The registry transaction used a different cluster."
      : "The registry transaction used a devnet program.";
  }
  if (input.instructions.some((instruction) => instruction.programId === active.atomEngine)) {
    return "The registry transaction enabled ATOM.";
  }
  const found = input.instructions.map((instruction) =>
    registrationInstruction(instruction, input.uri, input.asset, input.owner, active.programId)
  );
  if (found.includes("atom")) return "The registry transaction enabled ATOM.";
  if (!found.includes("ok")) return "The registry transaction did not register this agent.";
  return null;
}

export function inspectRegistryTransaction(base64: string): RegistryParts {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    throw new AgentsError("REGISTRY_UNAVAILABLE", "The registry transaction was not usable.", 503);
  }
  if (bytes.length < 10 || bytes.length > 1232) {
    throw new AgentsError("REGISTRY_UNAVAILABLE", "The registry transaction was not usable.", 503);
  }
  try {
    return readMessage(Transaction.from(bytes).compileMessage());
  } catch {
    try {
      return readMessage(VersionedTransaction.deserialize(bytes).message);
    } catch {
      throw new AgentsError("REGISTRY_UNAVAILABLE", "The registry transaction was not usable.", 503);
    }
  }
}

function readMessage(message: ReadableMessage, loaded: string[] = []): RegistryParts {
  const accountKeys = message.staticAccountKeys.map((key) => key.toBase58());
  return {
    accountKeys: [...accountKeys, ...loaded],
    signerCount: message.header.numRequiredSignatures,
    instructions: message.compiledInstructions.map((instruction) => ({
      programId: accountKeys[instruction.programIdIndex] ?? "",
      accounts: instruction.accountKeyIndexes.map((index) => accountKeys[index] ?? ""),
      data: Buffer.from(instruction.data),
    })),
  };
}

function signingKey(value: string, label: string): PublicKey {
  try {
    const key = new PublicKey(value);
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error("off curve");
    return key;
  } catch (error) {
    if (error instanceof AgentsError) throw error;
    throw new AgentsError("INVALID_PARAMS", `${label} is not a signing key.`, 400);
  }
}

export async function prepareRegistryRegistration(agent: StoredAgent, asset: string): Promise<PreparedRegistry> {
  if (agent.registryAsset) {
    throw new AgentsError("ALREADY_REGISTERED", "This agent already has a registry identifier.", 409);
  }
  const active = activeRegistry();
  if (active.programId === REJECTED_REGISTRY_PROGRAM_ID) {
    throw new AgentsError("REGISTRY_UNAVAILABLE", "The registry program is not the pinned program.", 503);
  }
  if (registryForAgent(agent).cluster !== active.cluster) {
    throw new AgentsError("NOT_FOUND", "Agent not found.", 404);
  }
  const assetKey = signingKey(asset, "Asset");
  const ownerKey = signingKey(agent.owner, "Owner");
  const uri = registrationUri(agent.platformId);
  if (Buffer.byteLength(uri) > 200) {
    throw new AgentsError("REGISTRY_UNAVAILABLE", "The registration address is too long for the registry.", 503);
  }
  let prepared: SdkPrepared;
  try {
    const { clusterRpcUrl } = await import("../host");
    const { SolanaSDK } = await import("8004-solana");
    const sdk = new SolanaSDK({
      cluster: active.sdkCluster,
      rpcUrl: clusterRpcUrl(active.cluster),
      programIds: { agentRegistry: active.programId, atomEngine: active.atomEngine },
      useIndexer: false,
      forceOnChain: true,
    });
    prepared = await sdk.registerAgent(uri, {
      skipSend: true,
      signer: ownerKey,
      assetPubkey: assetKey,
      atomEnabled: false,
    });
  } catch (error) {
    console.error("[agents] registry prepare failed", error instanceof Error ? error.name : "error");
    throw new AgentsError("REGISTRY_UNAVAILABLE", "The agent registry could not prepare a transaction.", 503);
  }
  const lastValidBlockHeight = prepared?.lastValidBlockHeight;
  if (
    !prepared ||
    prepared.success === false ||
    prepared.signed !== false ||
    typeof prepared.transaction !== "string" ||
    typeof prepared.blockhash !== "string" ||
    typeof lastValidBlockHeight !== "number" ||
    !Number.isSafeInteger(lastValidBlockHeight)
  ) {
    console.error("[agents] registry prepare rejected");
    throw new AgentsError("REGISTRY_UNAVAILABLE", "The agent registry could not prepare a transaction.", 503);
  }
  if (payloadHasSecret(prepared)) {
    throw new AgentsError("REGISTRY_UNAVAILABLE", "The registry response was refused.", 503);
  }
  const returnedAsset = prepared.asset instanceof PublicKey ? prepared.asset.toBase58() : "";
  if (returnedAsset !== assetKey.toBase58()) {
    throw new AgentsError("REGISTRY_UNAVAILABLE", "The registry prepared a different identifier.", 503);
  }
  const inspected = inspectRegistryTransaction(prepared.transaction);
  const problem = registryMatch({
    ...inspected,
    owner: ownerKey.toBase58(),
    asset: assetKey.toBase58(),
    uri,
    failed: false,
  });
  if (problem) throw new AgentsError("REGISTRY_UNAVAILABLE", problem, 503);
  return {
    transaction: prepared.transaction,
    blockhash: prepared.blockhash,
    lastValidBlockHeight,
    asset: assetKey.toBase58(),
    uri,
    programId: active.programId,
  };
}

export async function confirmedRegistryTransaction(connection: Connection, signature: string): Promise<RegistryParts & { failed: boolean }> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(signature)) {
    throw new AgentsError("INVALID_PARAMS", "Signature is not a transaction signature.", 400);
  }
  let tx: Awaited<ReturnType<Connection["getTransaction"]>>;
  try {
    tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (error) {
    console.error("[agents] registry confirm failed", error instanceof Error ? error.name : "error");
    throw new AgentsError("REGISTRY_UNAVAILABLE", "The registry transaction could not be read.", 503);
  }
  if (!tx) throw new AgentsError("UNCONFIRMED", "The registry transaction is not confirmed yet.", 400);
  const loaded = [...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])].map((key) =>
    key.toBase58()
  );
  return {
    ...readMessage(tx.transaction.message, loaded),
    failed: tx.meta?.err != null,
  };
}
