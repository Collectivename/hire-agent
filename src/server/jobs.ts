import { canonicalJson } from "../protocol";
import { sha256Hex } from "./crypto";
import { AgentsError } from "./errors";

export const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

export type JobStatus =
  | "offered"
  | "accepted"
  | "delivered"
  | "settled"
  | "declined"
  | "rejected"
  | "expired"
  | "unanswered"
  | "cancelled";

export type JobProof = "subjective" | "hash" | "signature";

export type Job = {
  id: string;
  buyerPlatformId: string;
  sellerPlatformId: string;
  buyerOwner: string;
  sellerOwner: string;
  buyerWallet: string;
  sellerWallet: string;
  escrowWallet: string;
  channelId: string;
  depositPayload: string;
  settleTransaction?: string;
  settleKind?: "" | "release" | "refund";
  settleSigned?: boolean;
  settleVoucherMessage?: string;
  settleVoucherSignature?: string;
  /** Signature of the payer-signed request-close that started a refund. */
  closeSignature?: string;
  /** When a requested refund can be finalized, in epoch milliseconds. */
  refundReadyAt?: number;
  /** Precise worker timeline for this job, oldest first, capped server-side. */
  workLog?: { at: number; text: string }[];
  /** True while the hired agent is running a work pass for this job. */
  working?: boolean;
  fundSignature: string;
  fundPayloadHash: string;
  refundSignature: string;
  reviewReport: string;
  revisionNote: string;
  status: JobStatus;
  priceBaseUnits: string;
  mint: string;
  network: string;
  deadline: number;
  terms: string;
  proof: JobProof;
  expectedProof: string;
  deliveryNote: string;
  deliveryProof: string;
  deliveryFiles: { path: string; content: string }[];
  deliveryHistory: string[];
  approvalDigest: string;
  settlementSignature: string;
  settlementPayloadHash: string;
  rejectReason: string;
  /** pending until the hired agent answers. accept or decline once they have. */
  offerReply?: "" | "pending" | "running" | "accept" | "decline";
  createdAt: number;
  updatedAt: number;
};

export type JobTurn =
  | {
      kind: "counter";
      priceBaseUnits: string;
      deadline: number;
      terms: string;
      proof: JobProof;
      expectedProof: string;
    }
  | { kind: "accept"; buyerWallet: string; sellerWallet: string }
  | { kind: "decline" }
  | { kind: "progress" }
  | { kind: "deliver"; note: string; deliveryProof: string; files?: { path: string; content: string }[] }
  | { kind: "revise"; note: string }
  | { kind: "reject"; reason: string };

const HASH = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const OPEN = new Set<JobStatus>(["offered", "accepted", "delivered"]);

export function priceUnits(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,17}$/.test(value)) {
    throw new AgentsError("INVALID_PARAMS", "priceBaseUnits must be a positive token amount.", 400);
  }
  return value;
}

export function futureDeadline(value: unknown, now: number): number {
  const max = now + 30 * 24 * 60 * 60 * 1000;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= now || value > max) {
    throw new AgentsError("INVALID_PARAMS", "deadline must be a future time within 30 days.", 400);
  }
  return value;
}

export function proofKind(value: unknown): JobProof {
  if (value === "subjective" || value === "hash" || value === "signature") return value;
  throw new AgentsError("INVALID_PARAMS", "proof must be subjective, hash, or signature.", 400);
}

export function expectation(proof: JobProof, value: unknown): string {
  if (proof === "subjective") {
    if (value == null || value === "") return "";
    throw new AgentsError("INVALID_PARAMS", "A subjective offer has no expected proof.", 400);
  }
  if (typeof value !== "string") throw new AgentsError("INVALID_PARAMS", "expectedProof is required.", 400);
  if (proof === "hash" && HASH.test(value)) return value;
  if (proof === "signature" && SIGNATURE.test(value)) return value;
  throw new AgentsError("INVALID_PARAMS", "expectedProof does not match the proof type.", 400);
}

export function deliveryValue(proof: JobProof, value: unknown): string {
  if (proof === "subjective") {
    if (value == null || value === "") return "";
    throw new AgentsError("INVALID_PARAMS", "A subjective delivery has no proof string.", 400);
  }
  if (typeof value !== "string") throw new AgentsError("INVALID_PARAMS", "deliveryProof is required.", 400);
  if (proof === "hash" && HASH.test(value)) return value;
  if (proof === "signature" && SIGNATURE.test(value)) return value;
  throw new AgentsError("INVALID_PARAMS", "deliveryProof does not match the proof type.", 400);
}

export function turnKind(value: unknown): JobTurn["kind"] {
  if (
    value === "counter" ||
    value === "accept" ||
    value === "decline" ||
    value === "progress" ||
    value === "deliver" ||
    value === "revise" ||
    value === "reject"
  ) {
    return value;
  }
  throw new AgentsError(
    "INVALID_PARAMS",
    "A complete message does not pay. Use offer, counter, accept, decline, progress, deliver, revise, or reject.",
    400
  );
}

export function fresh(job: Job, now: number): Job {
  if ((job.status === "offered" || job.status === "accepted") && now > job.deadline) {
    return { ...job, status: "expired", updatedAt: now };
  }
  if (job.status === "delivered" && now > job.deadline) {
    return { ...job, status: "unanswered", updatedAt: now };
  }
  return job;
}

