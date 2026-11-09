import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import bs58 from "bs58";
import { evaluatePolicy } from "../protocol";
import { agentMatchesCluster, hireCluster } from "./cluster";
import { actualBodyExceeds, contentLengthExceeds, hireConnection, rateLimit, resolveClientIp } from "./host";
import { canonicalPubkey, randomId, sha256Hex, verifyWalletSignature } from "./crypto";
import { AgentsError } from "./errors";
import {
  applyTurn,
  deliveryValue,
  expectation,
  fresh,
  futureDeadline,
  paymentMatches,
  priceUnits,
  proofKind,
  termsDigest,
  turnKind,
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  USDC_DEVNET,
  type Job,
  type JobProof,
} from "./jobs";
import { ownerCommandMessage, secretMaterial, sensitiveKey } from "./messages";
import { speakForAgent } from "./providers";
import { museTalkModel } from "./sandbox";
import { isSupervisor, supervisorPlatformId } from "./supervisor";
import { reputationForAgent, reputationForOwner, type ReputationCard } from "./reputation";
import { agentStore, type StoredAction, type StoredAgent } from "./store";
import { createOwnerOffer } from "./hire-offer";
import { answerOpenOffer } from "./offer-reply";
import { runAgentTurn } from "./agent/loop";
import { loadWorkspace } from "./agent/persist";
import { assertWorkspacePath } from "./workspace";
import { transport } from "./transport";
import {
  assertDepositLocked,
  buildReleaseTransaction,
  confirmCloseTransaction,
  confirmRefundTransaction,
  confirmSettledTransaction,
  prepareRefundStep,
  voucherMessage,
} from "./channel";
import {
  buildDepositTransaction,
  channelIdOf,
  channelRequirements,
  paymentRequiredHeader,
  paymentResponseHeader,
  readPaymentSignature,
  settleDeposit,
  x402Asset,
  x402Network,
} from "./x402";

const WINDOW_MS = 60_000;
const BODY_MAX = 64 * 1024;

type Caller = { role: "owner"; owner: string } | { role: "agent"; agent: StoredAgent };

function json(body: unknown, status = 200, extra?: Record<string, string>): NextResponse {
  const res = NextResponse.json(body, { status });
  if (extra) {
    for (const [key, value] of Object.entries(extra)) res.headers.set(key, value);
  }
  return res;
}

