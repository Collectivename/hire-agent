import "server-only";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { canonicalJson, evaluatePolicy, type PolicyDecision } from "../protocol";
import {
  assemblePumpCreateIxs,
  assertProposalBelongs,
  attachMintSigner,
  buildCreateProposalIxs,
  buildPumpSwap,
  buildVoteIxs,
  bundleDigest,
  buyLamportsFromFields,
  compilePumpCreateBundle,
  deriveGovernanceAddresses,
  deriveLaunchMint,
  deriveTokenOwnerRecord,
  deserializeTx,
  fetchLookupTables,
  fetchPumpProtocolAlt,
  getServerConnection,
  issueBundleToken,
  newLaunchNonce,
  packInstructions,
  pinPumpMetadata,
  pumpLaunchFieldsFromBody,
  serializeTx,
  solTransferLines,
  tokenTransferLines,
  validateProposalAction,
  validatePumpLaunchBody,
  withCollectiveTag,
  type ProposalAction,
} from "./host";
import { canonicalPubkey, randomId, sha256Hex, verifyEd25519Bytes } from "./crypto";
import { AgentsError } from "./errors";
import { agentStore, type StoredAction, type StoredAgent, type StoredAudit } from "./store";

const ACTION_TTL_MS = 90_000;

function summary(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value.length > 200) continue;
    out[key] = value;
  }
  return out;
}

function programIdsOf(b64: string): string[] {
  const tx = deserializeTx(b64);
  if (tx instanceof VersionedTransaction) {
    const keys = tx.message.staticAccountKeys;
    return tx.message.compiledInstructions.map((ix) => {
      const key = keys[ix.programIdIndex];
      if (!key) {
        throw new AgentsError("INVALID_PARAMS", "Program id could not be resolved.", 400);
      }
      return key.toBase58();
    });
  }
  return tx.instructions.map((ix) => ix.programId.toBase58());
}

async function simulateAll(transactions: string[]): Promise<void> {
  const connection = getServerConnection();
  for (const b64 of transactions) {
    const tx = deserializeTx(b64);
    const result =
      tx instanceof VersionedTransaction
        ? await connection.simulateTransaction(tx, { sigVerify: false })
        : await connection.simulateTransaction(tx);
    if (result.value.err) {
      throw new AgentsError(
        "SIMULATION_FAILED",
        "Simulation failed. A failed simulation is not a pass.",
        400
      );
    }
  }
}

async function audit(row: Omit<StoredAudit, "id" | "createdAt">): Promise<void> {
  await agentStore().saveAudit({ ...row, id: randomId("aud"), createdAt: Date.now() });
}

async function accountedUsage(
  platformId: string,
  exclude?: StoredAction
): Promise<{ spentTodayLamports: string; actionsLastMinute: number }> {
  const usage = await agentStore().readUsage(platformId);
  let spent = BigInt(usage.spentTodayLamports);
  let recent = usage.actionsLastMinute;
  if (!exclude) return { spentTodayLamports: spent.toString(), actionsLastMinute: recent };
  const counted = exclude.status !== "rejected" && exclude.status !== "failed" && exclude.status !== "expired";
  if (!counted) return { spentTodayLamports: spent.toString(), actionsLastMinute: recent };
  const today = new Date().toISOString().slice(0, 10);
  if (new Date(exclude.createdAt).toISOString().slice(0, 10) === today && /^\d+$/.test(exclude.amountLamports)) {
    spent -= BigInt(exclude.amountLamports);
    if (spent < BigInt(0)) spent = BigInt(0);
  }
  if (exclude.createdAt >= Date.now() - 60_000) recent = Math.max(0, recent - 1);
  return { spentTodayLamports: spent.toString(), actionsLastMinute: recent };
}

function policyFields(action: StoredAction): {
  recipients: string[];
  authorityChange: boolean;
  payment: boolean;
} {
  const recipients = action.request.recipients
    ? action.request.recipients.split(",").filter(Boolean)
    : action.request.recipient
      ? [action.request.recipient]
      : [];
  return {
    recipients,
    authorityChange: action.name === "launch" || action.request.authorityChange === "true",
    payment: action.name === "pay" || action.request.payment === "true",
  };
}

