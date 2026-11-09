import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { runWithHireCluster } from "../src/server/cluster";
import { sha256Hex } from "../src/server/crypto";
import { handleAgentsRequest } from "../src/server/router";
import { agentStore, type StoredAgent } from "../src/server/store";
import {
  AGENT_REGISTRY_PROGRAM_ID,
  ATOM_ENGINE_PROGRAM_ID,
  inspectRegistryTransaction,
  payloadHasSecret,
  registrationDocument,
  registrationUri,
  registryMatch,
  registryProgramIds,
} from "../src/server/agent/registry";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const DEVNET_REGISTRY = "8oo4J9tBB3Hna1jRQ3rWvJjojqM5DYTDJo5cejUuJy3C";
const platformId = "agt_registrycheck";
const owner = Keypair.generate();
const asset = Keypair.generate();
const uri = registrationUri(platformId);

const refusedPrograms: string[] = [DEVNET_REGISTRY, "6MuHv4dY4p9E4hSCEPr9dgbCSpMhq8x1vrUexbMVjfw1"];
assert(!refusedPrograms.includes(AGENT_REGISTRY_PROGRAM_ID), "registry program is a devnet id");

const agent = {
  platformId,
  owner: owner.publicKey.toBase58(),
  name: "private key agent",
  endpoint: "https://agent.example/a2a",
  endpointVerifiedAt: 1,
  walletAddress: asset.publicKey.toBase58(),
  walletProvider: "privy",
  providerWalletId: "privy-wallet",
  retiredWallets: [],
  status: "active",
  slimName: `collective/agents/service/${platformId}`,
  directoryCid: null,
  oasf: null,
  runtimePublicKey: null,
  signCredentialIssuedAt: null,
  claimNonce: null,
  registryPendingAsset: asset.publicKey.toBase58(),
  createdAt: 1,
  updatedAt: 1,
} as StoredAgent;

const document = registrationDocument(agent);
const encoded = JSON.stringify(document);
assert(document.type === "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", "registration type");
assert(document.name === "Collective agent", "secret-looking name was published");
assert(document.x402Support === true, "x402 support");
assert(document.active === true, "active flag");
assert(document.supportedTrust[0] === "reputation", "trust model");
assert(document.services.some((service) => service.name === "web" && service.endpoint.includes(platformId)), "profile link");
assert(!document.services.some((service) => service.name === "OASF"), "oasf service stays off until a taxonomy skill is listed");
assert(document.services.some((service) => service.name === "A2A" && service.endpoint === agent.endpoint), "a2a service");
assert(document.registrations.length === 1, "registration entry");
assert(document.registrations[0]?.agentId === asset.publicKey.toBase58(), "asset id");
assert(document.registrations[0]?.agentRegistry.includes(AGENT_REGISTRY_PROGRAM_ID), "mainnet registry");
assert(!document.registrations[0]?.agentRegistry.includes(DEVNET_REGISTRY), "devnet registry");
assert(!encoded.includes("secretKey") && !encoded.includes("private key") && !encoded.includes("cag_"), "registration leaked secret material");
assert(uri.endsWith(`/api/agents/v1/agents/${platformId}/registration`), "registration uri");

assert(payloadHasSecret({ transaction: "abc", secretKey: "nope" }), "secret field was accepted");
assert(!payloadHasSecret({ transaction: "secretKey", signed: false, asset: asset.publicKey.toBase58() }), "transaction text was treated as a secret field");

const REGISTER_WITH_OPTIONS = Buffer.from([177, 175, 96, 41, 59, 166, 13, 6]);

function registerData(atom: number): Buffer {
  const uriBytes = Buffer.from(uri, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(uriBytes.length);
  return Buffer.concat([REGISTER_WITH_OPTIONS, length, uriBytes, Buffer.from([atom])]);
}

function unsigned(programId: string, atom = 0): string {
  const filler = Keypair.generate().publicKey;
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: new PublicKey(programId),
      keys: [
        { pubkey: filler, isSigner: false, isWritable: false },
        { pubkey: filler, isSigner: false, isWritable: false },
        { pubkey: filler, isSigner: false, isWritable: true },
        { pubkey: asset.publicKey, isSigner: true, isWritable: true },
        { pubkey: filler, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: filler, isSigner: false, isWritable: false },
        { pubkey: filler, isSigner: false, isWritable: false },
      ],
      data: registerData(atom),
    })
  );
  tx.feePayer = owner.publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