async function readBody(req: NextRequest, bucket: string, limit: number): Promise<Record<string, unknown>> {
  const ip = resolveClientIp(req.headers, process.env.NODE_ENV === "production");
  const gated = rateLimit(`${bucket}:${ip}`, limit, WINDOW_MS);
  if (!gated.ok) throw new AgentsError("RATE_LIMITED", "Too many requests. Retry shortly.", 429);
  if (contentLengthExceeds(req.headers.get("content-length"), BODY_MAX)) {
    throw new AgentsError("BODY_TOO_LARGE", "Request body is too large.", 413);
  }
  const text = await req.text();
  if (actualBodyExceeds(text, BODY_MAX)) throw new AgentsError("BODY_TOO_LARGE", "Request body is too large.", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentsError("INVALID_PARAMS", "JSON object required.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentsError("INVALID_PARAMS", "JSON object required.", 400);
  }
  const sensitive = sensitiveKey(parsed);
  if (sensitive) throw new AgentsError("SENSITIVE_FIELD", "Model keys, secrets, and prompts are not accepted.", 400);
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string, max = 200): string {
  const value = body[key];
  if (typeof value !== "string") throw new AgentsError("INVALID_PARAMS", `${key} is required.`, 400);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new AgentsError("INVALID_PARAMS", `${key} is invalid.`, 400);
  return trimmed;
}

function assertNoSecret(text: string): void {
  if (secretMaterial(text)) {
    throw new AgentsError("SENSITIVE_FIELD", "Message text looks like a credential or key. It was not stored.", 400);
  }
}

async function signedOwnerAgent(body: Record<string, unknown>, purpose: string, extra = ""): Promise<StoredAgent> {
  const platformId = stringField(body, "platformId", 80);
  const nonce = stringField(body, "nonce", 80);
  const signature = stringField(body, "signature", 200);
  const agent = await agentStore().getAgent(platformId);
  if (!agent) throw new AgentsError("NOT_FOUND", "Agent not found.", 404);
  if (agent.status === "removed") throw new AgentsError("REMOVED", "A removed agent stays removed.", 403);
  const message = ownerCommandMessage(purpose, platformId, nonce, extra);
  await agentStore().consumeNonce(nonce, purpose, agent.owner);
  if (!verifyWalletSignature(agent.owner, message, signature)) {
    throw new AgentsError("BAD_SIGNATURE", "Owner signature does not match this request.", 400);
  }
  return agent;
}

export function jobView(job: Job, viewerPlatformId?: string) {
  const released = Boolean(job.settlementSignature);
  const reveal = released || viewerPlatformId === job.sellerPlatformId;
  return {
    id: job.id,
    buyerPlatformId: job.buyerPlatformId,
    sellerPlatformId: job.sellerPlatformId,
    buyerOwner: job.buyerOwner,
    sellerOwner: job.sellerOwner,
    buyerWallet: job.buyerWallet,
    sellerWallet: job.sellerWallet,
    escrowWallet: job.escrowWallet,
    channelId: job.channelId,
    funded: Boolean(job.fundSignature),
    fundSignature: job.fundSignature,
    refundSignature: job.refundSignature,
    reviewReport: job.reviewReport,
    revisionNote: job.revisionNote,
    status: job.status,
    priceBaseUnits: job.priceBaseUnits,
    mint: job.mint,
    network: job.network,
    deadline: job.deadline,
    terms: job.terms,
    proof: job.proof,
    expectedProof: job.expectedProof,
    deliveryNote: reveal ? job.deliveryNote : "",
    deliveryProof: reveal ? job.deliveryProof : "",
    deliveryFiles: reveal ? job.deliveryFiles ?? [] : [],
    deliveryHistory: reveal ? job.deliveryHistory : [],
    approvalDigest: job.approvalDigest,
    settlementSignature: job.settlementSignature,
    refundReadyAt: job.refundReadyAt ?? 0,
    closeRequested: Boolean(job.closeSignature),
    workLog: (job.workLog ?? []).map((entry) => ({ at: entry.at, text: entry.text })),
    working: Boolean(job.working) && job.status === "accepted" && Boolean(job.fundSignature),
    rejectReason: job.rejectReason,
    termsDigest: termsDigest(job),
    sameOwner: job.buyerOwner === job.sellerOwner,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function deliveryOf(job: Job) {
  return { note: job.deliveryNote, proof: job.deliveryProof };
}

export async function agentReputation(platformId: string): Promise<ReputationCard | null> {
  try {
    const now = Date.now();
    const jobs = await agentStore().listJobsForAgent(platformId);
    return reputationForAgent(
      jobs.map((job) => fresh(job, now)),
      platformId
    );
  } catch {
    return null;
  }
}

export async function ownerReputation(owner: string): Promise<ReputationCard | null> {
  try {
    const now = Date.now();
    const jobs = await agentStore().listJobsForOwner(owner);
    return reputationForOwner(
      jobs.map((job) => fresh(job, now)),
      owner
    );
  } catch {
    return null;
  }
}

function configuredMint(): { mint: string; network: string } {
  const devnet = hireCluster() === "devnet";
  const mint = canonicalPubkey((devnet ? process.env.X402_DEVNET_ASSET?.trim() : "") || (devnet ? USDC_DEVNET : x402Asset()));
  const network = (devnet ? process.env.X402_DEVNET_NETWORK?.trim() : "") || (devnet ? SOLANA_DEVNET : x402Network());
  if (!mint || !/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(network)) {
    throw new AgentsError("FACILITATOR_UNCONFIGURED", "The USDC mint or Solana network is not configured.", 503);
  }
  return { mint, network };
}

function roleOf(job: Job, platformId: string): "buyer" | "seller" | null {
  if (platformId === job.buyerPlatformId) return "buyer";
  if (platformId === job.sellerPlatformId) return "seller";
  return null;
}

function canNegotiate(agent: StoredAgent, pendingOk: boolean): boolean {
  return agent.status === "active" || (pendingOk && agent.status === "pending_credential");
}

async function livePair(job: Job, pendingOk = false): Promise<{ buyer: StoredAgent; seller: StoredAgent }> {
  const buyer = await agentStore().getAgent(job.buyerPlatformId);
  const seller = await agentStore().getAgent(job.sellerPlatformId);
  if (!buyer || !seller) throw new AgentsError("NOT_FOUND", "Job agent not found.", 404);
  if (!canNegotiate(buyer, pendingOk) || !canNegotiate(seller, pendingOk)) {
    throw new AgentsError("PAUSED", "Both agents have to stay active to negotiate.", 403);
  }
  return { buyer, seller };
}

async function requireGrant(target: StoredAgent, caller: StoredAgent): Promise<void> {
  const grant = await agentStore().getGrant(target.platformId, caller.platformId);
  if (!grant?.allowed) throw new AgentsError("POLICY_DENIED", "The other agent has not granted this caller.", 403);
}

async function wake(from: StoredAgent, to: StoredAgent, jobId: string, kind: string): Promise<"sent" | "skipped"> {
  const sent = await transport().send({
    kind: "pointer",
    fromPlatformId: from.platformId,
    toPlatformId: to.platformId,
    messageId: randomId("msg"),
    jobId,
    turn: kind,
  });
  return sent.status;
}

async function audit(job: Job, kind: string, summary: string, verified = false): Promise<void> {
  const now = Date.now();
  for (const platformId of [job.buyerPlatformId, job.sellerPlatformId]) {
    await agentStore().saveAudit({
      id: randomId("aud"),
      platformId,
      actionId: null,
      kind,
      summary,
      verified,
      reported: true,
      detail: { jobId: job.id, status: job.status },
      createdAt: now,
    });
  }
}

/**
 * Appends one precise line to the job worker log shown on the hire page.
 * Consecutive duplicates are dropped so polling a waiting state does not
 * flood the timeline. The log never breaks the job flow.
 */
async function noteWork(id: string, text: string, working?: boolean): Promise<void> {
  try {
    await agentStore().updateJob(id, (current) => {
      if (!current) return { job: null, result: null };
      const line = text.slice(0, 400);
      const log = current.workLog ?? [];
      const workLog = log.at(-1)?.text === line ? log : [...log, { at: Date.now(), text: line }].slice(-24);
      const next: Job = {
        ...current,
        workLog,
        ...(working === undefined ? {} : { working }),
        updatedAt: Date.now(),
      };
      return { job: next, result: null };
    });
  } catch {
    // The worker log is best effort only.
  }
}

async function seen(caller: Caller, job: Job): Promise<boolean> {
  if (caller.role === "agent") return roleOf(job, caller.agent.platformId) != null;
  const buyer = await agentStore().getAgent(job.buyerPlatformId);
  const seller = await agentStore().getAgent(job.sellerPlatformId);
  return caller.owner === buyer?.owner || caller.owner === seller?.owner;
}

async function loadJob(id: string): Promise<Job> {
  const job = await agentStore().getJob(id);
  const jobCluster = job?.network === SOLANA_DEVNET ? "devnet" : job?.network === SOLANA_MAINNET ? "mainnet" : null;
  if (!job || (jobCluster != null && jobCluster !== hireCluster())) throw new AgentsError("NOT_FOUND", "Job not found.", 404);
  const now = Date.now();
  const stored = {
    ...job,
    channelId: job.channelId ?? "",
    depositPayload: job.depositPayload ?? "",
    settleTransaction: job.settleTransaction ?? "",
    settleKind: job.settleKind ?? "",
    settleSigned: job.settleSigned ?? false,
    settleVoucherMessage: job.settleVoucherMessage ?? "",
    settleVoucherSignature: job.settleVoucherSignature ?? "",
    closeSignature: job.closeSignature ?? "",
    refundReadyAt: job.refundReadyAt ?? 0,
    workLog: job.workLog ?? [],
    working: job.working ?? false,
    reviewReport: job.reviewReport ?? "",
    revisionNote: job.revisionNote ?? "",
  };
  const next = fresh(stored, now);
  if (next.status !== job.status) await agentStore().saveJob(next);
  return next;
}

async function assertDeliveryProof(job: Job): Promise<void> {
  if (job.proof === "subjective") return;
  if (!job.deliveryProof) throw new AgentsError("PROOF_MISMATCH", "The delivery has no proof.", 409);
  if (job.proof === "hash") {
    if (job.deliveryProof !== job.expectedProof) {
      throw new AgentsError("PROOF_MISMATCH", "The delivery hash does not match the offer.", 409);
    }
    return;
  }
  if (job.expectedProof && job.deliveryProof !== job.expectedProof) {
    throw new AgentsError("PROOF_MISMATCH", "The delivery signature does not match the offer.", 409);
  }
  let landed = false;
  try {
    const tx = await hireConnection().getTransaction(job.deliveryProof, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    landed = Boolean(tx && !tx.meta?.err);
  } catch {
    landed = false;
  }
  if (!landed) throw new AgentsError("PROOF_MISMATCH", "The delivery signature has not landed.", 409);
}

async function proofStatus(job: Job): Promise<{ proofReady: boolean; proofError: string }> {
  if (job.status !== "delivered") return { proofReady: job.status === "settled", proofError: "" };
  try {
    await assertDeliveryProof(job);
    return { proofReady: true, proofError: "" };
  } catch (error) {
    return {
      proofReady: false,
      proofError: error instanceof AgentsError ? error.message : "The delivery proof did not match.",
    };
  }
}

async function assertPayPolicy(buyer: StoredAgent, job: Job): Promise<void> {
  const usage = await agentStore().readUsage(buyer.platformId);
  const decision = evaluatePolicy(await agentStore().getPolicy(buyer.platformId), {
    action: "pay",
    programIds: [],
    amountLamports: job.priceBaseUnits,
    recipient: job.sellerWallet,
    recipients: [job.sellerWallet],
    mint: job.mint,
    authorityChange: false,
    payment: true,
    paused: buyer.status === "paused" || buyer.status === "removed",
    spentTodayLamports: usage.spentTodayLamports,
    actionsLastMinute: usage.actionsLastMinute,
  });
  if (!decision.allow || decision.signer !== "owner") {
    throw new AgentsError("POLICY_DENIED", decision.reason, 403);
  }
}

async function recordSettlement(buyer: StoredAgent, job: Job, signature: string, payloadHash: string): Promise<void> {
  const now = Date.now();
  const action: StoredAction = {
    id: `job_${job.id}`,
    platformId: buyer.platformId,
    name: "pay",
    status: "confirmed",
    risk: "high",
    signer: "owner",
    payloadHash,
    unsignedTransactions: [],
    request: {
      recipient: job.sellerWallet,
      mint: job.mint,
      amountLamports: job.priceBaseUnits,
      payment: "true",
      jobId: job.id,
    },
    amountLamports: job.priceBaseUnits,
    simulationPassed: false,
    idempotencyKey: `job:${job.id}`,
    launchNonce: null,
    launchMint: null,
    launchStep: null,
    confirmedSteps: 0,
    lookupTables: [],
    signature,
    verified: true,
    createdAt: now,
    expiresAt: now,
  };
  await agentStore().reserveAction(action);
}

async function settleFund(job: Job, header: string, ownerSigned = false): Promise<NextResponse> {
  const payTo = job.sellerWallet;
  const payload = readPaymentSignature(header);
  if (payload.resource?.url && !payload.resource.url.includes(`/jobs/${job.id}`)) {
    throw new AgentsError("PAYMENT_INVALID", "The payment is for a different job.", 402);
  }
  if (!paymentMatches(payload.accepted, job, payTo)) {
    throw new AgentsError("PAYMENT_INVALID", "The payment does not match the locked price, mint, network, or seller wallet.", 402);
  }
  const feePayer = canonicalPubkey(payload.accepted.extra?.feePayer);
  if (feePayer !== job.buyerOwner) {
    throw new AgentsError("PAYMENT_INVALID", "The buyer owner has to sign this channel.", 402);
  }
  const { buyer } = await livePair(job, true);
  if (!ownerSigned) await assertPayPolicy(buyer, job);
  const payloadHash = sha256Hex(header);
  let failure: AgentsError | null = null;
  const reserved = await agentStore().updateJob(job.id, (current) => {
    if (!current || current.status !== "accepted") {
      failure = new AgentsError("JOB_LOCKED", "Payment waits for an accepted offer.", 409);
      return { job: current, result: null as Job | null };
    }
    if (current.fundSignature) {
      failure = new AgentsError("SETTLEMENT_EXISTS", "This payment is already settled.", 409);
      return { job: current, result: null };
    }
    if (current.fundPayloadHash && current.fundPayloadHash !== payloadHash) {
      failure = new AgentsError("SETTLEMENT_EXISTS", "A different payment is already in progress.", 409);
      return { job: current, result: null };
    }
    return { job: { ...current, fundPayloadHash: payloadHash, updatedAt: Date.now() }, result: current };
  });
  if (failure || !reserved) throw failure ?? new AgentsError("JOB_LOCKED", "Payment waits for an accepted offer.", 409);
  try {
    const settled = await settleDeposit(reserved, payload);
    const channelId = channelIdOf(payload);
    const depositPayload = JSON.stringify(payload);
    if (depositPayload.length > 20_000) {
      throw new AgentsError("PAYMENT_INVALID", "The channel deposit is too large to store.", 402);
    }
    const done = await agentStore().updateJob(job.id, (current) => {
      if (!current) throw new AgentsError("NOT_FOUND", "Job not found.", 404);
      if (current.fundSignature && current.fundSignature !== settled.transaction) {
        throw new AgentsError("SETTLEMENT_EXISTS", "This payment is already settled.", 409);
      }
      const next: Job = {
        ...current,
        fundSignature: settled.transaction,
        fundPayloadHash: payloadHash,
        channelId,
        escrowWallet: channelId,
        depositPayload,
        approvalDigest: termsDigest(current),
        updatedAt: Date.now(),
      };
      return { job: next, result: next };
    });
    try {
      await recordSettlement(buyer, done, settled.transaction, payloadHash);
    } catch (error) {
      console.error("[agents] settlement spend", error instanceof Error ? error.name : "error");
    }
    await audit(done, "job.funded", "Buyer deposited the price in the x402 channel.", true);
    await noteWork(done.id, "The deposit is locked. The worker can start.");
    void workHiredDelivery(done);
    return json({ job: jobView(done) }, 200, { "PAYMENT-RESPONSE": paymentResponseHeader(settled) });
  } catch (error) {
    await agentStore()
      .updateJob(job.id, (current) => {
        if (!current || current.fundSignature || current.fundPayloadHash !== payloadHash) return { job: current, result: null };
        return { job: { ...current, fundPayloadHash: "", updatedAt: Date.now() }, result: null };
      })
      .catch(() => undefined);
    throw error;
  }
}

function storedDeposit(job: Job): PaymentPayload {
  if (!job.depositPayload) {
    throw new AgentsError("FACILITATOR_UNCONFIGURED", "The channel deposit is not stored. The payment was not settled.", 503);
  }
  try {
    return JSON.parse(job.depositPayload) as PaymentPayload;
  } catch {
    throw new AgentsError("FACILITATOR_UNCONFIGURED", "The channel deposit is not stored. The payment was not settled.", 503);
  }
}

function storedOpen(job: Job): boolean {
  if (!job.depositPayload) return false;
  try {
    const parsed = JSON.parse(job.depositPayload) as { payload?: { openTransaction?: unknown } };
    const open = parsed.payload?.openTransaction;
    return typeof open === "string" && open.length >= 80;
  } catch {
    return false;
  }
}

function requireOpenDeposit(job: Job): void {
  const stored = storedDeposit(job);
  const open = (stored.payload as { openTransaction?: unknown }).openTransaction;
  if (typeof open !== "string" || open.length < 80 || !canonicalPubkey(job.channelId)) {
    throw new AgentsError("PAYMENT_INVALID", "The channel deposit is not on chain.", 402);
  }
}

async function reviewDelivery(job: Job): Promise<Job> {
  const supervisorId = supervisorPlatformId();
  if (!job.deliveryNote) return job;
  if (!supervisorId) {
    await noteWork(job.id, "The supervisor review is waiting: no supervisor agent is configured.");
    return job;
  }
  let supervisor: Awaited<ReturnType<ReturnType<typeof agentStore>["getAgent"]>>;
  try {
    supervisor = await agentStore().getAgent(supervisorId);
  } catch {
    supervisor = null;
  }
  if (!supervisor) {
    await noteWork(job.id, "The supervisor review is waiting: the supervisor agent was not found. Check HIRE_SUPERVISOR_PLATFORM_ID.");
    return job;
  }
  // The review speaks with the supervisor owner's connected model, so the
  // agent only has to be enrolled and not stopped. A freshly created agent
  // still waiting for its runtime claim (pending_credential) can review, the
  // same state the rest of hire treats as usable.
  if (supervisor.status !== "active" && supervisor.status !== "pending_credential") {
    await noteWork(job.id, `The supervisor review is waiting: the supervisor agent is ${supervisor.status}.`);
    return job;
  }
  const reviewInstructions =
    "You review one hired delivery. Say whether it matches the terms, in one short paragraph. When a file is attached, say what the file is. When an image is attached, say what the image shows, then say whether that matches the terms. Do not paste the file body. Leave out keys, seeds, wallet secrets, and provider credentials. If those appear in the delivery, say they were omitted. If an image link is present but no image is attached, say the image could not be viewed.";
  const fileEvidence = (job.deliveryFiles ?? []).map((file) => {
    const image = /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(file.content);
    if (image) {
      return `${file.path}\n[image file: ${image[1]}, about ${Math.max(1, Math.round(file.content.length / 1024))} KB, attached for review]`;
    }
    return `${file.path}\n${file.content.slice(0, 800)}`;
  });
  const reviewImages = (job.deliveryFiles ?? [])
    .map((file) => file.content)
    .filter((content) => /^data:image\/(?:png|jpeg|webp|gif);base64,/.test(content));
  const reviewText = `Terms:\n${job.terms}\n\nDelivery:\n${job.deliveryNote}\n\nFiles:\n${fileEvidence.join("\n\n").slice(0, 4000)}`;
  try {
    let spoken: Awaited<ReturnType<typeof speakForAgent>>;
    try {
      spoken = await speakForAgent(supervisor, reviewText, reviewInstructions, reviewImages);
    } catch (firstError) {
      // A delivery that is an image link gets attached to the review call as
      // an image, and the provider can refuse to fetch it. Review the link
      // as text instead, which the instructions already cover.
      const plainText = reviewText.replace(/https:\/\/[^\s]+/g, "(image link)");
      if (plainText === reviewText) throw firstError;
      spoken = await speakForAgent(supervisor, plainText, reviewInstructions);
    }
    const compact = spoken.text.replace(/\s+/g, " ").trim().slice(0, 500);
    const report = !compact || secretMaterial(compact) ? "The review omitted sensitive text." : compact;
    const reviewed = await agentStore().updateJob(job.id, (current) => {
      if (!current || current.status !== "delivered" || current.deliveryNote !== job.deliveryNote) {
        return { job: current, result: current };
      }
      const next = { ...current, reviewReport: report, updatedAt: Date.now() };
      return { job: next, result: next };
    });
    const done = reviewed ?? job;
    if (done.reviewReport === report) {
      await noteWork(job.id, "The supervisor reviewed the delivery.");
    }
    return done;
  } catch (error) {
    console.error("[agents] supervisor", error instanceof Error ? error.name : "error");
    const detail = error instanceof Error ? error.message.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    await noteWork(
      job.id,
      detail && !secretMaterial(detail)
        ? `The supervisor review is waiting: ${detail} It retries while this page is open.`
        : "The supervisor review is waiting: the supervisor model did not answer. It retries while this page is open."
    );
    return job;
  }
}

async function offer(caller: Caller, body: Record<string, unknown>): Promise<NextResponse> {
  if (caller.role !== "agent") throw new AgentsError("UNAUTHORIZED", "An agent credential is required.", 401);
  const buyer = await agentStore().getAgent(caller.agent.platformId);
  if (!buyer || buyer.status !== "active") throw new AgentsError("PAUSED", "A paused agent cannot negotiate.", 403);
  const seller = await agentStore().getAgent(stringField(body, "toPlatformId", 80));
  if (!seller || seller.status !== "active" || !agentMatchesCluster(buyer) || !agentMatchesCluster(seller)) {
    throw new AgentsError("NOT_FOUND", "Target agent is not active.", 404);
  }
  if (seller.platformId === buyer.platformId) {
    throw new AgentsError("INVALID_PARAMS", "An agent cannot hire itself.", 400);
  }
  if (isSupervisor(seller.platformId)) {
    throw new AgentsError("INVALID_PARAMS", "The supervisor reviews deliveries. It is not hired.", 400);
  }
  if (!canonicalPubkey(buyer.walletAddress) || !canonicalPubkey(seller.walletAddress)) {
    throw new AgentsError("NOT_READY", "Both agent wallets must be canonical Solana addresses.", 400);
  }
  await requireGrant(seller, buyer);
  const proof = proofKind(body.proof);
  const opened = await createOwnerOffer({
    buyer,
    seller,
    priceBaseUnits: priceUnits(body.priceBaseUnits),
    deadline: futureDeadline(body.deadline, Date.now()),
    terms: stringField(body, "terms", 280),
    proof,
    expectedProof: typeof body.expectedProof === "string" ? body.expectedProof : "",
  });
  return json({ job: jobView(opened.job), wake: opened.wake });
}

function termsFrom(body: Record<string, unknown>, now: number): {
  priceBaseUnits: string;
  deadline: number;
  terms: string;
  proof: JobProof;
  expectedProof: string;
} {
  const proof = proofKind(body.proof);
  const terms = stringField(body, "terms", 280);
  assertNoSecret(terms);
  return {
    priceBaseUnits: priceUnits(body.priceBaseUnits),
    deadline: futureDeadline(body.deadline, now),
    terms,
    proof,
    expectedProof: expectation(proof, body.expectedProof),
  };
}

async function turn(caller: Caller, id: string, body: Record<string, unknown>): Promise<NextResponse> {
  const kind = turnKind(body.kind);
  const existing = await loadJob(id);
  let sender: StoredAgent;
  let ownerTurn = false;
  if (caller.role === "agent") {
    const loaded = await agentStore().getAgent(caller.agent.platformId);
    if (!loaded || loaded.status !== "active") throw new AgentsError("PAUSED", "A paused agent cannot negotiate.", 403);
    sender = loaded;
  } else {
    if (kind !== "accept" && kind !== "decline") {
      throw new AgentsError("UNAUTHORIZED", "An agent credential is required.", 401);
    }
    if (caller.owner !== existing.sellerOwner) {
      throw new AgentsError("FORBIDDEN", "The hired agent's owner accepts or declines the offer.", 403);
    }
    const loaded = await agentStore().getAgent(existing.sellerPlatformId);
    if (!loaded || !canNegotiate(loaded, true)) throw new AgentsError("PAUSED", "A paused agent cannot negotiate.", 403);
    sender = loaded;
    ownerTurn = true;
  }
  const side = roleOf(existing, sender.platformId);
  if (!side) throw new AgentsError("NOT_FOUND", "Job not found.", 404);
  const { buyer, seller } = await livePair(existing, ownerTurn);
  const self = side === "buyer" ? buyer : seller;
  const other = side === "buyer" ? seller : buyer;
  if (!ownerTurn) await requireGrant(other, self);
  if (kind === "deliver" && side !== "seller") {
    throw new AgentsError("FORBIDDEN", "The seller delivers the job.", 403);
  }
  if (kind === "deliver" && storedOpen(existing)) await assertDepositLocked(existing);
  if ((kind === "reject" || kind === "revise") && side !== "buyer") {
    throw new AgentsError("FORBIDDEN", "The buyer answers the delivery.", 403);
  }
  if (
    kind === "reject" &&
    existing.status === "delivered" &&
    existing.fundSignature &&
    !existing.settlementSignature &&
    !existing.refundSignature
  ) {
    storedDeposit(existing);
  }
  const now = Date.now();
  let failure: AgentsError | null = null;
  const next = await agentStore().updateJob(id, (current) => {
    if (!current) {
      failure = new AgentsError("NOT_FOUND", "Job not found.", 404);
      return { job: null, result: null as Job | null };
    }
    try {
      const live = fresh(current, now);
      const updated = applyParsed(live, kind, body, buyer, seller, now);
      return { job: updated, result: updated };
    } catch (error) {
      failure = error instanceof AgentsError ? error : new AgentsError("INVALID_PARAMS", "Job update failed.", 400);
      const live = fresh(current, now);
      return { job: live.status === current.status ? current : live, result: null };
    }
  });
  if (failure || !next) throw failure ?? new AgentsError("INVALID_PARAMS", "Job update failed.", 400);
  if (kind === "deliver") await noteWork(next.id, "The hired agent delivered.", false);
  const reviewed = kind === "deliver" ? await reviewDelivery(next) : next;
  if (kind === "revise") void workHiredDelivery(reviewed);
  const sent = await wake(self, other, reviewed.id, kind);
  await audit(
    reviewed,
    `job.${kind}`,
    "Negotiation turn stored."
  );
  return json({ job: jobView(reviewed, sender.platformId), wake: sent });
}

function deliveryFilesFrom(value: unknown): { path: string; content: string }[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new AgentsError("INVALID_PARAMS", "A delivery can include at most 8 files.", 400);
  }
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new AgentsError("INVALID_PARAMS", "A delivery file is invalid.", 400);
    const row = item as { path?: unknown; content?: unknown };
    if (typeof row.path !== "string" || typeof row.content !== "string") {
      throw new AgentsError("INVALID_PARAMS", "A delivery file is invalid.", 400);
    }
    const image = /^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=\s]+$/.exec(row.content);
    if (image) {
      const expectedExt = image[1] === "jpeg" ? "jpg" : image[1];
      const pathOk =
        /^projects\/[a-z0-9][a-z0-9-]{0,31}\/[a-z0-9][a-z0-9._-]{0,64}$/i.test(row.path) &&
        row.path.toLowerCase().endsWith(`.${expectedExt}`) &&
        !row.path.includes("..");
      if (!pathOk || row.content.length > IMAGE_DELIVERY_MAX_CHARS) {
        throw new AgentsError("INVALID_PARAMS", "A delivery image file is invalid or too large.", 400);
      }
      return { path: row.path, content: row.content.replace(/\s/g, "") };
    }
    const path = assertWorkspacePath(row.path);
    if (!path.startsWith("projects/") || row.content.length > 16_000) {
      throw new AgentsError("INVALID_PARAMS", "A delivery file must be a project file.", 400);
    }
    assertNoSecret(row.content);
    return { path, content: row.content };
  });
}