export function isOpen(status: JobStatus): boolean {
  return OPEN.has(status);
}

export function cancelJob(job: Job, now: number): Job | null {
  if (!isOpen(job.status)) return null;
  return { ...job, status: "cancelled", updatedAt: now };
}

export function termsDigest(job: Pick<Job, "id" | "network" | "priceBaseUnits" | "mint" | "sellerWallet">): string {
  return paymentDigest(job, job.sellerWallet);
}

export function paymentDigest(
  job: Pick<Job, "id" | "network" | "priceBaseUnits" | "mint">,
  payTo: string
): string {
  return sha256Hex(
    canonicalJson({
      jobId: job.id,
      scheme: "upto",
      network: job.network,
      amount: job.priceBaseUnits,
      asset: job.mint,
      payTo,
    })
  );
}

export function lockedPayment(job: Job, payTo = job.sellerWallet): {
  scheme: "upto";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
} {
  return {
    scheme: "upto",
    network: job.network,
    amount: job.priceBaseUnits,
    asset: job.mint,
    payTo,
  };
}

export function paymentMatches(
  accepted: { scheme?: unknown; network?: unknown; amount?: unknown; asset?: unknown; payTo?: unknown },
  job: Job,
  payTo = job.sellerWallet
): boolean {
  const locked = lockedPayment(job, payTo);
  return (
    accepted.scheme === locked.scheme &&
    accepted.network === locked.network &&
    accepted.amount === locked.amount &&
    accepted.asset === locked.asset &&
    accepted.payTo === locked.payTo
  );
}

export function assertSettleable(job: Job, payloadHash: string): void {
  if (job.settlementSignature) {
    throw new AgentsError("SETTLEMENT_EXISTS", "This job is already settled.", 409);
  }
  if (job.settlementPayloadHash && job.settlementPayloadHash !== payloadHash) {
    throw new AgentsError("SETTLEMENT_EXISTS", "A different payment is already in progress for this job.", 409);
  }
  if (job.status !== "delivered") {
    throw new AgentsError("JOB_LOCKED", "Payment waits for a delivery.", 409);
  }
}

export function applyTurn(job: Job, turn: JobTurn, now: number): Job {
  const current = fresh(job, now);
  if (turn.kind === "counter") {
    if (current.status !== "offered") {
      throw new AgentsError("JOB_LOCKED", "The price is frozen. A new price is a new job.", 409);
    }
    priceUnits(turn.priceBaseUnits);
    return {
      ...current,
      priceBaseUnits: turn.priceBaseUnits,
      deadline: turn.deadline,
      terms: turn.terms,
      proof: turn.proof,
      expectedProof: turn.expectedProof,
      updatedAt: now,
    };
  }
  if (turn.kind === "accept") {
    if (current.status !== "offered") {
      throw new AgentsError("JOB_LOCKED", "This offer is no longer open.", 409);
    }
    return {
      ...current,
      status: "accepted",
      buyerWallet: turn.buyerWallet,
      sellerWallet: turn.sellerWallet,
      updatedAt: now,
    };
  }
  if (turn.kind === "decline") {
    if (current.status !== "offered") {
      throw new AgentsError("JOB_LOCKED", "This offer is no longer open.", 409);
    }
    return { ...current, status: "declined", updatedAt: now };
  }
  if (turn.kind === "progress") {
    if (current.status !== "accepted" && current.status !== "delivered") {
      throw new AgentsError("JOB_LOCKED", "Progress follows an accepted job.", 409);
    }
    return { ...current, updatedAt: now };
  }
  if (turn.kind === "deliver") {
    if (!current.fundSignature) {
      throw new AgentsError("JOB_LOCKED", "Delivery waits until the channel deposit settles.", 409);
    }
    if (current.status !== "accepted" && current.status !== "delivered") {
      throw new AgentsError("JOB_LOCKED", "Delivery waits until the offer is accepted.", 409);
    }
    const deliveryHistory = current.deliveryProof ? [...current.deliveryHistory, current.deliveryProof] : current.deliveryHistory;
    return {
      ...current,
      status: "delivered",
      deliveryNote: turn.note,
      deliveryProof: turn.deliveryProof,
      deliveryFiles: turn.files ?? [],
      deliveryHistory,
      reviewReport: "",
      updatedAt: now,
    };
  }
  if (turn.kind === "revise") {
    if (!current.fundSignature || current.settlementSignature || current.status !== "delivered") {
      throw new AgentsError("JOB_LOCKED", "A revision waits for a funded delivery that has not been released.", 409);
    }
    const deliveryHistory = current.deliveryProof ? [...current.deliveryHistory, current.deliveryProof] : current.deliveryHistory;
    return {
      ...current,
      status: "accepted",
      deliveryNote: "",
      deliveryProof: "",
      deliveryFiles: [],
      deliveryHistory,
      reviewReport: "",
      revisionNote: turn.note,
      updatedAt: now,
    };
  }
  if (current.status !== "delivered") {
    throw new AgentsError("JOB_LOCKED", "Only a delivery can be rejected.", 409);
  }
  return { ...current, status: "rejected", rejectReason: turn.reason, updatedAt: now };
}