async function evaluateStored(agent: StoredAgent, action: StoredAction): Promise<PolicyDecision> {
  let programIds: string[];
  try {
    programIds = action.unsignedTransactions.flatMap((tx) => programIdsOf(tx));
  } catch {
    return { allow: false, reason: "Program id could not be resolved.", risk: "high", signer: "none" };
  }
  const usage = await accountedUsage(agent.platformId, action);
  const fields = policyFields(action);
  return evaluatePolicy(await agentStore().getPolicy(agent.platformId), {
    action: action.name,
    programIds,
    amountLamports: action.amountLamports,
    recipient: action.request.recipient || null,
    recipients: fields.recipients,
    mint: action.request.mint || null,
    authorityChange: fields.authorityChange,
    payment: fields.payment,
    paused: agent.status !== "active",
    spentTodayLamports: usage.spentTodayLamports,
    actionsLastMinute: usage.actionsLastMinute,
  });
}

function proposalEffects(action: ProposalAction | undefined): {
  amountLamports: string;
  recipient: string | null;
  recipients: string[];
  authorityChange: boolean;
  payment: boolean;
} {
  if (!action) {
    return { amountLamports: "0", recipient: null, recipients: [], authorityChange: false, payment: false };
  }
  if (action.kind === "sol-transfer") {
    const lines = solTransferLines(action);
    if (lines.length === 0) throw new AgentsError("INVALID_PARAMS", "SOL transfer needs a recipient.", 400);
    let total = BigInt(0);
    const recipients: string[] = [];
    for (const line of lines) {
      const key = canonicalPubkey(line.recipient);
      if (!key) throw new AgentsError("INVALID_PARAMS", "SOL transfer recipient is not a public key.", 400);
      if (!Number.isFinite(line.amountSol) || line.amountSol <= 0) {
        throw new AgentsError("INVALID_PARAMS", "SOL transfer amount must be positive.", 400);
      }
      const lamports = Math.round(line.amountSol * 1_000_000_000);
      if (!Number.isSafeInteger(lamports) || lamports <= 0) {
        throw new AgentsError("INVALID_PARAMS", "SOL transfer amount is not a lamport total.", 400);
      }
      total += BigInt(lamports);
      recipients.push(key);
    }
    return { amountLamports: total.toString(), recipient: recipients[0] ?? null, recipients, authorityChange: false, payment: true };
  }
  if (action.kind === "token-transfer") {
    const lines = tokenTransferLines(action);
    if (lines.length === 0) throw new AgentsError("INVALID_PARAMS", "Token transfer needs a recipient.", 400);
    const recipients = lines.map((line) => {
      const key = canonicalPubkey(line.recipient);
      if (!key) throw new AgentsError("INVALID_PARAMS", "Token transfer recipient is not a public key.", 400);
      return key;
    });
    return {
      amountLamports: "0",
      recipient: recipients[0] ?? null,
      recipients,
      authorityChange: true,
      payment: true,
    };
  }
  return { amountLamports: "0", recipient: null, recipients: [], authorityChange: true, payment: false };
}

function feePayerProof(b64: string): { message: Uint8Array; signature: Uint8Array } | null {
  const tx = deserializeTx(b64);
  if (tx instanceof VersionedTransaction) {
    const signature = tx.signatures[0];
    if (!signature || signature.every((byte) => byte === 0)) return null;
    return { message: tx.message.serialize(), signature };
  }
  if (!tx.signature || tx.signature.every((byte) => byte === 0)) return null;
  return { message: tx.serializeMessage(), signature: tx.signature };
}

async function packLegacy(instructions: import("@solana/web3.js").TransactionInstruction[], payer: PublicKey): Promise<string[]> {
  const connection = getServerConnection();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  return packInstructions(instructions, payer, blockhash).map(serializeTx);
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AgentsError("INVALID_PARAMS", "JSON object required.", 400);
  }
  return body as Record<string, unknown>;
}

