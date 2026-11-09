import { Keypair } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { OASF_DOMAIN_COUNT, OASF_SKILL_COUNT, taxonomyDomain, taxonomySkill } from "../src/protocol/oasf-taxonomy";
import { runWithHireCluster } from "../src/server/cluster";
import { sha256Hex } from "../src/server/crypto";
import {
  MPL_CORE_PROGRAM_ID,
  SCAN_DIRECTORY_URL,
  SOLANA_SCAN_CHAIN_ID,
  acceptListedAgent,
  browseDirectory,
  listedForSkill,
  parseScanPage,
  readCoreAsset,
  readRegistryAccount,
  readRegistryAsset,
  readRegistryRecord,
  registryAgentAddress,
  searchDirectory,
  type RegistryRecord,
} from "../src/server/directory";
import { handleAgentsRequest } from "../src/server/router";
import { agentStore, type StoredAgent } from "../src/server/store";
import {
  AGENT_REGISTRY_PROGRAM_ID,
  DEVNET_AGENT_REGISTRY_PROGRAM_ID,
  OASF_TAXONOMY_ENDPOINT,
  OASF_TAXONOMY_VERSION,
  registrationDocument,
  registrationOrigin,
  registrationPlatformId,
  registrationUri,
} from "../src/server/agent/registry";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const SKILL = "tool_interaction/workflow_automation";
const DOMAIN = "technology/blockchain/blockchain";
const UNRENT = "9n7re16AhX5JHkr1wpa1CULHFoGzNCfvUXGuBDKzLweo";
const UNRENT_OWNER = "8XHJDmSa7kyWskiLmDkCWQ6ZTBSgZbNT1cfZLE91R6c1";
const UNRENT_URI = "https://unrent.xyz/.well-known/agent-registration.json";
/** Account data for the UNRENT asset, read from mainnet on 2026-11-07. */
const UNRENT_ACCOUNT =
  "AW/DqONPi3JV0B8bSpWAuXALNN6YpHk5noh241xqausiArsydwYA8G3Dg7tcYRz3ZGvu0Y1fc38D0iwbOgosIZijBQAAAEFnZW50NgAAAGh0dHBzOi8vdW5yZW50Lnh5ei8ud2VsbC1rbm93bi9hZ2VudC1yZWdpc3RyYXRpb24uanNvbgA=";
/** Agent PDA 2YvWXCVXsaYNewMTkRdA8Gx9uX9FXxUxPu4X47BsBj4X, read from mainnet on 2026-11-07. */
const UNRENT_AGENT =
  "8XdFjOkJcDK7MncGAPBtw4O7XGEc92Rr7tGNX3N/A9IsGzoKLCGYo2/DqONPi3JV0B8bSpWAuXALNN6YpHk5noh241xqausib8Oo40+LclXQHxtKlYC5cAs03pikeTmeiHbjXGpq6yKCbGI79FlM45kHdbbUmZpxjsRuD/FCNkuVy+OFdr668P4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADYAAABodHRwczovL3VucmVudC54eXovLndlbGwta25vd24vYWdlbnQtcmVnaXN0cmF0aW9uLmpzb24FAAAAQWdlbnQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

assert(OASF_SKILL_COUNT === 136, "skill taxonomy count");
assert(OASF_DOMAIN_COUNT === 204, "domain taxonomy count");
assert(taxonomySkill(SKILL) === SKILL, "known skill");
assert(taxonomySkill("trading") == null, "free-text skill");
assert(taxonomyDomain(DOMAIN) === DOMAIN, "known domain");
assert(taxonomyDomain("finance") == null, "free-text domain");