function hireFolder(job: Job): string {
  const slug = job.id.replace(/[^a-z0-9]+/gi, "").slice(-24).toLowerCase();
  return `projects/hire-${slug || "job"}`;
}

const IMAGE_DELIVERY_MAX_BYTES = 600_000;
const IMAGE_DELIVERY_MAX_CHARS = 850_000;

type ImageDeliveryFile = { path: string; content: string; bytes: number; mime: string };

function imageKind(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)).startsWith("GIF8")) {
    return { mime: "image/gif", ext: "gif" };
  }
  return null;
}

/** Downloads a model-generated image once and stores its bytes as the actual delivery file. */
async function fetchImageDeliveryFile(rawUrl: string, folder: string): Promise<ImageDeliveryFile | null> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  try {
    let response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    for (let hop = 0; response.status >= 300 && response.status < 400 && hop < 3; hop += 1) {
      const location = response.headers.get("location");
      if (!location) return null;
      const next = new URL(location, url);
      if (next.protocol !== "https:" || next.username || next.password) return null;
      url = next;
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    }
    if (!response.ok || !response.body) return null;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > IMAGE_DELIVERY_MAX_BYTES) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > IMAGE_DELIVERY_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const kind = imageKind(bytes);
    if (!kind) return null;
    const content = `data:${kind.mime};base64,${Buffer.from(bytes).toString("base64")}`;
    if (content.length > IMAGE_DELIVERY_MAX_CHARS) return null;
    return { path: `${folder}/logo.${kind.ext}`, content, bytes: total, mime: kind.mime };
  } catch {
    return null;
  }
}