const matched = registryMatch({
  ...inspectRegistryTransaction(unsigned(AGENT_REGISTRY_PROGRAM_ID)),
  owner: owner.publicKey.toBase58(),
  asset: asset.publicKey.toBase58(),
  uri,
  failed: false,
});
assert(matched === null, matched ?? "match");
const rejected = registryMatch({
  ...inspectRegistryTransaction(unsigned(DEVNET_REGISTRY)),
  owner: owner.publicKey.toBase58(),
  asset: asset.publicKey.toBase58(),
  uri,
  failed: false,
});
assert(rejected === "The registry transaction used a devnet program.", rejected ?? "devnet was accepted");
const devnetMatch = runWithHireCluster("devnet", () =>
  registryMatch({
    ...inspectRegistryTransaction(unsigned(DEVNET_REGISTRY)),
    owner: owner.publicKey.toBase58(),
    asset: asset.publicKey.toBase58(),
    uri,
    failed: false,
  })
);
assert(devnetMatch === null, devnetMatch ?? "devnet registry was rejected");
const mainnetOnDevnet = runWithHireCluster("devnet", () =>
  registryMatch({
    ...inspectRegistryTransaction(unsigned(AGENT_REGISTRY_PROGRAM_ID)),
    owner: owner.publicKey.toBase58(),
    asset: asset.publicKey.toBase58(),
    uri,
    failed: false,
  })
);
assert(mainnetOnDevnet === "The registry transaction used a different cluster.", mainnetOnDevnet ?? "mainnet was accepted on devnet");
const marketed = runWithHireCluster("devnet", () =>
  registryMatch({
    ...inspectRegistryTransaction(unsigned("6MuHv4dY4p9E4hSCEPr9dgbCSpMhq8x1vrUexbMVjfw1")),
    owner: owner.publicKey.toBase58(),
    asset: asset.publicKey.toBase58(),
    uri,
    failed: false,
  })
);
assert(marketed === "The registry transaction used a different cluster.", marketed ?? "marketing program was accepted");
const atomEnabled = registryMatch({
  ...inspectRegistryTransaction(unsigned(AGENT_REGISTRY_PROGRAM_ID, 1)),
  owner: owner.publicKey.toBase58(),
  asset: asset.publicKey.toBase58(),
  uri,
  failed: false,
});
assert(atomEnabled === "The registry transaction enabled ATOM.", atomEnabled ?? "atom was accepted");
const spoof = new Transaction().add(
  new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [
      { pubkey: asset.publicKey, isSigner: true, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(AGENT_REGISTRY_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(uri, "utf8"),
  })
);
spoof.feePayer = owner.publicKey;
spoof.recentBlockhash = Keypair.generate().publicKey.toBase58();
const spoofed = registryMatch({
  ...inspectRegistryTransaction(spoof.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64")),
  owner: owner.publicKey.toBase58(),
  asset: asset.publicKey.toBase58(),
  uri,
  failed: false,
});
assert(spoofed === "The registry transaction did not register this agent.", spoofed ?? "spoof was accepted");

async function main(): Promise<void> {
  const sdk = (await import("8004-solana")) as {
    getProgramIdsForCluster: (
      cluster: string,
      overrides?: { agentRegistry?: string; atomEngine?: string }
    ) => { agentRegistry: { toBase58(): string }; atomEngine: { toBase58(): string } };
  };
  const pinned = sdk.getProgramIdsForCluster("mainnet-beta", registryProgramIds());
  assert(pinned.agentRegistry.toBase58() === AGENT_REGISTRY_PROGRAM_ID, "mainnet pin was ignored");
  assert(pinned.atomEngine.toBase58() === ATOM_ENGINE_PROGRAM_ID, "atom pin was ignored");
  assert(sdk.getProgramIdsForCluster("devnet").agentRegistry.toBase58() === DEVNET_REGISTRY, "devnet sdk pin");
  if (process.env.FIREBASE_SERVICE_ACCOUNT || process.env.NODE_ENV === "production") {
    console.log("agent registry check passed");
    return;
  }
  const stored: StoredAgent = { ...agent, name: "Desk", registryUri: uri };
  await agentStore().saveAgent(stored);
  const token = `own_${"r".repeat(32)}`;
  await agentStore().putSecret(sha256Hex(token), {
    kind: "owner-session",
    hash: sha256Hex(token),
    platformId: "",
    owner: owner.publicKey.toBase58(),
    expiresAt: Date.now() + 60_000,
    revokedAt: null,
    createdAt: Date.now(),
  });
  const listed = await handleAgentsRequest(
    new NextRequest(`http://localhost/api/agents/v1/agents/${platformId}/registration`),
    "GET",
    ["agents", platformId, "registration"]
  );
  const file = (await listed.json()) as { x402Support?: boolean; services?: { endpoint?: string }[] };
  assert(listed.status === 200, "registration get");
  assert(file.x402Support === true, "public registration x402");
  assert(JSON.stringify(file).includes(platformId), "public registration platform id");
  const refused = await handleAgentsRequest(
    new NextRequest(`http://localhost/api/agents/v1/agents/${platformId}/registry/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ asset: asset.publicKey.toBase58(), signature: "short", secretKey: "nope" }),
    }),
    "POST",
    ["agents", platformId, "registry", "confirm"]
  );
  const refusedBody = await refused.text();
  assert(refused.status === 400, "secret field status");
  assert(refusedBody.includes("not accepted"), "secret field message");
  assert(!refusedBody.includes("nope"), "secret field echoed");
  const unconfirmed = await handleAgentsRequest(
    new NextRequest(`http://localhost/api/agents/v1/agents/${platformId}/registry/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ asset: asset.publicKey.toBase58(), signature: "short" }),
    }),
    "POST",
    ["agents", platformId, "registry", "confirm"]
  );
  const unconfirmedBody = await unconfirmed.text();
  assert(unconfirmed.status === 400, "bad signature status");
  assert(unconfirmedBody.includes("Signature is not a transaction signature."), "bad signature message");
  assert(!unconfirmedBody.includes("secretKey") && !unconfirmedBody.includes("privateKey"), "confirm response secret");
  const saved = await agentStore().getAgent(platformId);
  assert(!saved?.registryAsset, "bad signature was stored");
  console.log("agent registry check passed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