function pubkeyField(body: Record<string, unknown>, key: string): string {
  const value = canonicalPubkey(body[key]);
  if (!value) throw new AgentsError("INVALID_PARAMS", `${key} must be a canonical public key.`, 400);
  return value;
}

export async function requestAction(
  agent: StoredAgent,
  name: string,
  body: unknown
): Promise<{ action: StoredAction; decision: PolicyDecision; bundleToken?: string; read?: Record<string, string> }> {
  const raw = objectBody(body);
  const idempotencyKey = typeof raw.idempotencyKey === "string" ? raw.idempotencyKey.trim() : "";
  if (!/^[a-zA-Z0-9_.:-]{8,80}$/.test(idempotencyKey)) {
    throw new AgentsError("INVALID_PARAMS", "idempotencyKey must be 8–80 url-safe characters.", 400);
  }
  if (raw.wallet != null && raw.wallet !== agent.walletAddress) {
    throw new AgentsError("INVALID_PARAMS", "The fee payer is the agent's provisioned wallet.", 400);
  }

  const store = agentStore();
  const existing =
    (await store.findAction(agent.platformId, name, idempotencyKey)) ??
    (await store.listActions(agent.platformId)).find(
      (action) => action.name === name && action.idempotencyKey === idempotencyKey
    );
  if (existing && name === "launch") {
    const open =
      (existing.status === "pending_owner" || existing.status === "pending_agent") && existing.expiresAt > Date.now();
    if (!open) {
      throw new AgentsError(
        "LAUNCH_ALREADY_MINTED",
        "This launch key already created a mint payload. Refusing to mint again.",
        409
      );
    }
  }
  if (existing && (existing.status === "confirmed" || existing.confirmedSteps > 0)) {
    return {
      action: existing,
      decision: { allow: true, reason: "Already recorded.", risk: existing.risk, signer: existing.signer },
    };
  }
  if (existing && (existing.status === "pending_owner" || existing.status === "pending_agent") && existing.expiresAt > Date.now()) {
    const decision = await evaluateStored(agent, existing);
    if (!decision.allow || decision.signer === "none") {
      existing.status = "rejected";
      await store.saveAction(existing);
      await store.forgetUsage(agent.platformId, existing.amountLamports, existing.createdAt);
      throw new AgentsError("POLICY_DENIED", decision.reason, 403);
    }
    return { action: existing, decision };
  }
  if (existing && existing.status === "failed" && name !== "launch") {
    await store.forgetUsage(agent.platformId, existing.amountLamports, existing.createdAt);
  }

  const built = await build(agent, name, raw);
  const ids = built.transactions.flatMap((tx) => programIdsOf(tx));
  const usage = await accountedUsage(agent.platformId);
  const recipients = built.recipients ?? (built.recipient ? [built.recipient] : []);
  const payment = Boolean(built.payment) || name === "pay";
  const authorityChange = Boolean(built.authorityChange) || name === "launch";
  const policy = await store.getPolicy(agent.platformId);
  const decision = evaluatePolicy(policy, {
    action: name,
    programIds: ids,
    amountLamports: built.amountLamports,
    recipient: built.recipient,
    recipients,
    mint: built.mint,
    authorityChange,
    payment,
    paused: agent.status !== "active",
    spentTodayLamports: usage.spentTodayLamports,
    actionsLastMinute: usage.actionsLastMinute,
  });
  if (!decision.allow || decision.signer === "none") {
    await audit({
      platformId: agent.platformId,
      actionId: null,
      kind: "policy.deny",
      summary: decision.reason,
      verified: false,
      reported: true,
      detail: { action: name },
    });
    throw new AgentsError("POLICY_DENIED", decision.reason, 403);
  }

  if (built.transactions.length > 0) {
    const simTargets =
      built.launchNonce == null
        ? built.transactions
        : built.transactions.map((tx, index) =>
            index === 0 ? attachMintSigner(tx, deriveLaunchMint(built.launchNonce!)) : tx
          );
    await simulateAll(simTargets);
  }

  let payloadHash = sha256Hex(canonicalJson(built.request));
  if (built.transactions.length > 0) {
    const tables = built.lookupTables.length
      ? await fetchLookupTables(
          getServerConnection(),
          built.lookupTables.map((key) => new PublicKey(key))
        )
      : undefined;
    payloadHash = bundleDigest(built.transactions, tables);
  }

  const action: StoredAction = {
    id: randomId("act"),
    platformId: agent.platformId,
    name,
    status:
      built.read && built.transactions.length === 0
        ? "confirmed"
        : decision.signer === "owner"
          ? "pending_owner"
          : "pending_agent",
    risk: decision.risk,
    signer: decision.signer,
    payloadHash,
    unsignedTransactions: built.transactions,
    request: {
      ...built.request,
      recipient: built.recipient ?? "",
      recipients: recipients.join(","),
      payment: payment ? "true" : "false",
      authorityChange: authorityChange ? "true" : "false",
      mint: built.mint ?? "",
    },
    amountLamports: built.amountLamports,
    simulationPassed: true,
    idempotencyKey,
    launchNonce: built.launchNonce,
    launchMint: built.launchMint,
    launchStep: built.launchStep,
    confirmedSteps: 0,
    lookupTables: built.lookupTables,
    signature: null,
    verified: Boolean(built.read && built.transactions.length === 0),
    createdAt: Date.now(),
    expiresAt: Date.now() + ACTION_TTL_MS,
  };
  const reserved = await store.reserveAction(action);
  if (!reserved.created) {
    return {
      action: reserved.action,
      decision: { allow: true, reason: "Already recorded.", risk: reserved.action.risk, signer: reserved.action.signer },
    };
  }
  await store.noteUsage(agent.platformId, action.amountLamports, action.createdAt);
  await audit({
    platformId: agent.platformId,
    actionId: action.id,
    kind: "action.issued",
    summary: `${name} issued for ${decision.signer}. Simulation passed and is not proof the action is safe.`,
    verified: false,
    reported: true,
    detail: { payloadHash: action.payloadHash, risk: decision.risk },
  });
  return { action, decision, bundleToken: built.bundleToken, read: built.read };
}