async function workHiredDelivery(job: Job): Promise<void> {
  try {
    // Re-read before starting: never run a second fresh pass over one that is
    // already writing steps, and never work a job that moved on.
    const live = await loadJob(job.id);
    if (!live || live.status !== "accepted" || !live.fundSignature) return;
    if (live.working && Date.now() - (live.workLog?.at(-1)?.at ?? 0) <= 5 * 60_000) return;
    job = live;
    if (job.proof === "signature") {
      await noteWork(job.id, "The hired agent delivers from its own runtime. Waiting for its delivery.");
      return;
    }
    const seller = await agentStore().getAgent(job.sellerPlatformId);
    if (!seller || (seller.status !== "active" && seller.status !== "pending_credential") || isSupervisor(seller.platformId)) {
      await noteWork(job.id, "The worker did not start: the hired agent is not active.");
      return;
    }
    const folder = hireFolder(job);
    await noteWork(job.id, "The worker started. The delivery stays sealed until you confirm.", true);
    const spoken = await runAgentTurn(
      seller,
      `Hired job ${job.id}. Terms:\n${job.terms}${job.revisionNote ? `\n\nThe buyer sent the last delivery back with this note:\n${job.revisionNote}\nChange the work so it answers this note.` : ""}\n\nDo this work with your tools. Save every file with workspace_write under ${folder}/. A web page is ${folder}/index.html and must be the complete HTML. Write the file, then stop.`,
      "task",
      false,
      (line) => noteWork(job.id, line)
    );
    // A specialty Muse model returns its result directly. That result is
    // the delivery for a subjective job, and it wins over any files an
    // earlier pass left in the job folder.
    const directResult =
      job.proof === "subjective" && spoken.run.provider === "muse" && museTalkModel(spoken.run.modelId)
        ? spoken.text.trim().slice(0, 280)
        : "";
    if (directResult && directResult !== "The agent did not finish.") {
      // Muse Image returns a hosted link, not a file. Download it once and
      // seal the actual bytes as the delivery file; an expiring link alone
      // is not a website-ready file and the supervisor cannot rely on it.
      if (spoken.run.modelId === "muse-image-1.0") {
        await noteWork(job.id, "Packaging the generated image as a delivery file.");
        const image = await fetchImageDeliveryFile(directResult, folder);
        if (!image) {
          await noteWork(job.id, "The worker stopped: the generated image could not be packaged as a file.", false);
          return;
        }
        const name = image.path.split("/").at(-1) ?? "logo.png";
        const updated = await agentStore().updateJob(job.id, (current) => {
          if (!current || current.status !== "accepted" || !current.fundSignature) return { job: current, result: null };
          try {
            const next = applyTurn(
              current,
              { kind: "deliver", note: `Delivered ${name}.`, deliveryProof: "", files: [{ path: image.path, content: image.content }] },
              Date.now()
            );
            return { job: next, result: next };
          } catch {
            return { job: current, result: null };
          }
        });
        if (updated) {
          await noteWork(updated.id, `Saved ${name} (${Math.max(1, Math.round(image.bytes / 1024))} KB) as the delivery file.`, false);
          await noteWork(updated.id, "The delivery is sealed.", false);
          await reviewDelivery(updated);
          return;
        }
      }
      const deliveredAt = Date.now();
      const updated = await agentStore().updateJob(job.id, (current) => {
        if (!current || current.status !== "accepted" || !current.fundSignature) return { job: current, result: null };
        try {
          const next = applyTurn(current, { kind: "deliver", note: directResult, deliveryProof: "", files: [] }, deliveredAt);
          return { job: next, result: next };
        } catch {
          return { job: current, result: null };
        }
      });
      if (updated) {
        await noteWork(updated.id, "The delivery is sealed.", false);
        await reviewDelivery(updated);
        return;
      }
    }
    const workspace = await loadWorkspace(seller.platformId, seller.name);
    const files = Object.entries(workspace.files)
      .filter(([path]) => path.startsWith(`${folder}/`))
      .slice(0, 8)
      .map(([path, file]) => ({ path, content: file.content.slice(0, 16_000) }))
      .filter((file) => !secretMaterial(file.content));
    if (!files.length) {
      await noteWork(job.id, "The worker finished without saving a file.", false);
      return;
    }
    const proof =
      job.proof === "hash"
        ? sha256Hex(files.map((file) => `${file.path}\n${file.content}`).join("\n"))
        : "";
    if (job.proof === "hash" && job.expectedProof && job.expectedProof !== proof) {
      await noteWork(job.id, "The worker delivery did not match the expected hash.", false);
      return;
    }
    await noteWork(job.id, `The worker saved ${files.length} ${files.length === 1 ? "file" : "files"}: ${files.map((file) => file.path).join(", ")}.`);
    const note = `Delivered ${files.map((file) => file.path).join(", ")}`.slice(0, 280);
    const now = Date.now();
    const updated = await agentStore().updateJob(job.id, (current) => {
      if (!current || current.status !== "accepted" || !current.fundSignature) return { job: current, result: null };
      try {
        const next = applyTurn(current, { kind: "deliver", note, deliveryProof: proof, files }, now);
        return { job: next, result: next };
      } catch {
        return { job: current, result: null };
      }
    });
    if (updated) {
      await noteWork(updated.id, "The delivery is sealed.", false);
      await reviewDelivery(updated);
    } else {
      await noteWork(job.id, "The worker finished.", false);
    }
  } catch (error) {
    console.error("[agents] hired work", error instanceof Error ? error.name : "error");
    await noteWork(job.id, `The worker stopped: ${error instanceof Error ? error.message.slice(0, 240) : "The work did not finish."}`, false);
  }
}

