import "server-only";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { WalletProvisioner } from "../protocol";
import { AgentsError } from "./errors";

export type SpikeResult =
  | "unconfigured"
  | "server_cannot_sign"
  | "server_can_sign"
  | "inconclusive";

function privyConfigured(): boolean {
  return Boolean(process.env.PRIVY_APP_ID?.trim() && process.env.PRIVY_APP_SECRET?.trim());
}

export function walletProviderStatus(): { privy: "configured" | "unconfigured" } {
  return { privy: privyConfigured() ? "configured" : "unconfigured" };
}

function privyAuthHeader(): string {
  const id = process.env.PRIVY_APP_ID!.trim();
  const secret = process.env.PRIVY_APP_SECRET!.trim();
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

async function privyFetch(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`https://api.privy.io${path}`, {
    method: "POST",
    headers: {
      authorization: privyAuthHeader(),
      "privy-app-id": process.env.PRIVY_APP_ID!.trim(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, json };
}

function spikeFromHttp(status: number, json: unknown): SpikeResult {
  if (status === 401 || status === 403) return "server_cannot_sign";
  if (status >= 200 && status < 300) return "server_can_sign";
  const text = JSON.stringify(json ?? "").toLowerCase();
  if (/authoriz|forbidden|owner|signature required|not a signer|permission/.test(text)) {
    return "server_cannot_sign";
  }
  return "inconclusive";
}

function unsignedProbe(address: string): string {
  const key = new PublicKey(address);
  const tx = new Transaction({
    feePayer: key,
    recentBlockhash: new PublicKey(new Uint8Array(32)).toBase58(),
  });
  tx.add(SystemProgram.transfer({ fromPubkey: key, toPubkey: key, lamports: 0 }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

function privyFailure(status: number, fallback: string): AgentsError {
  if (status === 401 || status === 403) {
    return new AgentsError("WALLET_PROVIDER_UNCONFIGURED", "Privy rejected the app id or app secret.", 502);
  }
  return new AgentsError("WALLET_CREATE_FAILED", fallback, 502);
}

function privyUserId(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const id = (json as { id?: unknown }).id;
  return typeof id === "string" && id.startsWith("did:privy:") && !/\s/.test(id) ? id : null;
}

/**
 * The connected Solana wallet is linked as the Privy user, and that user owns
 * the agent wallet. Collective's app secret creates the wallet and is not a
 * signer. An additional signer, installed once on the owner's machine, can
 * sign only inside a policy and cannot change the owner, the signers, the
 * policy, or export the key.
 */
async function privyUserForOwner(owner: string): Promise<string> {
  const found = await privyFetch("/v1/users/wallet/address", { address: owner });
  const existing = found.status < 300 ? privyUserId(found.json) : null;
  if (existing) return existing;
  const created = await privyFetch("/v1/users", {
    linked_accounts: [{ type: "wallet", address: owner, chain_type: "solana" }],
  });
  const made = created.status < 300 ? privyUserId(created.json) : null;
  if (made) return made;
  const again = await privyFetch("/v1/users/wallet/address", { address: owner });
  const raced = again.status < 300 ? privyUserId(again.json) : null;
  if (raced) return raced;
  throw privyFailure(created.status || found.status, "Privy did not attach this owner wallet.");
}

class PrivyProvisioner implements WalletProvisioner {
  readonly provider = "privy" as const;

  async createWallet(_agentId: string, owner: string): Promise<{ address: string; providerWalletId: string }> {
    if (!privyConfigured()) {
      throw new AgentsError("WALLET_PROVIDER_UNCONFIGURED", "Privy is not configured.", 503);
    }
    const userId = await privyUserForOwner(owner);
    const created = await privyFetch("/v1/wallets", {
      chain_type: "solana",
      owner: { user_id: userId },
      // The app secret is not a signer. Public SI builders reject this address;
      // spend goes through the hire action API, which re-checks the owner policy.
      additional_signers: [],
    });
    const body = created.json as { id?: unknown; address?: unknown } | null;
    if (
      created.status >= 300 ||
      !body ||
      typeof body.id !== "string" ||
      typeof body.address !== "string" ||
      body.address === owner
    ) {
      throw privyFailure(created.status, "Privy did not create a Solana wallet.");
    }
    return { address: body.address, providerWalletId: body.id };
  }
}

export function provisioner(): WalletProvisioner {
  return new PrivyProvisioner();
}

/**
 * A request authenticated only with Collective's server credential must fail
 * to sign. The returned signature is discarded and never broadcast.
 */
export async function assertServerCannotSign(
  providerWalletId: string,
  address: string
): Promise<SpikeResult> {
  if (!privyConfigured()) return "unconfigured";
  const probed = await privyFetch(`/v1/wallets/${encodeURIComponent(providerWalletId)}/rpc`, {
    method: "signTransaction",
    params: { transaction: unsignedProbe(address), encoding: "base64" },
  });
  return spikeFromHttp(probed.status, probed.json);
}

export async function createAgentWallet(
  agentId: string,
  owner: string
): Promise<{ address: string; providerWalletId: string }> {
  const created = await provisioner().createWallet(agentId, owner);
  const spike = await assertServerCannotSign(created.providerWalletId, created.address);
  if (spike !== "server_cannot_sign") {
    throw new AgentsError(
      "WALLET_SPIKE_FAILED",
      `Collective's server credential must be unable to sign. Spike result: ${spike}. Provider wallet ${created.providerWalletId} was not saved.`,
      502
    );
  }
  return created;
}
