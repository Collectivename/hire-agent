import "server-only";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements, PaymentRequired, SettleResponse } from "@x402/core/types";
import { UptoSvmScheme as UptoServerScheme } from "@x402/svm/upto/server";
import { buildOpenTransaction, confirmOpenTransaction } from "./channel";
import { canonicalPubkey } from "./crypto";
import { AgentsError } from "./errors";
import { SOLANA_DEVNET, SOLANA_MAINNET, USDC_DEVNET, USDC_MAINNET, type Job } from "./jobs";

const CHANNEL_CAP_SECONDS = 2_592_000;

/** Kept so older checks can install a stub. The hire channel does not call a facilitator. */
export function useX402Facilitator(_client: FacilitatorClient | null): void {
  void _client;
}

export function x402Network(): string {
  const configured = process.env.X402_NETWORK?.trim();
  return configured || SOLANA_MAINNET;
}

export function x402Asset(): string {
  const configured = process.env.X402_ASSET?.trim();
  if (configured) return configured;
  return x402Network() === SOLANA_DEVNET ? USDC_DEVNET : USDC_MAINNET;
}

export function channelWindow(job: Job): number {
  const remaining = Math.ceil((job.deadline - Date.now()) / 1000);
  return Math.min(CHANNEL_CAP_SECONDS, Math.max(120, remaining));
}

export async function channelRequirements(job: Job): Promise<PaymentRequirements> {
  const owner = canonicalPubkey(job.buyerOwner);
  if (!owner) throw new AgentsError("NOT_READY", "The buyer owner wallet is not a Solana address.", 400);
  const window = channelWindow(job);
  const scheme = new UptoServerScheme({ withdrawDelay: window });
  const base: PaymentRequirements = {
    scheme: "upto",
    network: job.network as Network,
    asset: job.mint,
    amount: job.priceBaseUnits,
    payTo: job.sellerWallet,
    maxTimeoutSeconds: window,
    extra: { paymentFlow: "escrow" },
  };
  try {
    const enhanced = await scheme.enhancePaymentRequirements(
      base,
      {
        x402Version: 2,
        scheme: "upto",
        network: job.network as Network,
        extra: { feePayer: owner, receiverAuthorizer: owner },
      },
      []
    );
    return { ...enhanced, extra: { ...enhanced.extra, paymentFlow: "escrow", feePayer: owner, receiverAuthorizer: owner } };
  } catch {
    throw new AgentsError("PAYMENT_INVALID", "The channel requirements could not be prepared.", 402);
  }
}

export async function buildDepositTransaction(job: Job): Promise<{
  transaction: string;
  channelId: string;
  blockhash: string;
  lastValidBlockHeight: string;
}> {
  const opened = await buildOpenTransaction(job, channelWindow(job));
  return {
    transaction: opened.transaction,
    channelId: opened.channelId,
    blockhash: opened.blockhash,
    lastValidBlockHeight: opened.lastValidBlockHeight,
  };
}

export function paymentRequiredHeader(
  requirements: PaymentRequirements,
  resourceUrl: string,
  description = "Hired agent delivery"
): string {
  const body: PaymentRequired = {
    x402Version: 2,
    resource: { url: resourceUrl, description, mimeType: "application/json" },
    accepts: [requirements],
  };
  return encodePaymentRequiredHeader(body);
}

export function readPaymentSignature(header: string): PaymentPayload {
  try {
    return decodePaymentSignatureHeader(header);
  } catch {
    throw new AgentsError("PAYMENT_INVALID", "PAYMENT-SIGNATURE could not be read.", 400);
  }
}

export function channelIdOf(payload: PaymentPayload): string {
  const raw = payload.payload as { channelId?: unknown };
  const channelId = canonicalPubkey(raw.channelId);
  if (!channelId) throw new AgentsError("PAYMENT_INVALID", "The payment is missing the channel.", 402);
  return channelId;
}

export async function settleDeposit(job: Job, payload: PaymentPayload): Promise<SettleResponse> {
  const fields = payload.payload as { openTransaction?: unknown; channelId?: unknown };
  if (typeof fields.openTransaction !== "string") {
    throw new AgentsError("PAYMENT_INVALID", "The buyer owner has to sign the channel deposit.", 402);
  }
  const feePayer = canonicalPubkey(payload.accepted.extra?.feePayer);
  const authorizer = canonicalPubkey(payload.accepted.extra?.receiverAuthorizer);
  if (feePayer !== job.buyerOwner || authorizer !== job.buyerOwner) {
    throw new AgentsError("PAYMENT_INVALID", "The buyer owner has to sign this channel.", 402);
  }
  const channelId = channelIdOf(payload);
  const signature = await confirmOpenTransaction(job, fields.openTransaction, channelId);
  return {
    success: true,
    transaction: signature,
    network: payload.accepted.network,
    payer: job.buyerOwner,
    amount: job.priceBaseUnits,
  };
}

export function paymentResponseHeader(settled: SettleResponse): string {
  return encodePaymentResponseHeader(settled);
}