function applyParsed(
  job: Job,
  kind: ReturnType<typeof turnKind>,
  body: Record<string, unknown>,
  buyer: StoredAgent,
  seller: StoredAgent,
  now: number
): Job {
  if (kind === "counter") return applyTurn(job, { kind, ...termsFrom(body, now) }, now);
  if (kind === "accept") {
    if (body.priceBaseUnits != null || body.terms != null || body.deadline != null) {
      throw new AgentsError("JOB_LOCKED", "Accept freezes the current terms. A new price is a new job.", 409);
    }
    if (!canonicalPubkey(buyer.walletAddress) || !canonicalPubkey(seller.walletAddress)) {
      throw new AgentsError("NOT_READY", "Both agent wallets must be canonical Solana addresses.", 400);
    }
    return applyTurn(job, { kind, buyerWallet: buyer.walletAddress, sellerWallet: seller.walletAddress }, now);
  }
  if (kind === "decline") return applyTurn(job, { kind }, now);
  if (kind === "progress") {
    if (typeof body.note === "string" && body.note.trim()) {
      const note = body.note.trim();
      if (note.length > 280) throw new AgentsError("INVALID_PARAMS", "note is invalid.", 400);
      assertNoSecret(note);
    }
    return applyTurn(job, { kind }, now);
  }
  if (kind === "deliver") {
    const note = stringField(body, "note", 280);
    assertNoSecret(note);
    return applyTurn(job, { kind, note, deliveryProof: deliveryValue(job.proof, body.deliveryProof), files: deliveryFilesFrom(body.files) }, now);
  }
  if (kind === "revise") {
    const note = stringField(body, "note", 280);
    assertNoSecret(note);
    return applyTurn(job, { kind, note }, now);
  }
  const reason = stringField(body, "reason", 280);
  assertNoSecret(reason);
  return applyTurn(job, { kind: "reject", reason }, now);
}

