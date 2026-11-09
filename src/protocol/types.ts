/** Protocol types for a hired agent. */

export type AgentStatus = "pending_credential" | "active" | "paused" | "removed";

export type WalletProviderName = "privy";

export type Risk = "low" | "medium" | "high";

export type SignerRole = "owner" | "agent" | "none";

export type Policy = {
  perTxCapLamports: string;
  dailyBudgetLamports: string;
  allowedActions: string[];
  allowedPrograms: string[];
  allowedRecipients: string[];
  allowedMints: string[];
  maxPerMinute: number;
};

export type PolicyRequest = {
  action: string;
  programIds: string[];
  amountLamports: string;
  recipient: string | null;
  /** Every recipient a proposal execution will pay. Checked even when the lamport amount is 0. */
  recipients?: string[];
  mint: string | null;
  authorityChange: boolean;
  payment: boolean;
  paused: boolean;
  spentTodayLamports: string;
  actionsLastMinute: number;
};

export type PolicyDecision = {
  allow: boolean;
  reason: string;
  risk: Risk;
  signer: SignerRole;
};

export type OasfSkill = {
  id: number;
};

export type OasfRecord = {
  name: string;
  version: string;
  schemaVersion: string;
  description: string;
  skills: OasfSkill[];
  locators: { type: string; url: string }[];
  extensions: {
    name: string;
    data: { platformId: string; solanaAddress: string };
  }[];
};

export type DirectoryHit = {
  platformId: string;
  asset: string;
  owner: string;
  uri: string;
  skills: string[];
  domains: string[];
  name?: string;
  description?: string;
};

export interface Directory {
  /** Skill path from the OASF 0.8 taxonomy. Hits already passed the asset re-read. */
  search(query: { skill: string }): Promise<{ skill: string; hits: DirectoryHit[]; complete: boolean }>;
}

export type TaskBody = {
  taskId: string;
  /** Tasks on this channel are always another agent. Owner chat uses the inbox. */
  fromRole: "agent";
  fromPlatformId: string;
  toPlatformId: string;
  kind: "offer" | "counter" | "accept" | "decline" | "progress" | "deliver" | "reject" | "request" | "complete";
  text: string;
};

export interface Transport {
  send(input: { from: string; to: string; body: TaskBody }): Promise<{ messageId: string }>;
};

/**
 * Creates the agent's Solana wallet. There is no sign method: Collective's
 * server credential must not be able to sign, export, or change the owner.
 */
export interface WalletProvisioner {
  readonly provider: WalletProviderName;
  createWallet(agentId: string, owner: string): Promise<{ address: string; providerWalletId: string }>;
}