const decoded = readCoreAsset(Buffer.from(UNRENT_ACCOUNT, "base64"));
assert(decoded?.owner === UNRENT_OWNER, "fixture owner");
assert(decoded?.uri === UNRENT_URI, "fixture uri");
const longName = Buffer.concat([
  Buffer.from([1]),
  Buffer.alloc(32, 7),
  Buffer.from([0]),
  Buffer.from([33, 0, 0, 0]),
  Buffer.alloc(33, 97),
  Buffer.from([UNRENT_URI.length, 0, 0, 0]),
  Buffer.from(UNRENT_URI),
]);
assert(readCoreAsset(longName)?.uri === UNRENT_URI, "core name longer than 32");
assert(readCoreAsset(Buffer.from([0])) == null, "short account");
const wrongKey = Buffer.from(UNRENT_ACCOUNT, "base64");
wrongKey[0] = 2;
assert(readCoreAsset(wrongKey) == null, "non-asset discriminator");

const platformId = "agt_directorycheck";
const owner = Keypair.generate();
const asset = Keypair.generate();
const uri = registrationUri(platformId);
assert(registrationPlatformId(uri) === platformId, "registration uri parses");
assert(registrationPlatformId(`${uri}?extra=1`) == null, "query uri rejected");
assert(registrationPlatformId(UNRENT_URI) == null, "foreign uri rejected");
assert(registrationPlatformId(`https://evil.example/api/agents/v1/agents/${platformId}/registration`) == null, "foreign host rejected");