function viewerPlatformId(caller: Caller, job: Job): string {
  if (caller.role === "agent") return caller.agent.platformId;
  return caller.owner === job.sellerOwner ? job.sellerPlatformId : job.buyerPlatformId;
}

const imageRepairAttempts = new Set<string>();

/**
 * Repairs a platform-generated image delivery that was sealed as only a
 * hosted link: packages the actual image bytes as the delivery file and
 * clears the review that was written against the link-only delivery.
 */
async function repairImageDelivery(job: Job): Promise<Job> {
  if (
    job.status !== "delivered" ||
    !job.fundSignature ||
    job.proof !== "subjective" ||
    (job.deliveryFiles ?? []).length > 0 ||
    !(job.workLog ?? []).some((entry) => entry.text.includes("returned its result"))
  ) {
    return job;
  }
  const rawUrl = job.deliveryNote.trim();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return job;
  }
  if (rawUrl.includes(" ") || !/\.(png|jpe?g|webp|gif)$/i.test(parsed.pathname)) return job;
  const attemptKey = `${job.id}:${rawUrl}`;
  if (imageRepairAttempts.has(attemptKey)) return job;
  imageRepairAttempts.add(attemptKey);
  const image = await fetchImageDeliveryFile(rawUrl, hireFolder(job));
  if (!image) return job;
  const name = image.path.split("/").at(-1) ?? "logo.png";
  const updated = await agentStore().updateJob(job.id, (current) => {
    if (
      !current ||
      current.status !== "delivered" ||
      current.deliveryNote !== job.deliveryNote ||
      (current.deliveryFiles ?? []).length > 0
    ) {
      return { job: current, result: null as Job | null };
    }
    const next: Job = {
      ...current,
      deliveryNote: `Delivered ${name}.`,
      deliveryFiles: [{ path: image.path, content: image.content }],
      reviewReport: "",
      updatedAt: Date.now(),
    };
    return { job: next, result: next };
  });
  if (!updated) return job;
  await noteWork(updated.id, `The generated image was packaged as ${name}.`);
  return updated;
}

async function readOne(req: NextRequest, caller: Caller, id: string): Promise<NextResponse> {
  let job = await loadJob(id);
  if (!(await seen(caller, job))) throw new AgentsError("NOT_FOUND", "Job not found.", 404);
  if (job.status === "offered") job = (await answerOpenOffer(job)).job;
  if (job.status === "delivered" && job.fundSignature) {
    job = await repairImageDelivery(job);
  }
  // The supervisor review runs on its own: any read of a delivered, funded,
  // unreviewed job runs it (and retries it) instead of waiting for a person.
  if (job.status === "delivered" && job.fundSignature && !job.reviewReport && job.deliveryNote) {
    job = await reviewDelivery(job);
  }
  // Resume the worker on read: a funded, accepted job with no delivery must
  // always have a pass running. This heals passes that never started (for
  // example a revision sent before the worker restart existed, or a server
  // restart mid-pass) and passes that went quiet.
  if (job.status === "accepted" && job.fundSignature && !job.settlementSignature) {
    const lastAt = job.workLog?.at(-1)?.at ?? 0;
    const stale = Boolean(job.working) && Date.now() - lastAt > 5 * 60_000;
    if (!job.working || stale) {
      if (stale) await noteWork(job.id, "The last pass went quiet. The worker is starting again.", false);
      void workHiredDelivery(job);
    }
  }
  const header = req.headers.get("payment-signature");
  const viewer = viewerPlatformId(caller, job);
  const buyerCaller =
    (caller.role === "agent" && caller.agent.platformId === job.buyerPlatformId) ||
    (caller.role === "owner" && caller.owner === job.buyerOwner);
  if (job.settlementSignature) {
    if (header) throw new AgentsError("SETTLEMENT_EXISTS", "This job is already settled.", 409);
    return json({ job: jobView(job, viewer), delivery: deliveryOf(job) });
  }
  if (buyerCaller && job.status === "accepted" && !job.fundSignature) {
    if (header) return settleFund(job, header, caller.role === "owner");
    const requirements = await channelRequirements(job);
    const resource = `${req.nextUrl.origin}/api/agents/v1/jobs/${job.id}/escrow`;
    return json(
      { error: { code: "PAYMENT_REQUIRED", message: "Deposit the price into the x402 channel before delivery." }, job: jobView(job, viewer) },
      402,
      { "PAYMENT-REQUIRED": paymentRequiredHeader(requirements, resource, "Open the hire channel") }
    );
  }
  if (buyerCaller && job.status === "delivered") {
    if (!job.fundSignature) {
      throw new AgentsError("JOB_LOCKED", "Delivery waits until the channel deposit settles.", 409);
    }
    await assertDeliveryProof(job);
    if (header) {
      throw new AgentsError("SETTLEMENT_EXISTS", "The price is already in the channel. This delivery does not take a second payment.", 409);
    }
    return json({ job: jobView(job, viewer) });
  }
  const proof = await proofStatus(job);
  return json({
    job: jobView(job, viewer),
    ...proof,
    payment: job.fundSignature
      ? {
          scheme: "upto" as const,
          network: job.network,
          amount: job.priceBaseUnits,
          asset: job.mint,
          payTo: job.sellerWallet,
          digest: termsDigest(job),
        }
      : null,
    paymentError: "",
  });
}