type Built = {
  transactions: string[];
  amountLamports: string;
  recipient: string | null;
  recipients?: string[];
  authorityChange?: boolean;
  payment?: boolean;
  mint: string | null;
  request: Record<string, string>;
  launchNonce: string | null;
  launchMint: string | null;
  launchStep: string | null;
  lookupTables: string[];
  bundleToken?: string;
  read?: Record<string, string>;
};

async function build(agent: StoredAgent, name: string, raw: Record<string, unknown>): Promise<Built> {
  const payer = new PublicKey(agent.walletAddress);
  if (name === "dao.read") {
    const realm = pubkeyField(raw, "realm");
    const info = await getServerConnection().getAccountInfo(new PublicKey(realm));
    return {
      transactions: [],
      amountLamports: "0",
      recipient: null,
      mint: null,
      request: summary({ realm }),
      launchNonce: null,
      launchMint: null,
      launchStep: null,
      lookupTables: [],
      read: {
        realm,
        exists: info ? "true" : "false",
        lamports: String(info?.lamports ?? 0),
        verified: "true",
      },
    };
  }
  if (name === "propose") {
    const realm = pubkeyField(raw, "realm");
    const governance = pubkeyField(raw, "governance");
    const communityMint = pubkeyField(raw, "communityMint");
    const nativeTreasury = pubkeyField(raw, "nativeTreasury");
    const title = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!title) throw new AgentsError("INVALID_PARAMS", "name is required.", 400);
    const proposalAction = raw.action as ProposalAction | undefined;
    if (proposalAction) {
      const actionError = validateProposalAction(proposalAction);
      if (actionError) throw new AgentsError("INVALID_PARAMS", actionError, 400);
    }
    const derived = deriveGovernanceAddresses(new PublicKey(realm), new PublicKey(communityMint));
    if (governance !== derived.governance.toBase58() || nativeTreasury !== derived.nativeTreasury.toBase58()) {
      throw new AgentsError("INVALID_PARAMS", "governance or treasury does not match this realm and mint.", 400);
    }
    const connection = getServerConnection();
    const tokenOwnerRecord = await deriveTokenOwnerRecord(
      new PublicKey(realm),
      new PublicKey(communityMint),
      payer
    );
    const built = await buildCreateProposalIxs({
      connection,
      realm: new PublicKey(realm),
      governance: new PublicKey(governance),
      communityMint: new PublicKey(communityMint),
      owner: payer,
      tokenOwnerRecord,
      nativeTreasury: new PublicKey(nativeTreasury),
      name: title,
      description: typeof raw.description === "string" ? raw.description.slice(0, 1500) : "",
      action: proposalAction,
    });
    const transactions = await packLegacy(built.instructions, payer);
    const effects = proposalEffects(proposalAction);
    return {
      transactions,
      amountLamports: effects.amountLamports,
      recipient: effects.recipient,
      recipients: effects.recipients,
      authorityChange: effects.authorityChange,
      payment: effects.payment,
      mint: communityMint,
      request: summary({ realm, governance, communityMint, proposal: built.proposal }),
      launchNonce: null,
      launchMint: null,
      launchStep: null,
      lookupTables: [],
    };
  }
  if (name === "vote") {
    const realm = pubkeyField(raw, "realm");
    const governance = pubkeyField(raw, "governance");
    const communityMint = pubkeyField(raw, "communityMint");
    const proposal = pubkeyField(raw, "proposal");
    const proposalOwnerRecord = pubkeyField(raw, "proposalOwnerRecord");
    if (typeof raw.approve !== "boolean") {
      throw new AgentsError("INVALID_PARAMS", "approve must be true or false.", 400);
    }
    const connection = getServerConnection();
    await assertProposalBelongs(
      connection,
      new PublicKey(proposal),
      new PublicKey(governance),
      new PublicKey(proposalOwnerRecord)
    );
    const tokenOwnerRecord = await deriveTokenOwnerRecord(
      new PublicKey(realm),
      new PublicKey(communityMint),
      payer
    );
    const instructions = await buildVoteIxs({
      connection,
      realm: new PublicKey(realm),
      governance: new PublicKey(governance),
      proposal: new PublicKey(proposal),
      proposalOwnerRecord: new PublicKey(proposalOwnerRecord),
      communityMint: new PublicKey(communityMint),
      owner: payer,
      voterTokenOwnerRecord: tokenOwnerRecord,
      approve: raw.approve,
    });
    return {
      transactions: await packLegacy(instructions, payer),
      amountLamports: "0",
      recipient: null,
      mint: communityMint,
      request: summary({ realm, proposal, approve: raw.approve ? "true" : "false" }),
      launchNonce: null,
      launchMint: null,
      launchStep: null,
      lookupTables: [],
    };
  }
  if (name === "trade") {
    const mint = pubkeyField(raw, "mint");
    const side = raw.side === "sell" ? "sell" : raw.side === "buy" ? "buy" : null;
    const amount = typeof raw.amount === "number" ? raw.amount : Number(raw.amount);
    if (!side || !Number.isFinite(amount) || amount <= 0) {
      throw new AgentsError("INVALID_PARAMS", "side and amount are required.", 400);
    }
    const slippage = typeof raw.slippage === "number" ? raw.slippage : 1;
    const priorityFeeSol = typeof raw.priorityFeeSol === "number" ? raw.priorityFeeSol : 0;
    const built = await buildPumpSwap({
      mint: new PublicKey(mint),
      user: payer,
      side,
      amount,
      slippage,
      priorityFeeSol,
    });
    const lamports =
      side === "buy"
        ? BigInt(Math.round(amount * 1_000_000_000)) + BigInt(Math.round(priorityFeeSol * 1_000_000_000))
        : BigInt(Math.round(priorityFeeSol * 1_000_000_000));
    return {
      transactions: await packLegacy(built.instructions, payer),
      amountLamports: lamports.toString(),
      recipient: mint,
      mint,
      request: summary({ mint, side, amount: String(amount) }),
      launchNonce: null,
      launchMint: null,
      launchStep: null,
      lookupTables: [],
    };
  }
  if (name === "pay") {
    throw new AgentsError(
      "INVALID_PARAMS",
      "A hire is paid with x402 on the job delivery. A raw SOL transfer is refused.",
      400
    );
  }
  if (name === "launch") {
    const fields = pumpLaunchFieldsFromBody({ ...raw, wallet: agent.walletAddress });
    if (!fields) throw new AgentsError("INVALID_PARAMS", "wallet, token, dao, and daoBps are required.", 400);
    const invalid = validatePumpLaunchBody(fields);
    if (invalid) throw new AgentsError("INVALID_PARAMS", invalid, 400);
    const nonce = newLaunchNonce();
    const mint = deriveLaunchMint(nonce).publicKey;
    const connection = getServerConnection();
    const tokenForMetadata = fields.token.appendMintTag
      ? {
          ...fields.token,
          description: withCollectiveTag(fields.token.description, mint.toBase58()),
        }
      : fields.token;
    const uri =
      typeof raw.uri === "string" && raw.uri.startsWith("https://")
        ? raw.uri
        : await pinPumpMetadata(tokenForMetadata);
    const wantBuy = buyLamportsFromFields(fields) > 0;
    const assembled = await assemblePumpCreateIxs({
      mint,
      user: payer,
      fields,
      uri,
      includeBuyPreview: wantBuy,
      connection,
    });
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const protocolAlt = wantBuy ? await fetchPumpProtocolAlt(connection) : null;
    const tables = protocolAlt ? [protocolAlt] : [];
    const compiled = compilePumpCreateBundle({
      user: payer,
      mint,
      recentBlockhash: blockhash,
      createIxs: assembled.createIxs,
      buyIxs: assembled.buyIxs,
      priorityFeeSol: fields.priorityFeeSol,
      tables,
    });
    const transactions = [serializeTx(compiled.createTx), ...compiled.buyTxs.map((tx) => serializeTx(tx))];
    const lookupTables = compiled.createTx.message.addressTableLookups.map((lookup) =>
      lookup.accountKey.toBase58()
    );
    const lamports = BigInt(buyLamportsFromFields(fields)) + BigInt(Math.round(fields.priorityFeeSol * 1_000_000_000));
    return {
      transactions,
      amountLamports: lamports.toString(),
      recipient: mint.toBase58(),
      mint: mint.toBase58(),
      request: summary({ mint: mint.toBase58(), step: "create" }),
      launchNonce: nonce,
      launchMint: mint.toBase58(),
      launchStep: "create",
      lookupTables,
      bundleToken: issueBundleToken(transactions, nonce, tables),
    };
  }
  throw new AgentsError("INVALID_PARAMS", "Unknown action.", 400);
}

