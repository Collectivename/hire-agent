/**
 * The only file in this folder that reaches into the Collective app.
 * Firestore, the Solana RPC, rate limits, and token or DAO transaction
 * builders live there. The rest of hire/ is the hire product.
 */
import "server-only";
import { getConnectionFor as connectionFor } from "@/lib/bags";
import { hireCluster } from "./cluster";

export { actualBodyExceeds, contentLengthExceeds } from "@/lib/body-limit";
export { getConnectionFor, getServerConnection } from "@/lib/bags";
export { clusterRpcUrl, serverRpcUrl } from "@/lib/rpc";

/** Reads and confirms on the request cluster. Mainnet routes stay on the mainnet pool. */
export function hireConnection() {
  return connectionFor(hireCluster() === "devnet" ? "devnet" : undefined);
}
export { resolveClientIp } from "@/lib/client-ip";
export { rateLimit } from "@/lib/rate-limit";
export { getAdminDb } from "@/lib/firebase-admin";

export { attachMintSigner } from "@/lib/agent/attach-mint";
export { bundleDigest } from "@/lib/bundle-digest";
export { deriveLaunchMint, issueBundleToken, newLaunchNonce } from "@/lib/bundle-token";
export { withCollectiveTag } from "@/lib/collective-tag";
export {
  assertProposalBelongs,
  buildCreateProposalIxs,
  buildVoteIxs,
  deriveTokenOwnerRecord,
} from "@/lib/governance";
export type { ProposalAction } from "@/lib/governance";
export { fetchLookupTables, fetchPumpProtocolAlt } from "@/lib/launch-alt";
export { solTransferLines, tokenTransferLines } from "@/lib/proposal-exec";
export { validateProposalAction } from "@/lib/proposal-action-validate";
export { pinPumpMetadata } from "@/lib/pump";
export {
  assemblePumpCreateIxs,
  buyLamportsFromFields,
  compilePumpCreateBundle,
  pumpLaunchFieldsFromBody,
  validatePumpLaunchBody,
} from "@/lib/pump-launch";
export { buildPumpSwap } from "@/lib/pump-trade";
export { deriveGovernanceAddresses, packInstructions } from "@/lib/realms";
export { deserializeTx, serializeTx } from "@/lib/tx-serialize";