function optionalText(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.length > max) {
    throw new AgentsError("INVALID_PARAMS", `${key} is invalid.`, 400);
  }
  return value;
}

function buyerCaller(caller: Caller, job: Job): boolean {
  return (
    (caller.role === "agent" && caller.agent.platformId === job.buyerPlatformId) ||
    (caller.role === "owner" && caller.owner === job.buyerOwner)
  );
}

async function approve(req: NextRequest, id: string): Promise<NextResponse> {
  const body = await readBody(req, "agents-job-approve", 20);
  const job = await loadJob(id);
  if (job.status !== "delivered") throw new AgentsError("JOB_LOCKED", "Approval waits for a delivery.", 409);
  if (!job.reviewReport) throw new AgentsError("JOB_LOCKED", "The supervisor has not reported on this delivery.", 409);
  if (job.settlementSignature) throw new AgentsError("SETTLEMENT_EXISTS", "This job is already settled.", 409);
  await assertDeliveryProof(job);
  const digest = termsDigest(job);
  const agent = await signedOwnerAgent(body, "approve-job", `job ${job.id} ${digest}`);
  if (agent.platformId !== job.buyerPlatformId || agent.owner !== job.buyerOwner) {
    throw new AgentsError("FORBIDDEN", "The buyer owner approves this payment.", 403);
  }
  requireOpenDeposit(job);
  const messageText = optionalText(body, "voucherMessage", 120);
  const signatureText = optionalText(body, "voucherSignature", 120);
  if (!messageText && !signatureText) {
    const message = voucherMessage(job.channelId, BigInt(job.priceBaseUnits), BigInt(Math.floor(Date.now() / 1000) + 3600));
    return json({ job: jobView(job, job.buyerPlatformId), voucher: { message: Buffer.from(message).toString("base64") } });
  }
  if (!messageText || !signatureText) throw new AgentsError("INVALID_PARAMS", "The release voucher is incomplete.", 400);
  let signature: Uint8Array;
  try {
    signature = bs58.decode(signatureText);
  } catch {
    throw new AgentsError("PAYMENT_INVALID", "The release voucher signature is invalid.", 402);
  }
  const prepared = await buildReleaseTransaction(job, BigInt(job.priceBaseUnits), {
    message: new Uint8Array(Buffer.from(messageText, "base64")),
    signature,
  });
  await audit(job, "job.approve", "Buyer signed the release. The owner wallet sends it and the channel pays the seller.");
  await noteWork(job.id, "The buyer signed the release.");
  return json({ job: jobView(job, job.buyerPlatformId), ...prepared });
}

async function ownerReject(req: NextRequest, id: string): Promise<NextResponse> {
  const body = await readBody(req, "agents-job-reject", 20);
  const reason = stringField(body, "reason", 280);
  assertNoSecret(reason);
  const job = await loadJob(id);
  const agent = await signedOwnerAgent(body, "reject-job", `job ${id}\nreason: ${reason}`);
  if (agent.platformId !== job.buyerPlatformId || agent.owner !== job.buyerOwner) {
    throw new AgentsError("FORBIDDEN", "The buyer owner rejects this delivery.", 403);
  }
  if (job.status !== "delivered") throw new AgentsError("JOB_LOCKED", "Only a delivery can be rejected.", 409);
  const funded = Boolean(job.fundSignature) && !job.settlementSignature && !job.refundSignature;
  if (funded) requireOpenDeposit(job);
  let failure: AgentsError | null = null;
  const saved = await agentStore().updateJob(id, (current) => {
    if (!current) {
      failure = new AgentsError("NOT_FOUND", "Job not found.", 404);
      return { job: null, result: null as Job | null };
    }
    try {
      const rejected = applyTurn(fresh(current, Date.now()), { kind: "reject", reason }, Date.now());
      return { job: rejected, result: rejected };
    } catch (error) {
      failure = error instanceof AgentsError ? error : new AgentsError("JOB_LOCKED", "Only a delivery can be rejected.", 409);
      const live = fresh(current, Date.now());
      return { job: live, result: null };
    }
  });
  if (failure || !saved) throw failure ?? new AgentsError("JOB_LOCKED", "Only a delivery can be rejected.", 409);
  await audit(saved, "job.reject", "Owner rejected the delivery.");
  if (funded) await noteWork(saved.id, "The delivery was rejected. The refund can be started from this page.");
  return json({ job: jobView(saved, job.buyerPlatformId) });
}

async function ownerRevise(req: NextRequest, id: string): Promise<NextResponse> {
  const body = await readBody(req, "agents-job-revise", 20);
  const note = stringField(body, "note", 280);
  assertNoSecret(note);
  const job = await loadJob(id);
  const agent = await signedOwnerAgent(body, "revise-job", `job ${id}\nnote: ${note}`);
  if (agent.platformId !== job.buyerPlatformId || agent.owner !== job.buyerOwner) {
    throw new AgentsError("FORBIDDEN", "The buyer owner sends the delivery back.", 403);
  }
  let failure: AgentsError | null = null;
  const saved = await agentStore().updateJob(id, (current) => {
    if (!current) {
      failure = new AgentsError("NOT_FOUND", "Job not found.", 404);
      return { job: null, result: null as Job | null };
    }
    try {
      const next = applyTurn(fresh(current, Date.now()), { kind: "revise", note }, Date.now());
      return { job: next, result: next };
    } catch (error) {
      failure = error instanceof AgentsError ? error : new AgentsError("JOB_LOCKED", "Only a delivery can be revised.", 409);
      return { job: current, result: null };
    }
  });
  if (failure || !saved) throw failure ?? new AgentsError("JOB_LOCKED", "Only a delivery can be revised.", 409);
  await audit(saved, "job.revise", "Buyer sent the delivery back.");
  await noteWork(saved.id, `The buyer sent the delivery back: ${note}`);
  try {
    const { buyer, seller } = await livePair(saved, true);
    await wake(buyer, seller, saved.id, "revise");
  } catch {
    // The revision stands even when the wake cannot be sent.
  }
  void workHiredDelivery(saved);
  return json({ job: jobView(saved, job.buyerPlatformId) });
}

async function readRefund(_req: NextRequest, caller: Caller, id: string): Promise<NextResponse> {
  const job = await loadJob(id);
  if (!(await seen(caller, job))) throw new AgentsError("NOT_FOUND", "Job not found.", 404);
  const refundable = job.status === "cancelled" || job.status === "expired" || job.status === "rejected" || job.status === "unanswered";
  if (!job.fundSignature || job.settlementSignature || !refundable) {
    throw new AgentsError("JOB_LOCKED", "This job has no refund.", 409);
  }
  if (job.refundSignature) throw new AgentsError("SETTLEMENT_EXISTS", "This refund is already settled.", 409);
  if (!buyerCaller(caller, job)) throw new AgentsError("FORBIDDEN", "The buyer owner signs the refund.", 403);
  requireOpenDeposit(job);
  const step = await prepareRefundStep(job);
  return json({ job: jobView(job, viewerPlatformId(caller, job)), ...step });
}

async function prepareDeposit(caller: Caller, id: string): Promise<NextResponse> {
  const job = await loadJob(id);
  if (!(await seen(caller, job))) throw new AgentsError("NOT_FOUND", "Job not found.", 404);
  if (!buyerCaller(caller, job)) throw new AgentsError("FORBIDDEN", "The buyer owner signs the deposit.", 403);
  if (job.status !== "accepted" || job.fundSignature) {
    throw new AgentsError("JOB_LOCKED", "The deposit waits for an accepted, unpaid job.", 409);
  }
  const { buyer } = await livePair(job, true);
  if (caller.role !== "owner") await assertPayPolicy(buyer, job);
  return json(await buildDepositTransaction(job));
}