export function actionView(action: StoredAction, reveal: boolean) {
  return {
    actionId: action.id,
    name: action.name,
    status: action.status,
    risk: action.risk,
    signer: action.signer,
    payloadHash: action.payloadHash,
    simulationPassed: action.simulationPassed,
    simulationIsNotSafety: true,
    launchMint: action.launchMint,
    launchStep: action.launchStep,
    confirmedSteps: action.confirmedSteps,
    verified: action.verified,
    expiresAt: action.expiresAt,
    unsignedTransactions: reveal ? action.unsignedTransactions : [],
  };
}

export async function launchBundleToken(action: StoredAction): Promise<string | undefined> {
  if (!action.launchNonce || action.unsignedTransactions.length === 0) return undefined;
  const tables = action.lookupTables.length
    ? await fetchLookupTables(
        getServerConnection(),
        action.lookupTables.map((key) => new PublicKey(key))
      )
    : undefined;
  return issueBundleToken(action.unsignedTransactions, action.launchNonce, tables);
}

export async function submitAction(
  agent: StoredAgent,
  name: string,
  actionId: string,
  signedTransactions: string[],
  caller: "owner" | "agent"
): Promise<StoredAction> {
  const store = agentStore();
  const action = await store.getAction(actionId);
  if (!action || action.platformId !== agent.platformId || action.name !== name) {
    throw new AgentsError("NOT_FOUND", "Action not found.", 404);
  }
  if (agent.status !== "active") throw new AgentsError("PAUSED", "Agent is paused.", 403);
  if (action.status === "confirmed") throw new AgentsError("INVALID_PARAMS", "Action is already confirmed.", 400);
  if (action.status === "expired" || action.status === "rejected") {
    throw new AgentsError("EXPIRED", "Action is no longer valid.", 400);
  }
  const decision = await evaluateStored(agent, action);
  if (!decision.allow || decision.signer === "none") {
    action.status = "rejected";
    await store.saveAction(action);
    await store.forgetUsage(agent.platformId, action.amountLamports, action.createdAt);
    throw new AgentsError("POLICY_DENIED", decision.reason, 403);
  }
  if (action.expiresAt < Date.now() && action.confirmedSteps === 0) {
    action.status = "expired";
    await store.saveAction(action);
    await store.forgetUsage(agent.platformId, action.amountLamports, action.createdAt);
    throw new AgentsError("EXPIRED", "Action expired.", 400);
  }
  if ((action.signer === "owner" || decision.signer === "owner") && caller !== "owner") {
    throw new AgentsError("OWNER_REQUIRED", "This payload is released only to the owner.", 403);
  }
  if (signedTransactions.length !== action.unsignedTransactions.length) {
    throw new AgentsError("PAYLOAD_MISMATCH", "Signed transactions do not match the issued payload.", 400);
  }
  const tables = action.lookupTables.length
    ? await fetchLookupTables(
        getServerConnection(),
        action.lookupTables.map((key) => new PublicKey(key))
      )
    : undefined;
  let digest: string;
  try {
    digest = bundleDigest(signedTransactions, tables);
  } catch {
    throw new AgentsError("PAYLOAD_MISMATCH", "Signed transactions do not match the issued payload.", 400);
  }
  if (digest !== action.payloadHash) {
    throw new AgentsError("PAYLOAD_MISMATCH", "Signature is over a different payload.", 400);
  }
  const wallet = new PublicKey(agent.walletAddress).toBytes();
  for (const [index, signed] of signedTransactions.entries()) {
    if (index < action.confirmedSteps) continue;
    const proof = feePayerProof(signed);
    if (!proof || !verifyEd25519Bytes(wallet, proof.message, proof.signature)) {
      throw new AgentsError("BAD_SIGNATURE", "The agent wallet did not sign this payload.", 400);
    }
  }

  const connection = getServerConnection();
  const mint = action.launchNonce ? deriveLaunchMint(action.launchNonce) : null;
  for (let index = action.confirmedSteps; index < signedTransactions.length; index += 1) {
    const signed = mint ? attachMintSigner(signedTransactions[index]!, mint) : signedTransactions[index]!;
    const signature = await connection.sendRawTransaction(Buffer.from(signed, "base64"), {
      skipPreflight: false,
    });
    const status = await connection.confirmTransaction(signature, "confirmed");
    if (status.value.err) {
      action.status = "failed";
      action.signature = signature;
      await store.saveAction(action);
      await audit({
        platformId: agent.platformId,
        actionId: action.id,
        kind: "action.failed",
        summary: "Chain rejected the transaction.",
        verified: true,
        reported: false,
        detail: { signature },
      });
      throw new AgentsError("CHAIN_REJECTED", "The transaction was rejected on chain.", 400);
    }
    const again = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    action.confirmedSteps = index + 1;
    action.signature = signature;
    action.verified = Boolean(again && !again.meta?.err);
    action.launchStep = action.name === "launch" ? `confirmed:${action.confirmedSteps}` : action.launchStep;
    await store.saveAction(action);
  }
  action.status = "confirmed";
  await store.saveAction(action);
  await audit({
    platformId: agent.platformId,
    actionId: action.id,
    kind: "action.confirmed",
    summary: action.verified ? "Re-read from chain." : "Submitted. Chain re-read did not confirm yet.",
    verified: action.verified,
    reported: !action.verified,
    detail: { signature: action.signature ?? "" },
  });
  return action;
}
