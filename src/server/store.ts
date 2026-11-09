import "server-only";
import { createHash } from "node:crypto";
import { FieldPath, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import type { AgentStatus, OasfRecord, Policy, Risk, WalletProviderName } from "../protocol";
import { defaultPolicy } from "../protocol";
import { getAdminDb } from "./host";
import type { StoredChatMessage } from "./chat";
import type { AgentRuntimeDoc, McpServer } from "./agent/types";
import { AgentsError } from "./errors";
import { isSupervisor } from "./supervisor";
import type { AgentWorkspace } from "./workspace";
import { cancelJob, fresh, type Job } from "./jobs";

export type StoredAgent = {
  platformId: string;
  owner: string;
  name: string;
  endpoint: string | null;
  endpointVerifiedAt: number | null;
  walletAddress: string;
  walletProvider: WalletProviderName;
  providerWalletId: string;
  retiredWallets: { address: string; retiredAt: number }[];
  status: AgentStatus;
  /** Set when the owner wallet changes. Earned receipts stay on this platform id. */
  transferredAt?: number | null;
  slimName: string | null;
  directoryCid: string | null;
  /** OASF 0.8 skill paths published on the registration file. */
  directorySkills?: string[] | null;
  /** OASF 0.8 domain paths published on the registration file. */
  directoryDomains?: string[] | null;
  /** Owner description copied onto the public registration file at publish. */
  publicDescription?: string | null;
  oasf: OasfRecord | null;
  runtimePublicKey: string | null;
  signCredentialIssuedAt: number | null;
  /**
   * Per-agent model choice, set by the owner for this agent alone. Wins over
   * the owner's provider link, so an already deployed agent can be moved to
   * another model (for example Muse Image) without re-enrolling.
   */
  agentModel?: { provider: string; modelId: string } | null;
  claimNonce: string | null;
  xmtpInboxKey?: string | null;
  /** Solana agent-registry asset. This is the public identifier. */
  registryAsset?: string | null;
  registrySignature?: string | null;
  registryUri?: string | null;
  /** Asset the browser asked to register, saved before the owner signs. */
  registryPendingAsset?: string | null;
  /** Cluster this agent was enrolled on. Missing means mainnet. */
  network?: "mainnet" | "devnet" | null;
  createdAt: number;
  updatedAt: number;
};

export type PeerMessage = {
  id: string;
  fromPlatformId: string;
  toPlatformId: string;
  text: string;
  createdAt: number;
};

export type ProviderLink = {
  owner: string;
  provider: string;
  secretName: string;
  status: "connected" | "disconnected";
  hint: string;
  modelId: string;
  requestsToday: number;
  day: string;
  updatedAt: number;
};

export type StoredPolicy = Policy & { platformId: string; updatedAt: number };

export type StoredGrant = {
  platformId: string;
  callerPlatformId: string;
  allowed: boolean;
  updatedAt: number;
};

export type StoredAction = {
  id: string;
  platformId: string;
  name: string;
  status: "pending_owner" | "pending_agent" | "confirmed" | "failed" | "rejected" | "expired";
  risk: Risk;
  signer: "owner" | "agent";
  payloadHash: string;
  unsignedTransactions: string[];
  request: Record<string, string>;
  amountLamports: string;
  simulationPassed: boolean;
  idempotencyKey: string;
  launchNonce: string | null;
  launchMint: string | null;
  launchStep: string | null;
  confirmedSteps: number;
  lookupTables: string[];
  signature: string | null;
  verified: boolean;
  createdAt: number;
  expiresAt: number;
};

export type StoredAudit = {
  id: string;
  platformId: string;
  actionId: string | null;
  kind: string;
  summary: string;
  verified: boolean;
  reported: boolean;
  detail: Record<string, string>;
  createdAt: number;
};

type NonceDoc = {
  kind: "nonce";
  purpose: string;
  subject: string;
  expiresAt: number;
  used: boolean;
};

type SecretDoc = {
  kind: "credential" | "owner-session";
  hash: string;
  platformId: string;
  owner: string;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
};

type UsageDoc = { day: string; spent: string; recent: number[] };

type Memory = {
  agents: Map<string, StoredAgent>;
  secrets: Map<string, SecretDoc | NonceDoc>;
  policies: Map<string, StoredPolicy>;
  grants: Map<string, StoredGrant>;
  actions: Map<string, StoredAction>;
  audits: Map<string, StoredAudit>;
  threads: Map<string, StoredChatMessage[]>;
  peers: Map<string, PeerMessage[]>;
  providers: Map<string, ProviderLink>;
  workspaces: Map<string, AgentWorkspace>;
  mcp: Map<string, McpServer>;
  seals: Map<string, string>;
  runtimes: Map<string, AgentRuntimeDoc>;
  wallets: Map<string, string>;
  usage: Map<string, UsageDoc>;
  actionKeys: Map<string, string>;
  jobs: Map<string, Job>;
};

function memory(): Memory {
  const g = globalThis as typeof globalThis & { __collectiveAgentsStore?: Memory };
  g.__collectiveAgentsStore ??= {
    agents: new Map(),
    secrets: new Map(),
    policies: new Map(),
    grants: new Map(),
    actions: new Map(),
    audits: new Map(),
    threads: new Map(),
    peers: new Map(),
    providers: new Map(),
    workspaces: new Map(),
    mcp: new Map(),
    seals: new Map(),
    runtimes: new Map(),
    wallets: new Map(),
    usage: new Map(),
    actionKeys: new Map(),
    jobs: new Map(),
  };
  const mem = g.__collectiveAgentsStore;
  if (!mem.threads) mem.threads = new Map();
  if (!mem.wallets) mem.wallets = new Map();
  if (!mem.usage) mem.usage = new Map();
  if (!mem.actionKeys) mem.actionKeys = new Map();
  if (!mem.jobs) mem.jobs = new Map();
  if (!mem.peers) mem.peers = new Map();
  if (!mem.providers) mem.providers = new Map();
  if (!mem.workspaces) mem.workspaces = new Map();
  if (!mem.mcp) mem.mcp = new Map();
  if (!mem.seals) mem.seals = new Map();
  if (!mem.runtimes) mem.runtimes = new Map();
  return mem;
}

const AGENTS = "agents";
const CREDENTIALS = "agent-credentials";
const GRANTS = "agent-grants";
const POLICIES = "agent-policies";
const ACTIONS = "agent-actions";
const AUDIT = "agent-audit";
const MESSAGES = "agent-messages";
const WALLETS = "agent-wallet-index";
const USAGE = "agent-usage";
const ACTION_KEYS = "agent-action-keys";
const JOBS = "agent-jobs";
const PEERS = "agent-peers";
const PROVIDERS = "agent-providers";
const WORKSPACES = "agent-workspaces";
const MCP = "agent-mcp";
const SEALS = "agent-seals";
const RUNTIMES = "agent-runtime";
const JOB_LIST_LIMIT = 2000;

export type AgentStore = {
  saveAgent(agent: StoredAgent): Promise<void>;
  getAgent(platformId: string): Promise<StoredAgent | null>;
  listByOwner(owner: string): Promise<StoredAgent[]>;
  listPublished(): Promise<StoredAgent[]>;
  savePolicy(policy: StoredPolicy): Promise<void>;
  getPolicy(platformId: string): Promise<StoredPolicy>;
  saveGrant(grant: StoredGrant): Promise<void>;
  getGrant(platformId: string, callerPlatformId: string): Promise<StoredGrant | null>;
  saveAction(action: StoredAction): Promise<void>;
  getAction(id: string): Promise<StoredAction | null>;
  listActions(platformId: string): Promise<StoredAction[]>;
  saveAudit(row: StoredAudit): Promise<void>;
  listAudit(platformId: string): Promise<StoredAudit[]>;
  listMessages(platformId: string): Promise<StoredChatMessage[]>;
  updateThread<T>(
    platformId: string,
    update: (messages: StoredChatMessage[]) => { messages: StoredChatMessage[]; result: T }
  ): Promise<T>;
  putSecret(id: string, doc: SecretDoc): Promise<void>;
  getSecret(id: string): Promise<SecretDoc | null>;
  listSecrets(platformId: string): Promise<SecretDoc[]>;
  putNonce(id: string, doc: NonceDoc): Promise<void>;
  consumeNonce(id: string, purpose: string, subject: string): Promise<void>;
  isHireWallet(address: string): Promise<boolean>;
  listActiveCredentials(platformId: string): Promise<SecretDoc[]>;
  claimRuntime(input: {
    platformId: string;
    nonce: string;
    publicKey: string;
    secret: SecretDoc;
  }): Promise<StoredAgent>;
  findAction(platformId: string, name: string, idempotencyKey: string): Promise<StoredAction | null>;
  reserveAction(action: StoredAction): Promise<{ action: StoredAction; created: boolean }>;
  readUsage(platformId: string): Promise<{ spentTodayLamports: string; actionsLastMinute: number }>;
  noteUsage(platformId: string, amountLamports: string, at: number): Promise<void>;
  forgetUsage(platformId: string, amountLamports: string, createdAt: number): Promise<void>;
  expirePending(platformId: string): Promise<void>;
  saveJob(job: Job): Promise<void>;
  getJob(id: string): Promise<Job | null>;
  updateJob<T>(id: string, update: (job: Job | null) => { job: Job | null; result: T }): Promise<T>;
  listJobsForAgent(platformId: string): Promise<Job[]>;
  listJobsForOwner(owner: string): Promise<Job[]>;
  cancelOpenJobs(platformId: string): Promise<void>;
  listPeer(pairId: string): Promise<PeerMessage[]>;
  appendPeer(pairId: string, message: PeerMessage): Promise<PeerMessage>;
  saveProvider(link: ProviderLink): Promise<void>;
  getProvider(owner: string, provider: string): Promise<ProviderLink | null>;
  listProviders(owner: string): Promise<ProviderLink[]>;
  saveWorkspace(workspace: AgentWorkspace): Promise<void>;
  getWorkspace(platformId: string): Promise<AgentWorkspace | null>;
  updateWorkspace(platformId: string, update: (current: AgentWorkspace | null) => AgentWorkspace): Promise<AgentWorkspace>;
  saveMcp(server: McpServer): Promise<void>;
  listMcp(platformId: string): Promise<McpServer[]>;
  deleteMcp(platformId: string, name: string): Promise<void>;
  saveSeal(id: string, sealed: string): Promise<void>;
  getSeal(id: string): Promise<string | null>;
  deleteSeal(id: string): Promise<void>;
  saveRuntime(doc: AgentRuntimeDoc): Promise<void>;
  getRuntime(platformId: string): Promise<AgentRuntimeDoc | null>;
};

function asAgent(data: Record<string, unknown>): StoredAgent {
  return data as unknown as StoredAgent;
}

function threadMessages(data: Record<string, unknown> | undefined): StoredChatMessage[] {
  const messages = data?.messages;
  if (!Array.isArray(messages)) return [];
  return messages as StoredChatMessage[];
}

function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function actionKey(platformId: string, name: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${platformId}\n${name}\n${idempotencyKey}`).digest("hex");
}

function dedupeJobs(lists: Job[][]): Job[] {
  const map = new Map<string, Job>();
  for (const list of lists) for (const job of list) map.set(job.id, job);
  return [...map.values()];
}

async function persistCancellations(jobs: Job[], save: (job: Job) => Promise<void>): Promise<void> {
  const now = Date.now();
  for (const job of jobs) {
    const current = fresh(job, now);
    const next = cancelJob(current, now);
    const saved = next ?? (current.status !== job.status ? current : null);
    if (saved) await save(saved);
  }
}

function presentUsage(doc: UsageDoc, now: number): { spentTodayLamports: string; actionsLastMinute: number } {
  if (doc.day !== dayOf(now)) return { spentTodayLamports: "0", actionsLastMinute: 0 };
  const recent = (doc.recent ?? []).filter((at) => at >= now - 60_000);
  return { spentTodayLamports: doc.spent || "0", actionsLastMinute: recent.length };
}

function emptyUsage(now: number): UsageDoc {
  return { day: dayOf(now), spent: "0", recent: [] };
}

function noteDoc(doc: UsageDoc | null, amountLamports: string, at: number): UsageDoc {
  const base = doc && doc.day === dayOf(at) ? doc : emptyUsage(at);
  const recent = (base.recent ?? []).filter((ts) => ts >= at - 60_000);
  recent.push(at);
  const amount = /^\d+$/.test(amountLamports) ? BigInt(amountLamports) : BigInt(0);
  const spent = (BigInt(base.spent || "0") + amount).toString();
  return { day: dayOf(at), spent, recent: recent.slice(-400) };
}

function forgetDoc(doc: UsageDoc | null, amountLamports: string, createdAt: number, now: number): UsageDoc {
  const base = doc && doc.day === dayOf(now) ? doc : emptyUsage(now);
  const recent = (base.recent ?? []).filter((ts) => ts >= now - 60_000);
  if (dayOf(createdAt) !== dayOf(now)) return { ...base, recent };
  const amount = /^\d+$/.test(amountLamports) ? BigInt(amountLamports) : BigInt(0);
  let spent = BigInt(base.spent || "0") - amount;
  if (spent < BigInt(0)) spent = BigInt(0);
  const index = recent.indexOf(createdAt);
  if (index >= 0) recent.splice(index, 1);
  return { day: dayOf(now), spent: spent.toString(), recent };
}

function holdsIdempotencyKey(existing: StoredAction, now: number): boolean {
  if (existing.name === "launch") return true;
  if (existing.status === "confirmed" || existing.confirmedSteps > 0) return true;
  return (
    (existing.status === "pending_owner" || existing.status === "pending_agent") && existing.expiresAt > now
  );
}

function usageFromActions(actions: StoredAction[], now: number): UsageDoc {
  const start = Date.parse(`${dayOf(now)}T00:00:00.000Z`);
  let spent = BigInt(0);
  const recent: number[] = [];
  for (const action of actions) {
    if (action.status === "rejected" || action.status === "failed" || action.status === "expired") continue;
    if (action.createdAt >= start && /^\d+$/.test(action.amountLamports)) spent += BigInt(action.amountLamports);
    if (action.createdAt >= now - 60_000) recent.push(action.createdAt);
  }
  return { day: dayOf(now), spent: spent.toString(), recent: recent.slice(-400) };
}

const SPEND_PAGE_LIMIT = 10_000;

class FirestoreStore implements AgentStore {
  constructor(private readonly db: Firestore) {}

  async saveAgent(agent: StoredAgent): Promise<void> {
    await this.db.collection(AGENTS).doc(agent.platformId).set(agent);
    await this.indexWallet(agent.walletAddress, agent.platformId);
    for (const retired of agent.retiredWallets) await this.indexWallet(retired.address, agent.platformId);
  }
  async getAgent(platformId: string): Promise<StoredAgent | null> {
    const snap = await this.db.collection(AGENTS).doc(platformId).get();
    return snap.exists ? asAgent(snap.data() as Record<string, unknown>) : null;
  }
  async listByOwner(owner: string): Promise<StoredAgent[]> {
    const snap = await this.db.collection(AGENTS).where("owner", "==", owner).limit(50).get();
    return snap.docs.map((doc) => asAgent(doc.data()));
  }
  async listPublished(): Promise<StoredAgent[]> {
    const snap = await this.db.collection(AGENTS).limit(200).get();
    return snap.docs.map((doc) => asAgent(doc.data())).filter((agent) => (agent.directorySkills?.length ?? 0) > 0);
  }
  async savePolicy(policy: StoredPolicy): Promise<void> {
    await this.db.collection(POLICIES).doc(policy.platformId).set(policy);
  }
  async getPolicy(platformId: string): Promise<StoredPolicy> {
    const snap = await this.db.collection(POLICIES).doc(platformId).get();
    if (!snap.exists) return { ...defaultPolicy(), platformId, updatedAt: 0 };
    return snap.data() as StoredPolicy;
  }
  async saveGrant(grant: StoredGrant): Promise<void> {
    await this.db.collection(GRANTS).doc(`${grant.platformId}__${grant.callerPlatformId}`).set(grant);
  }
  async getGrant(platformId: string, callerPlatformId: string): Promise<StoredGrant | null> {
    const snap = await this.db.collection(GRANTS).doc(`${platformId}__${callerPlatformId}`).get();
    return snap.exists ? (snap.data() as StoredGrant) : null;
  }
  async saveAction(action: StoredAction): Promise<void> {
    await this.db.collection(ACTIONS).doc(action.id).set(action);
  }
  async getAction(id: string): Promise<StoredAction | null> {
    const snap = await this.db.collection(ACTIONS).doc(id).get();
    return snap.exists ? (snap.data() as StoredAction) : null;
  }
  async listActions(platformId: string): Promise<StoredAction[]> {
    const snap = await this.db.collection(ACTIONS).where("platformId", "==", platformId).limit(50).get();
    return snap.docs.map((doc) => doc.data() as StoredAction);
  }
  async saveAudit(row: StoredAudit): Promise<void> {
    await this.db.collection(AUDIT).doc(row.id).set(row);
  }
  async listAudit(platformId: string): Promise<StoredAudit[]> {
    const snap = await this.db.collection(AUDIT).where("platformId", "==", platformId).limit(80).get();
    return snap.docs.map((doc) => doc.data() as StoredAudit);
  }
  async listMessages(platformId: string): Promise<StoredChatMessage[]> {
    const snap = await this.db.collection(MESSAGES).doc(platformId).get();
    return threadMessages(snap.data() as Record<string, unknown> | undefined);
  }
  async updateThread<T>(
    platformId: string,
    update: (messages: StoredChatMessage[]) => { messages: StoredChatMessage[]; result: T }
  ): Promise<T> {
    const ref = this.db.collection(MESSAGES).doc(platformId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = threadMessages(snap.data() as Record<string, unknown> | undefined);
      const next = update(current);
      tx.set(ref, { platformId, messages: next.messages });
      return next.result;
    });
  }
  async putSecret(id: string, doc: SecretDoc): Promise<void> {
    await this.db.collection(CREDENTIALS).doc(id).set(doc);
  }
  async getSecret(id: string): Promise<SecretDoc | null> {
    const snap = await this.db.collection(CREDENTIALS).doc(id).get();
    if (!snap.exists) return null;
    const data = snap.data() as SecretDoc | NonceDoc;
    if (data.kind === "nonce") return null;
    return data;
  }
  async listSecrets(platformId: string): Promise<SecretDoc[]> {
    const snap = await this.db.collection(CREDENTIALS).where("platformId", "==", platformId).limit(40).get();
    return snap.docs
      .map((doc) => doc.data() as SecretDoc | NonceDoc)
      .filter((doc): doc is SecretDoc => doc.kind !== "nonce");
  }
  async putNonce(id: string, doc: NonceDoc): Promise<void> {
    await this.db.collection(CREDENTIALS).doc(`nonce_${id}`).set(doc);
  }
  async consumeNonce(id: string, purpose: string, subject: string): Promise<void> {
    const ref = this.db.collection(CREDENTIALS).doc(`nonce_${id}`);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new AgentsError("NONCE_INVALID", "Nonce is unknown.", 400);
      const data = snap.data() as NonceDoc;
      if (data.kind !== "nonce" || data.used || data.purpose !== purpose || data.subject !== subject) {
        throw new AgentsError("NONCE_INVALID", "Nonce does not match this request.", 400);
      }
      if (data.expiresAt < Date.now()) throw new AgentsError("NONCE_EXPIRED", "Nonce expired.", 400);
      tx.set(ref, { ...data, used: true });
    });
  }
  async isHireWallet(address: string): Promise<boolean> {
    const snap = await this.db.collection(WALLETS).doc(address).get();
    return snap.exists;
  }
  async listActiveCredentials(platformId: string): Promise<SecretDoc[]> {
    const out: SecretDoc[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (let page = 0; page < 20; page += 1) {
      let query = this.db
        .collection(CREDENTIALS)
        .where("platformId", "==", platformId)
        .orderBy(FieldPath.documentId())
        .limit(100);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      for (const doc of snap.docs) {
        const data = doc.data() as SecretDoc | NonceDoc;
        if (data.kind === "credential" && !data.revokedAt) out.push(data);
      }
      if (snap.size < 100) return out;
      cursor = snap.docs[snap.docs.length - 1];
    }
    throw new AgentsError("STORE_UNAVAILABLE", "Credential list did not finish. Nothing was revoked.", 503);
  }
  async claimRuntime(input: {
    platformId: string;
    nonce: string;
    publicKey: string;
    secret: SecretDoc;
  }): Promise<StoredAgent> {
    const agentRef = this.db.collection(AGENTS).doc(input.platformId);
    const secretRef = this.db.collection(CREDENTIALS).doc(input.secret.hash);
    const saved = await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(agentRef);
      if (!snap.exists) throw new AgentsError("NONCE_INVALID", "Claim challenge is invalid.", 400);
      const agent = asAgent(snap.data() as Record<string, unknown>);
      if (!agent.claimNonce || agent.claimNonce !== input.nonce) {
        throw new AgentsError("NONCE_INVALID", "Claim challenge is invalid.", 400);
      }
      const next: StoredAgent = {
        ...agent,
        claimNonce: null,
        runtimePublicKey: input.publicKey,
        status: agent.status === "pending_credential" ? "active" : agent.status,
        updatedAt: Date.now(),
      };
      tx.set(agentRef, next);
      tx.set(secretRef, input.secret);
      return next;
    });
    await this.indexWallet(saved.walletAddress, saved.platformId);
    return saved;
  }
  async findAction(platformId: string, name: string, idempotencyKey: string): Promise<StoredAction | null> {
    const snap = await this.db.collection(ACTION_KEYS).doc(actionKey(platformId, name, idempotencyKey)).get();
    if (!snap.exists) return null;
    const actionId = (snap.data() as { actionId?: unknown }).actionId;
    if (typeof actionId !== "string") return null;
    return this.getAction(actionId);
  }
  async reserveAction(action: StoredAction): Promise<{ action: StoredAction; created: boolean }> {
    const keyRef = this.db.collection(ACTION_KEYS).doc(actionKey(action.platformId, action.name, action.idempotencyKey));
    const actionRef = this.db.collection(ACTIONS).doc(action.id);
    return this.db.runTransaction(async (tx) => {
      const keySnap = await tx.get(keyRef);
      if (keySnap.exists) {
        const actionId = (keySnap.data() as { actionId?: unknown }).actionId;
        if (typeof actionId !== "string") {
          throw new AgentsError("NOT_FOUND", "Idempotency key points at a missing action.", 409);
        }
        const existingSnap = await tx.get(this.db.collection(ACTIONS).doc(actionId));
        if (!existingSnap.exists) throw new AgentsError("NOT_FOUND", "Idempotency key points at a missing action.", 409);
        const existing = existingSnap.data() as StoredAction;
        if (holdsIdempotencyKey(existing, Date.now())) return { action: existing, created: false };
      }
      tx.set(keyRef, { actionId: action.id, platformId: action.platformId, name: action.name });
      tx.set(actionRef, action);
      return { action, created: true };
    });
  }
  async readUsage(platformId: string): Promise<{ spentTodayLamports: string; actionsLastMinute: number }> {
    const now = Date.now();
    return presentUsage(usageFromActions(await this.collectActions(platformId), now), now);
  }
  async noteUsage(platformId: string, amountLamports: string, at: number): Promise<void> {
    const ref = this.db.collection(USAGE).doc(platformId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      tx.set(ref, noteDoc(snap.exists ? (snap.data() as UsageDoc) : null, amountLamports, at));
    });
  }
  async forgetUsage(platformId: string, amountLamports: string, createdAt: number): Promise<void> {
    const ref = this.db.collection(USAGE).doc(platformId);
    const now = Date.now();
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      tx.set(ref, forgetDoc(snap.exists ? (snap.data() as UsageDoc) : null, amountLamports, createdAt, now));
    });
  }
  async expirePending(platformId: string): Promise<void> {
    const actions = await this.collectActions(platformId);
    for (const action of actions) {
      if (action.status !== "pending_owner" && action.status !== "pending_agent") continue;
      await this.saveAction({ ...action, status: "expired" });
      await this.forgetUsage(platformId, action.amountLamports, action.createdAt);
    }
  }
  async saveJob(job: Job): Promise<void> {
    await this.db.collection(JOBS).doc(job.id).set(job);
  }
  async getJob(id: string): Promise<Job | null> {
    const snap = await this.db.collection(JOBS).doc(id).get();
    return snap.exists ? (snap.data() as Job) : null;
  }
  async updateJob<T>(id: string, update: (job: Job | null) => { job: Job | null; result: T }): Promise<T> {
    const ref = this.db.collection(JOBS).doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? (snap.data() as Job) : null;
      const next = update(current);
      if (next.job) tx.set(ref, next.job);
      return next.result;
    });
  }
  async listJobsForAgent(platformId: string): Promise<Job[]> {
    const [buyer, seller] = await Promise.all([
      this.collectJobs("buyerPlatformId", platformId),
      this.collectJobs("sellerPlatformId", platformId),
    ]);
    return dedupeJobs([buyer, seller]);
  }
  async listJobsForOwner(owner: string): Promise<Job[]> {
    const [buyer, seller] = await Promise.all([
      this.collectJobs("buyerOwner", owner),
      this.collectJobs("sellerOwner", owner),
    ]);
    return dedupeJobs([buyer, seller]);
  }
  async cancelOpenJobs(platformId: string): Promise<void> {
    await persistCancellations(await this.listJobsForAgent(platformId), (job) => this.saveJob(job));
  }
  async listPeer(pairId: string): Promise<PeerMessage[]> {
    const snap = await this.db.collection(PEERS).doc(pairId).get();
    const messages = snap.data()?.messages;
    return Array.isArray(messages) ? (messages as PeerMessage[]) : [];
  }
  async appendPeer(pairId: string, message: PeerMessage): Promise<PeerMessage> {
    const ref = this.db.collection(PEERS).doc(pairId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.data()?.messages;
      const messages = Array.isArray(current) ? (current as PeerMessage[]) : [];
      tx.set(ref, { messages: [...messages, message].slice(-200) });
    });
    return message;
  }
  async saveProvider(link: ProviderLink): Promise<void> {
    await this.db.collection(PROVIDERS).doc(`${link.owner}__${link.provider}`).set(link);
  }
  async getProvider(owner: string, provider: string): Promise<ProviderLink | null> {
    const snap = await this.db.collection(PROVIDERS).doc(`${owner}__${provider}`).get();
    return snap.exists ? (snap.data() as ProviderLink) : null;
  }
  async listProviders(owner: string): Promise<ProviderLink[]> {
    const snap = await this.db.collection(PROVIDERS).where("owner", "==", owner).limit(10).get();
    return snap.docs.map((doc) => doc.data() as ProviderLink);
  }
  async saveWorkspace(workspace: AgentWorkspace): Promise<void> {
    await this.db.collection(WORKSPACES).doc(workspace.platformId).set(workspace);
  }
  async getWorkspace(platformId: string): Promise<AgentWorkspace | null> {
    const snap = await this.db.collection(WORKSPACES).doc(platformId).get();
    return snap.exists ? (snap.data() as AgentWorkspace) : null;
  }
  async updateWorkspace(platformId: string, update: (current: AgentWorkspace | null) => AgentWorkspace): Promise<AgentWorkspace> {
    const ref = this.db.collection(WORKSPACES).doc(platformId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const next = update(snap.exists ? (snap.data() as AgentWorkspace) : null);
      tx.set(ref, next);
      return next;
    });
  }
  async saveMcp(server: McpServer): Promise<void> {
    await this.db.collection(MCP).doc(`${server.platformId}__${server.name}`).set(server);
  }
  async listMcp(platformId: string): Promise<McpServer[]> {
    const snap = await this.db.collection(MCP).where("platformId", "==", platformId).limit(20).get();
    return snap.docs.map((doc) => doc.data() as McpServer);
  }
  async deleteMcp(platformId: string, name: string): Promise<void> {
    await this.db.collection(MCP).doc(`${platformId}__${name}`).delete();
  }
  async saveSeal(id: string, sealed: string): Promise<void> {
    await this.db.collection(SEALS).doc(id.replace(/[^\w.-]/g, "_")).set({ sealed });
  }
  async getSeal(id: string): Promise<string | null> {
    const snap = await this.db.collection(SEALS).doc(id.replace(/[^\w.-]/g, "_")).get();
    const sealed = snap.data()?.sealed;
    return typeof sealed === "string" ? sealed : null;
  }
  async deleteSeal(id: string): Promise<void> {
    await this.db.collection(SEALS).doc(id.replace(/[^\w.-]/g, "_")).delete();
  }
  async saveRuntime(doc: AgentRuntimeDoc): Promise<void> {
    await this.db.collection(RUNTIMES).doc(doc.platformId).set(doc);
  }
  async getRuntime(platformId: string): Promise<AgentRuntimeDoc | null> {
    const snap = await this.db.collection(RUNTIMES).doc(platformId).get();
    return snap.exists ? (snap.data() as AgentRuntimeDoc) : null;
  }
  private async collectJobs(field: string, value: string): Promise<Job[]> {
    const out: Job[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (let page = 0; page < 10; page += 1) {
      let query = this.db.collection(JOBS).where(field, "==", value).orderBy(FieldPath.documentId()).limit(200);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      for (const doc of snap.docs) out.push(doc.data() as Job);
      if (snap.size < 200) return out;
      cursor = snap.docs[snap.docs.length - 1];
    }
    throw new AgentsError("JOBS_TRUNCATED", "Job history is incomplete. Reputation was not awarded.", 503);
  }
  private async indexWallet(address: string, platformId: string): Promise<void> {
    if (!address) return;
    await this.db.collection(WALLETS).doc(address).set({ platformId });
  }
  private async collectActions(platformId: string): Promise<StoredAction[]> {
    const out: StoredAction[] = [];
    let cursor: QueryDocumentSnapshot | undefined;
    for (let page = 0; page < 50; page += 1) {
      let query = this.db
        .collection(ACTIONS)
        .where("platformId", "==", platformId)
        .orderBy(FieldPath.documentId())
        .limit(200);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      for (const doc of snap.docs) out.push(doc.data() as StoredAction);
      if (snap.size < 200) return out;
      cursor = snap.docs[snap.docs.length - 1];
    }
    if (out.length >= SPEND_PAGE_LIMIT) {
      throw new AgentsError("POLICY_DENIED", "Spend history could not be totaled. The action was refused.", 403);
    }
    throw new AgentsError("POLICY_DENIED", "Spend history could not be totaled. The action was refused.", 403);
  }
}

class MemoryStore implements AgentStore {
  private readonly mem = memory();
  async saveAgent(agent: StoredAgent): Promise<void> {
    this.mem.agents.set(agent.platformId, agent);
    if (agent.walletAddress) this.mem.wallets.set(agent.walletAddress, agent.platformId);
    for (const retired of agent.retiredWallets) {
      if (retired.address) this.mem.wallets.set(retired.address, agent.platformId);
    }
  }
  async getAgent(platformId: string): Promise<StoredAgent | null> {
    return this.mem.agents.get(platformId) ?? null;
  }
  async listByOwner(owner: string): Promise<StoredAgent[]> {
    return [...this.mem.agents.values()].filter((agent) => agent.owner === owner);
  }
  async listPublished(): Promise<StoredAgent[]> {
    return [...this.mem.agents.values()].filter((agent) => (agent.directorySkills?.length ?? 0) > 0);
  }
  async savePolicy(policy: StoredPolicy): Promise<void> {
    this.mem.policies.set(policy.platformId, policy);
  }
  async getPolicy(platformId: string): Promise<StoredPolicy> {
    return this.mem.policies.get(platformId) ?? { ...defaultPolicy(), platformId, updatedAt: 0 };
  }
  async saveGrant(grant: StoredGrant): Promise<void> {
    this.mem.grants.set(`${grant.platformId}__${grant.callerPlatformId}`, grant);
  }
  async getGrant(platformId: string, callerPlatformId: string): Promise<StoredGrant | null> {
    return this.mem.grants.get(`${platformId}__${callerPlatformId}`) ?? null;
  }
  async saveAction(action: StoredAction): Promise<void> {
    this.mem.actions.set(action.id, action);
  }
  async getAction(id: string): Promise<StoredAction | null> {
    return this.mem.actions.get(id) ?? null;
  }
  async listActions(platformId: string): Promise<StoredAction[]> {
    return [...this.mem.actions.values()].filter((action) => action.platformId === platformId);
  }
  async saveAudit(row: StoredAudit): Promise<void> {
    this.mem.audits.set(row.id, row);
  }
  async listAudit(platformId: string): Promise<StoredAudit[]> {
    return [...this.mem.audits.values()].filter((row) => row.platformId === platformId);
  }
  async listMessages(platformId: string): Promise<StoredChatMessage[]> {
    return this.mem.threads.get(platformId) ?? [];
  }
  async updateThread<T>(
    platformId: string,
    update: (messages: StoredChatMessage[]) => { messages: StoredChatMessage[]; result: T }
  ): Promise<T> {
    const next = update(this.mem.threads.get(platformId) ?? []);
    this.mem.threads.set(platformId, next.messages);
    return next.result;
  }
  async putSecret(id: string, doc: SecretDoc): Promise<void> {
    this.mem.secrets.set(id, doc);
  }
  async getSecret(id: string): Promise<SecretDoc | null> {
    const doc = this.mem.secrets.get(id);
    if (!doc || doc.kind === "nonce") return null;
    return doc;
  }
  async listSecrets(platformId: string): Promise<SecretDoc[]> {
    return [...this.mem.secrets.values()].filter(
      (doc): doc is SecretDoc => doc.kind !== "nonce" && doc.platformId === platformId
    );
  }
  async putNonce(id: string, doc: NonceDoc): Promise<void> {
    this.mem.secrets.set(`nonce_${id}`, doc);
  }
  async consumeNonce(id: string, purpose: string, subject: string): Promise<void> {
    const key = `nonce_${id}`;
    const doc = this.mem.secrets.get(key);
    if (!doc || doc.kind !== "nonce" || doc.used || doc.purpose !== purpose || doc.subject !== subject) {
      throw new AgentsError("NONCE_INVALID", "Nonce does not match this request.", 400);
    }
    if (doc.expiresAt < Date.now()) throw new AgentsError("NONCE_EXPIRED", "Nonce expired.", 400);
    this.mem.secrets.set(key, { ...doc, used: true });
  }
  async isHireWallet(address: string): Promise<boolean> {
    return this.mem.wallets.has(address);
  }
  async listActiveCredentials(platformId: string): Promise<SecretDoc[]> {
    return [...this.mem.secrets.values()].filter(
      (doc): doc is SecretDoc => doc.kind === "credential" && doc.platformId === platformId && !doc.revokedAt
    );
  }
  async claimRuntime(input: {
    platformId: string;
    nonce: string;
    publicKey: string;
    secret: SecretDoc;
  }): Promise<StoredAgent> {
    const agent = this.mem.agents.get(input.platformId);
    if (!agent || agent.claimNonce !== input.nonce) {
      throw new AgentsError("NONCE_INVALID", "Claim challenge is invalid.", 400);
    }
    const next: StoredAgent = {
      ...agent,
      claimNonce: null,
      runtimePublicKey: input.publicKey,
      status: agent.status === "pending_credential" ? "active" : agent.status,
      updatedAt: Date.now(),
    };
    this.mem.agents.set(input.platformId, next);
    this.mem.secrets.set(input.secret.hash, input.secret);
    return next;
  }
  async findAction(platformId: string, name: string, idempotencyKey: string): Promise<StoredAction | null> {
    const id = this.mem.actionKeys.get(actionKey(platformId, name, idempotencyKey));
    if (!id) return null;
    return this.mem.actions.get(id) ?? null;
  }
  async reserveAction(action: StoredAction): Promise<{ action: StoredAction; created: boolean }> {
    const key = actionKey(action.platformId, action.name, action.idempotencyKey);
    const existingId = this.mem.actionKeys.get(key);
    if (existingId) {
      const existing = this.mem.actions.get(existingId);
      if (!existing) throw new AgentsError("NOT_FOUND", "Idempotency key points at a missing action.", 409);
      if (holdsIdempotencyKey(existing, Date.now())) return { action: existing, created: false };
    }
    this.mem.actionKeys.set(key, action.id);
    this.mem.actions.set(action.id, action);
    return { action, created: true };
  }
  async readUsage(platformId: string): Promise<{ spentTodayLamports: string; actionsLastMinute: number }> {
    const now = Date.now();
    const actions = [...this.mem.actions.values()].filter((action) => action.platformId === platformId);
    if (actions.length > SPEND_PAGE_LIMIT) {
      throw new AgentsError("POLICY_DENIED", "Spend history could not be totaled. The action was refused.", 403);
    }
    return presentUsage(usageFromActions(actions, now), now);
  }
  async noteUsage(platformId: string, amountLamports: string, at: number): Promise<void> {
    this.mem.usage.set(platformId, noteDoc(this.mem.usage.get(platformId) ?? null, amountLamports, at));
  }
  async forgetUsage(platformId: string, amountLamports: string, createdAt: number): Promise<void> {
    this.mem.usage.set(
      platformId,
      forgetDoc(this.mem.usage.get(platformId) ?? null, amountLamports, createdAt, Date.now())
    );
  }
  async expirePending(platformId: string): Promise<void> {
    for (const action of this.mem.actions.values()) {
      if (action.platformId !== platformId) continue;
      if (action.status !== "pending_owner" && action.status !== "pending_agent") continue;
      this.mem.actions.set(action.id, { ...action, status: "expired" });
      await this.forgetUsage(platformId, action.amountLamports, action.createdAt);
    }
  }
  async saveJob(job: Job): Promise<void> {
    this.mem.jobs.set(job.id, job);
  }
  async getJob(id: string): Promise<Job | null> {
    return this.mem.jobs.get(id) ?? null;
  }
  async updateJob<T>(id: string, update: (job: Job | null) => { job: Job | null; result: T }): Promise<T> {
    const next = update(this.mem.jobs.get(id) ?? null);
    if (next.job) this.mem.jobs.set(next.job.id, next.job);
    return next.result;
  }
  async listJobsForAgent(platformId: string): Promise<Job[]> {
    return this.jobsWhere((job) => job.buyerPlatformId === platformId || job.sellerPlatformId === platformId);
  }
  async listJobsForOwner(owner: string): Promise<Job[]> {
    return this.jobsWhere((job) => job.buyerOwner === owner || job.sellerOwner === owner);
  }
  async cancelOpenJobs(platformId: string): Promise<void> {
    await persistCancellations(await this.listJobsForAgent(platformId), async (job) => {
      this.mem.jobs.set(job.id, job);
    });
  }
  async listPeer(pairId: string): Promise<PeerMessage[]> {
    return this.mem.peers.get(pairId) ?? [];
  }
  async appendPeer(pairId: string, message: PeerMessage): Promise<PeerMessage> {
    const current = this.mem.peers.get(pairId) ?? [];
    this.mem.peers.set(pairId, [...current, message].slice(-200));
    return message;
  }
  async saveProvider(link: ProviderLink): Promise<void> {
    this.mem.providers.set(`${link.owner}__${link.provider}`, link);
  }
  async getProvider(owner: string, provider: string): Promise<ProviderLink | null> {
    return this.mem.providers.get(`${owner}__${provider}`) ?? null;
  }
  async listProviders(owner: string): Promise<ProviderLink[]> {
    return [...this.mem.providers.values()].filter((link) => link.owner === owner);
  }
  async saveWorkspace(workspace: AgentWorkspace): Promise<void> {
    this.mem.workspaces.set(workspace.platformId, workspace);
  }
  async getWorkspace(platformId: string): Promise<AgentWorkspace | null> {
    return this.mem.workspaces.get(platformId) ?? null;
  }
  async updateWorkspace(platformId: string, update: (current: AgentWorkspace | null) => AgentWorkspace): Promise<AgentWorkspace> {
    const next = update(this.mem.workspaces.get(platformId) ?? null);
    this.mem.workspaces.set(platformId, next);
    return next;
  }
  async saveMcp(server: McpServer): Promise<void> {
    this.mem.mcp.set(`${server.platformId}__${server.name}`, server);
  }
  async listMcp(platformId: string): Promise<McpServer[]> {
    return [...this.mem.mcp.values()].filter((server) => server.platformId === platformId);
  }
  async deleteMcp(platformId: string, name: string): Promise<void> {
    this.mem.mcp.delete(`${platformId}__${name}`);
  }
  async saveSeal(id: string, sealed: string): Promise<void> {
    this.mem.seals.set(id, sealed);
  }
  async getSeal(id: string): Promise<string | null> {
    return this.mem.seals.get(id) ?? null;
  }
  async deleteSeal(id: string): Promise<void> {
    this.mem.seals.delete(id);
  }
  async saveRuntime(doc: AgentRuntimeDoc): Promise<void> {
    this.mem.runtimes.set(doc.platformId, doc);
  }
  async getRuntime(platformId: string): Promise<AgentRuntimeDoc | null> {
    return this.mem.runtimes.get(platformId) ?? null;
  }
  private jobsWhere(match: (job: Job) => boolean): Job[] {
    const out = [...this.mem.jobs.values()].filter(match);
    if (out.length > JOB_LIST_LIMIT) {
      throw new AgentsError("JOBS_TRUNCATED", "Job history is incomplete. Reputation was not awarded.", 503);
    }
    return out;
  }
}

let cached: AgentStore | null = null;

export async function isHireWallet(address: string): Promise<boolean> {
  try {
    return await agentStore().isHireWallet(address);
  } catch (error) {
    if (error instanceof AgentsError && error.code === "STORE_UNAVAILABLE") return false;
    throw error;
  }
}

export function agentStore(): AgentStore {
  if (cached) return cached;
  const db = getAdminDb();
  if (db) {
    cached = new FirestoreStore(db);
    return cached;
  }
  if (process.env.NODE_ENV === "production") {
    throw new AgentsError("STORE_UNAVAILABLE", "Firestore is not configured.", 503);
  }
  cached = new MemoryStore();
  return cached;
}

export function publicAgent(agent: StoredAgent) {
  const supervisor = isSupervisor(agent.platformId);
  return {
    platformId: agent.platformId,
    identifier: agent.registryAsset ?? null,
    name: agent.name,
    owner: agent.owner,
    status: agent.status,
    walletAddress: agent.walletAddress,
    walletProvider: agent.walletProvider,
    endpoint: agent.endpointVerifiedAt ? agent.endpoint : null,
    slimName: agent.slimName,
    hireable: !supervisor,
    directoryCid: supervisor ? null : agent.directoryCid,
    directorySkills: supervisor ? [] : Array.isArray(agent.directorySkills) ? agent.directorySkills : [],
    directoryDomains: supervisor ? [] : Array.isArray(agent.directoryDomains) ? agent.directoryDomains : [],
    retiredWallets: agent.retiredWallets,
    transferredAt: agent.transferredAt ?? null,
    agentModel: agent.agentModel ?? null,
    createdAt: agent.createdAt,
  };
}