async function confirmReceipt(req: NextRequest, caller: Caller, id: string): Promise<NextResponse> {
  const body = await readBody(req, "agents-job-receipt", 20);
  const kind = body.kind;
  const signature = stringField(body, "signature", 120);
  const job = await loadJob(id);
  if (!(await seen(caller, job))) throw new AgentsError("NOT_FOUND", "Job not found.", 404);
  if (!buyerCaller(caller, job)) throw new AgentsError("FORBIDDEN", "The buyer owner confirms this channel.", 403);
  if (kind === "deposit") {
    const transaction = stringField(body, "transaction", 8000);
    const channelId = canonicalPubkey(body.channelId);
    if (!channelId) throw new AgentsError("PAYMENT_INVALID", "The payment is missing the channel.", 402);
    let signed: string;
    try {
      const { VersionedTransaction } = await import("@solana/web3.js");
      const vtx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
      signed = bs58.encode(vtx.signatures[0] ?? new Uint8Array());
    } catch {
      throw new AgentsError("PAYMENT_INVALID", "The channel deposit could not be read.", 402);
    }
    if (signed !== signature) throw new AgentsError("PAYMENT_INVALID", "The channel signature does not match the transaction.", 402);
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: await channelRequirements(job),
      payload: { type: "deposit", channelId, openTransaction: transaction },
    });
    return settleFund(job, header, caller.role === "owner");
  }
  if (kind === "release") {
    if (job.status !== "delivered") throw new AgentsError("JOB_LOCKED", "Approval waits for a delivery.", 409);
    if (!job.reviewReport) throw new AgentsError("JOB_LOCKED", "The supervisor has not reported on this delivery.", 409);
    await assertDeliveryProof(job);
    await confirmSettledTransaction(job, signature, BigInt(job.priceBaseUnits));
    const settled: SettleResponse = {
      success: true,
      transaction: signature,
      network: job.network as SettleResponse["network"],
      payer: job.buyerOwner,
      amount: job.priceBaseUnits,
    };
    const saved = await agentStore().updateJob(id, (current) => {
      if (!current) throw new AgentsError("NOT_FOUND", "Job not found.", 404);
      const live = fresh(current, Date.now());
      if (live.settlementSignature && live.settlementSignature !== signature) {
        throw new AgentsError("SETTLEMENT_EXISTS", "This job is already settled.", 409);
      }
      if (live.status !== "delivered") throw new AgentsError("JOB_LOCKED", "Approval waits for a delivery.", 409);
      const next: Job = { ...live, status: "settled", settlementSignature: signature, updatedAt: Date.now() };
      return { job: next, result: next };
    });
    await audit(saved, "job.approve", "Buyer accepted the delivery. The channel paid the seller.");
    await noteWork(saved.id, "The channel paid the hired agent.");
    return json({ job: jobView(saved, job.buyerPlatformId), delivery: deliveryOf(saved) }, 200, {
      "PAYMENT-RESPONSE": paymentResponseHeader(settled),
    });
  }
  if (kind === "refund-close") {
    const refundable = job.status === "cancelled" || job.status === "expired" || job.status === "rejected" || job.status === "unanswered";
    if (!job.fundSignature || job.settlementSignature || job.refundSignature || !refundable) {
      throw new AgentsError("JOB_LOCKED", "This job has no refund.", 409);
    }
    const { readyAt } = await confirmCloseTransaction(job, signature);
    const saved = await agentStore().updateJob(id, (current) => {
      if (!current) throw new AgentsError("NOT_FOUND", "Job not found.", 404);
      const next: Job = { ...current, closeSignature: signature, refundReadyAt: readyAt, updatedAt: Date.now() };
      return { job: next, result: next };
    });
    await audit(saved, "job.refund-close", "The buyer started the refund. The deposit unlocks after the channel grace period.");
    await noteWork(saved.id, `The refund was requested. The deposit unlocks ${new Date(readyAt).toLocaleString()}.`);
    return json({ job: jobView(saved, viewerPlatformId(caller, saved)), refundReadyAt: readyAt });
  }
  if (kind === "refund") {
    const refundable = job.status === "cancelled" || job.status === "expired" || job.status === "rejected" || job.status === "unanswered";
    if (!job.fundSignature || job.settlementSignature || job.refundSignature || !refundable) {
      throw new AgentsError("JOB_LOCKED", "This job has no refund.", 409);
    }
    await confirmRefundTransaction(job, signature);
    const done = await agentStore().updateJob(job.id, (current) => {
      if (!current) throw new AgentsError("NOT_FOUND", "Job not found.", 404);
      if (current.refundSignature && current.refundSignature !== signature) {
        throw new AgentsError("SETTLEMENT_EXISTS", "This refund is already settled.", 409);
      }
      const next = { ...current, refundSignature: signature, updatedAt: Date.now() };
      return { job: next, result: next };
    });
    await audit(done, "job.refunded", "The channel refunded the buyer.", true);
    await noteWork(done.id, "The deposit went back to the buyer.");
    return json({ job: jobView(done, viewerPlatformId(caller, done)) });
  }
  throw new AgentsError("INVALID_PARAMS", "The channel receipt is invalid.", 400);
}

export async function jobsRoute(req: NextRequest, method: string, path: string[], caller: Caller): Promise<NextResponse> {
  if (method === "GET" && path[0] === "agents" && path[2] === "jobs" && path.length === 3) {
    if (caller.role !== "owner") throw new AgentsError("OWNER_REQUIRED", "The owner session is required.", 403);
    const agent = await agentStore().getAgent(path[1]!);
    if (!agent || agent.owner !== caller.owner) throw new AgentsError("NOT_FOUND", "Agent not found.", 404);
    const now = Date.now();
    const jobs = await agentStore().listJobsForAgent(agent.platformId);
    const freshJobs = jobs.map((job) => fresh(job, now));
    return json({
      jobs: freshJobs.map((job) => jobView(job, agent.platformId)),
      reputation: reputationForAgent(freshJobs, agent.platformId),
    });
  }
  if (path[0] !== "jobs") throw new AgentsError("NOT_FOUND", "Unknown agents route.", 404);
  if (method === "POST" && path.length === 1) return offer(caller, await readBody(req, "agents-jobs", 30));
  if (method === "GET" && path.length === 3 && path[2] === "escrow") return readOne(req, caller, path[1]!);
  if (method === "GET" && path.length === 3 && path[2] === "refund") return readRefund(req, caller, path[1]!);
  if (method === "POST" && path.length === 3 && path[2] === "deposit") return prepareDeposit(caller, path[1]!);
  if (method === "POST" && path.length === 3 && path[2] === "receipt") return confirmReceipt(req, caller, path[1]!);
  if (method === "GET" && path.length === 2) return readOne(req, caller, path[1]!);
  if (method === "POST" && path.length === 3 && path[2] === "approve") return approve(req, path[1]!);
  if (method === "POST" && path.length === 3 && path[2] === "reject") return ownerReject(req, path[1]!);
  if (method === "POST" && path.length === 3 && path[2] === "revise") return ownerRevise(req, path[1]!);
  if (method === "POST" && path.length === 2) return turn(caller, path[1]!, await readBody(req, "agents-jobs", 30));
  throw new AgentsError("NOT_FOUND", "Unknown agents route.", 404);
}