function stored(patch: Partial<StoredAgent> = {}): StoredAgent {
  return {
    platformId,
    owner: owner.publicKey.toBase58(),
    name: "Desk",
    endpoint: null,
    endpointVerifiedAt: null,
    walletAddress: Keypair.generate().publicKey.toBase58(),
    walletProvider: "privy",
    providerWalletId: "privy-wallet",
    retiredWallets: [],
    status: "active",
    slimName: "collective/agents/service/agtdirectorycheck",
    directoryCid: null,
    directorySkills: [SKILL],
    directoryDomains: [DOMAIN],
    oasf: null,
    runtimePublicKey: null,
    signCredentialIssuedAt: null,
    claimNonce: null,
    registryAsset: asset.publicKey.toBase58(),
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const agent = stored();
const file = registrationDocument(agent);
const oasf = file.services.find((service) => service.name === "OASF");
assert(oasf?.endpoint === OASF_TAXONOMY_ENDPOINT, "oasf endpoint");
assert(oasf?.version === OASF_TAXONOMY_VERSION, "oasf version");
assert(OASF_TAXONOMY_ENDPOINT === "https://github.com/agntcy/oasf/", "oasf endpoint matches the registration guide");
assert(OASF_TAXONOMY_VERSION === "v0.8.0", "oasf version matches the registration guide");
assert(oasf?.skills?.[0] === SKILL, "listed skill");
assert(oasf?.domains?.[0] === DOMAIN, "listed domain");
assert(!JSON.stringify(file).includes("trading"), "free text was not copied");
assert(!registrationDocument(stored({ directorySkills: ["trading"] })).services.some((service) => service.name === "OASF"), "unknown skill is not published");

const listedAsset = asset.publicKey.toBase58();
function recordFor(id: string, ownerKey: string, chainUri: string, patch: Partial<RegistryRecord> = {}): RegistryRecord {
  const derived = registryAgentAddress(id);
  assert(derived, "record address");
  return { asset: id, owner: ownerKey, uri: chainUri, atom: 0, bump: derived.bump, ...patch };
}
const matching = recordFor(listedAsset, agent.owner, uri);
const parsedRecord = readRegistryRecord(Buffer.from(UNRENT_AGENT, "base64"));
assert(
  parsedRecord?.uri === UNRENT_URI &&
    parsedRecord.owner === UNRENT_OWNER &&
    parsedRecord.asset === UNRENT &&
    parsedRecord.atom === 0 &&
    parsedRecord.bump === 254,
  "fixture registry account"
);
assert(registryAgentAddress(UNRENT)?.address === "2YvWXCVXsaYNewMTkRdA8Gx9uX9FXxUxPu4X47BsBj4X", "agent pda");
const badRecord = Buffer.from(UNRENT_AGENT, "base64");
badRecord[0] = 0;
assert(readRegistryRecord(badRecord) == null, "registry discriminator");

const accepted = acceptListedAgent({
  asset: listedAsset,
  chainOwner: agent.owner,
  chainUri: uri,
  record: matching,
  agent,
  skill: SKILL,
});
assert(accepted?.platformId === platformId && accepted.owner === agent.owner, "matching asset is listed");
assert(
  acceptListedAgent({
    asset: listedAsset,
    chainOwner: agent.owner,
    chainUri: uri,
    record: matching,
    agent: stored({ status: "pending_credential" }),
    skill: SKILL,
  })?.platformId === platformId,
  "a registered agent is listed before the signer claim"
);
assert(registrationDocument(stored({ status: "pending_credential" })).active === true, "a registered agent is active on the registration file");
assert(registrationDocument(stored({ status: "paused" })).active === false, "a paused agent is not active");
assert(
  listedForSkill(["images_computer_vision/image_generation"], "multi_modal/image_processing/text_to_image"),
  "image generation covers a logo search"
);
const savedSupervisor = process.env.HIRE_SUPERVISOR_PLATFORM_ID;
process.env.HIRE_SUPERVISOR_PLATFORM_ID = platformId;
assert(
  acceptListedAgent({ asset: listedAsset, chainOwner: agent.owner, chainUri: uri, record: matching, agent, skill: SKILL }) == null,
  "supervisor was listed for hire"
);
assert(!registrationDocument(agent).services.some((service) => service.name === "OASF"), "supervisor registration advertised a skill");
if (savedSupervisor === undefined) delete process.env.HIRE_SUPERVISOR_PLATFORM_ID;
else process.env.HIRE_SUPERVISOR_PLATFORM_ID = savedSupervisor;
assert(
  acceptListedAgent({ asset: listedAsset, chainOwner: agent.owner, chainUri: uri, record: null, agent, skill: SKILL }) == null,
  "missing registry account was accepted"
);
assert(
  acceptListedAgent({
    asset: listedAsset,
    chainOwner: agent.owner,
    chainUri: uri,
    record: recordFor(listedAsset, agent.owner, uri, { atom: 1 }),
    agent,
    skill: SKILL,
  }) == null,
  "atom registration was accepted"
);
assert(
  acceptListedAgent({
    asset: listedAsset,
    chainOwner: agent.owner,
    chainUri: uri,
    record: recordFor(listedAsset, agent.owner, uri, { bump: (matching.bump + 1) % 256 }),
    agent,
    skill: SKILL,
  }) == null,
  "wrong registry bump was accepted"
);
assert(
  acceptListedAgent({
    asset: listedAsset,
    chainOwner: agent.owner,
    chainUri: uri,
    record: recordFor(listedAsset, agent.owner, UNRENT_URI),
    agent,
    skill: SKILL,
  }) == null,
  "registry uri mismatch was accepted"
);
assert(
  acceptListedAgent({ asset: listedAsset, chainOwner: agent.owner, chainUri: UNRENT_URI, record: recordFor(listedAsset, agent.owner, UNRENT_URI), agent, skill: SKILL }) == null,
  "foreign chain uri was accepted"
);
assert(
  acceptListedAgent({
    asset: listedAsset,
    chainOwner: Keypair.generate().publicKey.toBase58(),
    chainUri: uri,
    record: recordFor(listedAsset, agent.owner, uri),
    agent,
    skill: SKILL,
  }) == null,
  "wrong owner was accepted"
);
assert(
  acceptListedAgent({ asset: UNRENT, chainOwner: agent.owner, chainUri: uri, record: recordFor(UNRENT, agent.owner, uri), agent, skill: SKILL }) == null,
  "substituted asset was accepted"
);
assert(
  acceptListedAgent({
    asset: listedAsset,
    chainOwner: agent.owner,
    chainUri: uri,
    record: matching,
    agent: stored({ status: "paused" }),
    skill: SKILL,
  }) == null,
  "paused agent was accepted"
);
assert(
  acceptListedAgent({
    asset: listedAsset,
    chainOwner: agent.owner,
    chainUri: uri,
    record: matching,
    agent: stored({ directorySkills: [] }),
    skill: SKILL,
  }) == null,
  "unlisted skill was accepted"
);

const page = parseScanPage({
  items: [
    { agent_id: UNRENT, chain_id: SOLANA_SCAN_CHAIN_ID, chain_type: "solana", contract_address: AGENT_REGISTRY_PROGRAM_ID },
    { agent_id: UNRENT, chain_id: 8453, chain_type: "evm", contract_address: "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432" },
    {
      agent_id: asset.publicKey.toBase58(),
      chain_id: 101,
      chain_type: "solana",
      contract_address: "8oo4J9tBB3Hna1jRQ3rWvJjojqM5DYTDJo5cejUuJy3C",
    },
  ],
  has_more: false,
});
assert(page.assets.length === 1 && page.assets[0] === UNRENT, "scan page kept the mainnet asset");
const devnetPage = runWithHireCluster("devnet", () =>
  parseScanPage({
    items: [
      { agent_id: UNRENT, chain_id: 103, chain_type: "solana", contract_address: DEVNET_AGENT_REGISTRY_PROGRAM_ID },
      { agent_id: asset.publicKey.toBase58(), chain_id: 101, chain_type: "solana", contract_address: AGENT_REGISTRY_PROGRAM_ID },
    ],
    has_more: false,
  })
);
assert(devnetPage.assets.length === 1 && devnetPage.assets[0] === UNRENT, "devnet scan kept the devnet program");
const devnetFile = registrationDocument(stored({ network: "devnet" }));
assert(registrationDocument(agent).services.find((service) => service.name === "web")?.endpoint.endsWith(`/agents/${platformId}`), "mainnet profile");
assert(devnetFile.services.find((service) => service.name === "web")?.endpoint.endsWith(`/devnet/hire/${platformId}`), "devnet profile");
assert(
  devnetFile.registrations[0]?.agentRegistry === `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${DEVNET_AGENT_REGISTRY_PROGRAM_ID}`,
  "devnet registration file"
);
assert(devnetFile.services.find((service) => service.name === "agentWallet")?.endpoint.startsWith("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:"), "devnet wallet chain");
assert(!devnetFile.registrations[0]?.agentRegistry.includes(AGENT_REGISTRY_PROGRAM_ID), "devnet file kept the mainnet program");
assert(parseScanPage({ items: [], has_more: true, next_cursor: "next" }).hasMore, "cursor continues");

async function main(): Promise<void> {
  const sdk = (await import("8004-solana")) as {
    getProgramIdsForCluster: (cluster: string) => { mplCore: { toBase58(): string } };
  };
  assert(sdk.getProgramIdsForCluster("mainnet-beta").mplCore.toBase58() === MPL_CORE_PROGRAM_ID, "core program pin");

  const scanUrl = new URL(SCAN_DIRECTORY_URL);
  scanUrl.searchParams.set("chain_id", String(SOLANA_SCAN_CHAIN_ID));
  scanUrl.searchParams.set("oasf_skill", SKILL);
  scanUrl.searchParams.set("limit", "5");
  const scan = await fetch(scanUrl, { redirect: "manual" });
  assert(scan.status === 200, "live skill query");
  const livePage = parseScanPage(await scan.json());
  assert(livePage.assets.includes(UNRENT), "live skill query omitted the known asset");
  const chain = await readRegistryAsset(UNRENT);
  assert(chain?.uri === UNRENT_URI && chain.owner === UNRENT_OWNER, "live asset did not match the registration file");
  const liveRecord = await readRegistryAccount(UNRENT);
  assert(
    liveRecord?.uri === UNRENT_URI && liveRecord.owner === UNRENT_OWNER && liveRecord.asset === UNRENT && liveRecord.atom === 0,
    "live registry account did not match the asset"
  );
  assert(
    acceptListedAgent({ asset: UNRENT, chainOwner: chain.owner, chainUri: chain.uri, record: liveRecord, agent, skill: SKILL }) == null,
    "foreign live asset was accepted"
  );

  const searched = await searchDirectory(SKILL);
  assert(searched.skill === SKILL, "search skill");
  for (const hit of searched.hits) {
    assert(hit.uri === registrationUri(hit.platformId), "search hit left our registration url");
    assert(hit.skills.includes(SKILL), "search hit dropped the skill");
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT || process.env.NODE_ENV === "production") {
    console.log("agent directory check passed");
    return;
  }

  await agentStore().saveAgent(agent);
  const found = await searchDirectory(SKILL, {
    list: async () => ({ assets: [asset.publicKey.toBase58(), UNRENT], complete: true }),
    readAsset: async (id) =>
      id === listedAsset ? { owner: agent.owner, uri } : { owner: UNRENT_OWNER, uri: UNRENT_URI },
    readRecord: async (id) =>
      id === listedAsset ? matching : recordFor(UNRENT, UNRENT_OWNER, UNRENT_URI),
  });
  assert(found.hits.length === 1 && found.hits[0]?.asset === asset.publicKey.toBase58(), "injected search kept only our asset");
  const readers = {
    readAsset: async (id: string) => (id === listedAsset ? { owner: agent.owner, uri } : null),
    readRecord: async (id: string) => (id === listedAsset ? matching : null),
  };
  const all = await browseDirectory("", readers);
  const narrowed = await browseDirectory("audio/audio", readers);
  assert(all.hits.some((hit) => hit.platformId === platformId), "published agents are listed without a skill filter");
  assert(!narrowed.hits.some((hit) => hit.platformId === platformId), "an unrelated skill does not list this agent");

  const token = `own_${"d".repeat(32)}`;
  await agentStore().putSecret(sha256Hex(token), {
    kind: "owner-session",
    hash: sha256Hex(token),
    platformId: "",
    owner: owner.publicKey.toBase58(),
    expiresAt: Date.now() + 60_000,
    revokedAt: null,
    createdAt: Date.now(),
  });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const rejected = await handleAgentsRequest(
    new NextRequest(`http://localhost/api/agents/v1/directory/publish`, {
      method: "POST",
      headers,
      body: JSON.stringify({ platformId, skills: ["trading"] }),
    }),
    "POST",
    ["directory", "publish"]
  );
  assert(rejected.status === 400, "unknown skill status");
  const published = await handleAgentsRequest(
    new NextRequest(`http://localhost/api/agents/v1/directory/publish`, {
      method: "POST",
      headers,
      body: JSON.stringify({ platformId, skills: [SKILL], domains: [DOMAIN] }),
    }),
    "POST",
    ["directory", "publish"]
  );
  assert(published.status === 200, "publish status");
  const listed = await handleAgentsRequest(
    new NextRequest(`http://localhost/api/agents/v1/agents/${platformId}/registration`),
    "GET",
    ["agents", platformId, "registration"]
  );
  const body = (await listed.json()) as { services?: { name?: string; skills?: string[]; endpoint?: string }[] };
  const listedOasf = body.services?.find((service) => service.name === "OASF");
  assert(listed.status === 200 && listedOasf?.skills?.[0] === SKILL, "registration lists the skill");
  assert(listedOasf?.endpoint === OASF_TAXONOMY_ENDPOINT, "registration oasf endpoint");
  const cleared = await handleAgentsRequest(
    new NextRequest(`http://localhost/api/agents/v1/directory/publish`, {
      method: "POST",
      headers,
      body: JSON.stringify({ platformId, skills: [] }),
    }),
    "POST",
    ["directory", "publish"]
  );
  assert(cleared.status === 200, "clear status");
  const after = await handleAgentsRequest(
    new NextRequest(`http://localhost/api/agents/v1/agents/${platformId}/registration`),
    "GET",
    ["agents", platformId, "registration"]
  );
  const afterBody = (await after.json()) as { services?: { name?: string }[] };
  assert(!afterBody.services?.some((service) => service.name === "OASF"), "cleared registration still lists a skill");
  assert(registrationOrigin().length > 0, "origin");
  console.log("agent directory check passed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
