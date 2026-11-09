import "server-only";
import { canonicalPubkey, randomId } from "./crypto";
import { agentMatchesCluster, hireCluster } from "./cluster";
import { AgentsError } from "./errors";
import {
  expectation,
  futureDeadline,
  priceUnits,
  SOLANA_DEVNET,
  USDC_DEVNET,
  type Job,
  type JobProof,
} from "./jobs";
import { secretMaterial } from "./messages";
import { isSupervisor } from "./supervisor";
import { agentStore, type StoredAgent } from "./store";
import { transport } from "./transport";
import { x402Asset, x402Network } from "./x402";

function configuredMint(): { mint: string; network: string } {
  const devnet = hireCluster() === "devnet";
  const mint = canonicalPubkey((devnet ? process.env.X402_DEVNET_ASSET?.trim() : "") || (devnet ? USDC_DEVNET : x402Asset()));
  const network = (devnet ? process.env.X402_DEVNET_NETWORK?.trim() : "") || (devnet ? SOLANA_DEVNET : x402Network());
  if (!mint || !/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(network)) {
    throw new AgentsError("FACILITATOR_UNCONFIGURED", "The USDC mint or Solana network is not configured.", 503);
  }
  return { mint, network };
}

/** An offer the owner confirmed in chat. The other agent still accepts or declines. No USDC moves here. */
export async function createOwnerOffer(input: {
  buyer: StoredAgent;
  seller: StoredAgent;
  priceBaseUnits: string;
  deadline: number;
  terms: string;
  proof?: JobProof;
  expectedProof?: string;
}): Promise<{ job: Job; wake: "sent" | "skipped" }> {
  const buyer = input.buyer;
  const seller = input.seller;
  if (!buyer || buyer.status === "paused" || buyer.status === "removed") {
    throw new AgentsError("PAUSED", "A paused agent cannot hire.", 403);
  }
  if (!seller || (seller.status !== "active" && seller.status !== "pending_credential") || !agentMatchesCluster(buyer) || !agentMatchesCluster(seller)) {
    throw new AgentsError("NOT_FOUND", "Target agent is not active.", 404);
  }
  if (seller.platformId === buyer.platformId) throw new AgentsError("INVALID_PARAMS", "An agent cannot hire itself.", 400);
  if (isSupervisor(seller.platformId)) {
    throw new AgentsError("INVALID_PARAMS", "The supervisor reviews deliveries. It is not hired.", 400);
  }
  if (!canonicalPubkey(buyer.walletAddress) || !canonicalPubkey(seller.walletAddress)) {
    throw new AgentsError("NOT_READY", "Both agent wallets must be canonical Solana addresses.", 400);
  }
  const terms = input.terms.trim();
  if (!terms || terms.length > 280) throw new AgentsError("INVALID_PARAMS", "terms is invalid.", 400);
  if (secretMaterial(terms)) throw new AgentsError("SENSITIVE_FIELD", "The terms look like a credential or key.", 400);
  const now = Date.now();
  const proof = input.proof ?? "subjective";
  const { mint, network } = configuredMint();
  const job: Job = {
    id: randomId("job"),
    buyerPlatformId: buyer.platformId,
    sellerPlatformId: seller.platformId,
    buyerOwner: buyer.owner,
    sellerOwner: seller.owner,
    buyerWallet: buyer.walletAddress,
    sellerWallet: seller.walletAddress,
    status: "offered",
    priceBaseUnits: priceUnits(input.priceBaseUnits),
    mint,
    network,
    deadline: futureDeadline(input.deadline, now),
    terms,
    proof,
    expectedProof: expectation(proof, input.expectedProof ?? ""),
    deliveryNote: "",
    deliveryProof: "",
    deliveryFiles: [],
    deliveryHistory: [],
    approvalDigest: "",
    escrowWallet: "",
    channelId: "",
    depositPayload: "",
    fundSignature: "",
    fundPayloadHash: "",
    refundSignature: "",
    reviewReport: "",
    revisionNote: "",
    settlementSignature: "",
    settlementPayloadHash: "",
    rejectReason: "",
    offerReply: "pending",
    createdAt: now,
    updatedAt: now,
  };
  await agentStore().saveJob(job);
  const sent = await transport().send({
    kind: "pointer",
    fromPlatformId: buyer.platformId,
    toPlatformId: seller.platformId,
    messageId: randomId("msg"),
    jobId: job.id,
    turn: "offer",
  });
  const at = Date.now();
  for (const platformId of [job.buyerPlatformId, job.sellerPlatformId]) {
    await agentStore().saveAudit({
      id: randomId("aud"),
      platformId,
      actionId: null,
      kind: "job.offer",
      summary: "Offer stored.",
      verified: false,
      reported: true,
      detail: { jobId: job.id, status: job.status, wake: sent.status },
      createdAt: at,
    });
  }
  return { job, wake: sent.status };
}

export function usdcBaseUnits(value: string): string {
  const match = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new AgentsError("INVALID_PARAMS", "The budget must be a USDC amount such as 5 or 12.50.", 400);
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(6, "0");
  const units = `${whole}${fraction}`.replace(/^0+/, "");
  if (!units) throw new AgentsError("INVALID_PARAMS", "The budget must be more than zero.", 400);
  return units;
}

export function hireDeadline(value: string, now = Date.now()): number {
  const text = value.trim();
  const lower = text.toLowerCase();
  if (lower === "asap" || lower === "as soon as possible") return futureDeadline(now + 24 * 60 * 60 * 1000, now);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const stamp = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59);
    return futureDeadline(stamp, now);
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return futureDeadline(parsed, now);
  throw new AgentsError("INVALID_PARAMS", "The deadline must be a day such as 2026-11-12, or asap.", 400);
}
