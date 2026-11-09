/**
 * Fail-closed policy and OASF checks for the BYOA control plane.
 * Run: npx tsx hire/scripts/agents-policy-check.ts
 */
import { buildOasfRecord, defaultPolicy, evaluatePolicy, validateOasf } from "../src/protocol";
import {
  applyAgentReply,
  applyOwnerMessage,
  chatView,
  closePending,
  parseChatText,
  pendingOwnerMessages,
  trimThread,
  type StoredChatMessage,
} from "../src/server/chat";
import { AgentsError } from "../src/server/errors";
import {
  applyTurn,
  fresh,
  paymentMatches,
  type Job,
} from "../src/server/jobs";
import { reputationForAgent, reputationForOwner } from "../src/server/reputation";

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const denied = evaluatePolicy(defaultPolicy(), {
  action: "dao.read",
  programIds: [],
  amountLamports: "0",
  recipient: null,
  mint: null,
  authorityChange: false,
  payment: false,
  paused: false,
  spentTodayLamports: "0",
  actionsLastMinute: 0,
});
assert(!denied.allow, "a new agent is denied");
assert(denied.signer === "none", "a denial has no signer");

const opened = {
  ...defaultPolicy(),
  allowedActions: ["pay", "dao.read"],
  allowedRecipients: ["Recipient111111111111111111111111111111111"],
  perTxCapLamports: "1000",
  dailyBudgetLamports: "1000",
  maxPerMinute: 2,
};
const pay = evaluatePolicy(opened, {
  action: "pay",
  programIds: [],
  amountLamports: "500",
  recipient: "Recipient111111111111111111111111111111111",
  mint: null,
  authorityChange: false,
  payment: true,
  paused: false,
  spentTodayLamports: "0",
  actionsLastMinute: 0,
});
assert(pay.allow && pay.signer === "owner" && pay.risk === "high", "payments stay with the owner");

const over = evaluatePolicy(opened, {
  ...{
    action: "pay",
    programIds: [],
    amountLamports: "2000",
    recipient: "Recipient111111111111111111111111111111111",
    mint: null,
    authorityChange: false,
    payment: true,
    paused: false,
    spentTodayLamports: "0",
    actionsLastMinute: 0,
  },
});
assert(!over.allow, "over the cap is blocked");

const unknown = evaluatePolicy(
  { ...opened, allowedActions: ["trade"], allowedPrograms: ["11111111111111111111111111111111"] },
  {
    action: "trade",
    programIds: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
    amountLamports: "0",
    recipient: null,
    mint: null,
    authorityChange: false,
    payment: false,
    paused: false,
    spentTodayLamports: "0",
    actionsLastMinute: 0,
  }
);
assert(!unknown.allow, "an unknown program is blocked");

const paused = evaluatePolicy(opened, {
  action: "dao.read",
  programIds: [],
  amountLamports: "0",
  recipient: null,
  mint: null,
  authorityChange: false,
  payment: false,
  paused: true,
  spentTodayLamports: "0",
  actionsLastMinute: 0,
});
assert(!paused.allow, "a paused agent is denied");

const record = buildOasfRecord({
  nameUrl: "https://example.com/agents/1",
  description: "Votes and trades inside an owner policy.",
  skillIds: [10201],
  platformId: "agt_test",
  solanaAddress: "11111111111111111111111111111111",
  slimName: "collective/agents/service/agttest",
});
assert(validateOasf(record) == null, "a taxonomy record is accepted");
assert(
  validateOasf({ ...record, skills: [{ id: 1, name: "trading" } as { id: number }] }) != null,
  "free-text skills are rejected"
);
assert(validateOasf({ ...record, name: "collective.agent" }) != null, "the name must be https");

function chatMessage(partial: Partial<StoredChatMessage> & Pick<StoredChatMessage, "id" | "fromRole">): StoredChatMessage {
  return {
    clientId: null,
    platformId: "agt_test",
    fromWallet: partial.fromRole === "owner" ? "owner-wallet" : null,
    fromPlatformId: partial.fromRole === "agent" ? "agt_test" : null,
    text: "hello",
    replyExpected: partial.fromRole === "owner",
    answeredAt: null,
    replyToId: null,
    createdAt: 1,
    ...partial,
  };
}

const ownerView = chatView(chatMessage({ id: "m1", fromRole: "owner", fromWallet: "owner-wallet", text: "Come back" }));
assert(ownerView?.from.role === "owner" && ownerView.from.wallet === "owner-wallet", "an owner message is labeled owner");
const agentView = chatView(chatMessage({ id: "m2", fromRole: "agent" }));
assert(agentView?.from.role === "agent" && agentView.from.platformId === "agt_test", "an agent reply is labeled agent");
assert(chatView(chatMessage({ id: "m3", fromRole: "agent", fromPlatformId: "agt_other" })) == null, "a forged speaker is dropped");

const previous = chatView(chatMessage({ id: "old", fromRole: "owner", fromWallet: "previous-owner", replyExpected: true }));
const current = chatView(chatMessage({ id: "new", fromRole: "owner", fromWallet: "owner-wallet", replyExpected: true, createdAt: 2 }));
if (!previous || !current) throw new Error("both owner messages have a speaker");
const pending = pendingOwnerMessages([previous, current], "owner-wallet");
assert(pending.length === 1 && pending[0]?.id === "new", "only the current owner is waiting on a reply");

const waiting = chatMessage({ id: "keep", fromRole: "owner", createdAt: 0, replyExpected: true });
const filler = Array.from({ length: 80 }, (_, index) =>
  chatMessage({ id: `n${index}`, fromRole: "agent", createdAt: index + 1, replyExpected: false })
);
const trimmed = trimThread([waiting, ...filler]);
assert(trimmed.length === 80 && trimmed.some((row) => row.id === "keep"), "a waiting owner message survives the cap");

const first = chatMessage({ id: "once", fromRole: "owner", clientId: "same", text: "first" });
const duped = applyOwnerMessage([first], chatMessage({ id: "twice", fromRole: "owner", clientId: "same", text: "second" }));
assert(duped.saved.id === "once" && duped.messages.length === 1, "a repeated owner send stays one message");

const replied = applyAgentReply([first], chatMessage({ id: "reply", fromRole: "agent", replyToId: "once", createdAt: 5, text: "on it" }));
assert(replied.messages[0]?.answeredAt === 5, "the owner message is answered");
const replyView = chatView(replied.saved);
assert(replyView?.from.role === "agent", "the reply stays an agent message");
assert(pendingOwnerMessages(replied.messages.flatMap((row) => { const view = chatView(row); return view ? [view] : []; }), "owner-wallet").length === 0, "an answer clears the pending list");

let rejected = false;
try {
  applyAgentReply([chatMessage({ id: "self", fromRole: "agent" })], chatMessage({ id: "nope", fromRole: "agent", replyToId: "self" }));
} catch {
  rejected = true;
}
assert(rejected, "an agent cannot answer by pointing at its own message");
assert(closePending([first], 9)[0]?.answeredAt === 9, "an owner change closes waiting replies");

let tooLong = false;
try {
  parseChatText("x".repeat(1001));
} catch (error) {
  tooLong = error instanceof AgentsError && error.status === 400 && error.code === "INVALID_PARAMS";
}
assert(tooLong, "chat text is bounded");

const proposalPolicy = {
  ...defaultPolicy(),
  allowedActions: ["propose"],
  allowedPrograms: ["Gov111111111111111111111111111111111111111"],
  allowedRecipients: ["Recipient111111111111111111111111111111111"],
  perTxCapLamports: "2000000000",
  dailyBudgetLamports: "2000000000",
  maxPerMinute: 2,
};
const proposalBase = {
  action: "propose",
  programIds: ["Gov111111111111111111111111111111111111111"],
  mint: null,
  paused: false,
  spentTodayLamports: "0",
  actionsLastMinute: 0,
};
const proposalTransfer = evaluatePolicy(proposalPolicy, {
  ...proposalBase,
  amountLamports: "1000",
  recipient: "Recipient111111111111111111111111111111111",
  recipients: ["Recipient111111111111111111111111111111111", "Recipient111111111111111111111111111111111"],
  authorityChange: false,
  payment: true,
});
assert(proposalTransfer.allow && proposalTransfer.signer === "owner", "a proposal transfer is owner-signed");
const proposalStranger = evaluatePolicy(proposalPolicy, {
  ...proposalBase,
  amountLamports: "0",
  recipient: "Stranger1111111111111111111111111111111111",
  recipients: ["Stranger1111111111111111111111111111111111"],
  authorityChange: true,
  payment: true,
});
assert(!proposalStranger.allow, "a proposal recipient outside the allow list is denied");
const proposalAuthority = evaluatePolicy(proposalPolicy, {
  ...proposalBase,
  amountLamports: "0",
  recipient: null,
  authorityChange: true,
  payment: false,
});
assert(proposalAuthority.allow && proposalAuthority.signer === "owner", "a proposal authority change is owner-signed");

function sampleJob(over: Partial<Job> = {}): Job {
  const now = Date.now();
  return {
    id: "job_test",
    buyerPlatformId: "agt_b",
    sellerPlatformId: "agt_s",
    buyerOwner: "owner-b",
    sellerOwner: "owner-s",
    buyerWallet: "So11111111111111111111111111111111111111112",
    sellerWallet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    escrowWallet: "",
    channelId: "",
    depositPayload: "",
    fundSignature: "",
    fundPayloadHash: "",
    refundSignature: "",
    reviewReport: "",
    revisionNote: "",
    status: "offered",
    priceBaseUnits: "1000",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    deadline: now + 60_000,
    terms: "terms",
    proof: "subjective",
    expectedProof: "",
    deliveryNote: "",
    deliveryProof: "",
    deliveryFiles: [],
    deliveryHistory: [],
    approvalDigest: "",
    settlementSignature: "",
    settlementPayloadHash: "",
    rejectReason: "",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const now = Date.now();
const accepted = applyTurn(
  sampleJob(),
  {
    kind: "accept",
    buyerWallet: "So11111111111111111111111111111111111111112",
    sellerWallet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  now
);
let counterRefused = false;
try {
  applyTurn(
    accepted,
    {
      kind: "counter",
      priceBaseUnits: "2000",
      deadline: now + 60_000,
      terms: "later",
      proof: "subjective",
      expectedProof: "",
    },
    now
  );
} catch (error) {
  counterRefused = error instanceof AgentsError && error.code === "JOB_LOCKED";
}
assert(counterRefused && accepted.priceBaseUnits === "1000", "a counter after accept is refused");
assert(
  paymentMatches(
    {
      scheme: "upto",
      network: accepted.network,
      amount: accepted.priceBaseUnits,
      asset: accepted.mint,
      payTo: accepted.sellerWallet,
    },
    accepted
  ),
  "a 402 matches the locked price and seller wallet"
);
assert(
  !paymentMatches(
    { scheme: "upto", network: accepted.network, amount: "1", asset: accepted.mint, payTo: accepted.sellerWallet },
    accepted
  ),
  "a different amount is refused"
);
const funded = { ...accepted, fundSignature: "funded" };
const replaced = applyTurn(
  applyTurn(funded, { kind: "deliver", note: "first", deliveryProof: "" }, now),
  { kind: "deliver", note: "second", deliveryProof: "abc" },
  now + 1
);
assert(replaced.deliveryHistory.length === 0 && replaced.deliveryProof === "abc", "the first empty proof is not kept");
const hashed = applyTurn(
  { ...funded, proof: "hash", expectedProof: "a".repeat(64) },
  { kind: "deliver", note: "file", deliveryProof: "a".repeat(64) },
  now
);
const rewritten = applyTurn(hashed, { kind: "deliver", note: "file", deliveryProof: "b".repeat(64) }, now + 1);
assert(rewritten.deliveryHistory[0] === "a".repeat(64), "replacing a delivery keeps the previous hash");

const sameOwner = sampleJob({ status: "settled", buyerOwner: "same", sellerOwner: "same", priceBaseUnits: "9" });
const counted = sampleJob({
  id: "job_counted",
  status: "settled",
  buyerOwner: "owner-b",
  sellerOwner: "owner-s",
  priceBaseUnits: "4",
});
const score = reputationForAgent([sameOwner, counted], "agt_b");
assert(score.settled === 1 && score.volumeBaseUnits === "4" && !score.badge, "a same-owner settlement is excluded from the score");
const late = fresh(sampleJob({ status: "delivered", deadline: now - 1 }), now);
assert(reputationForAgent([late], "agt_b").unanswered === 1, "an unpaid delivery past the deadline is unanswered");
const badgeJobs = ["c", "d", "e"].map((owner, index) =>
  sampleJob({
    id: `job_badge_${index}`,
    status: "settled",
    sellerOwner: owner,
    sellerPlatformId: `agt_${owner}`,
  })
);
const badge = reputationForAgent(badgeJobs, "agt_b");
assert(badge.badge && badge.settled === 3 && badge.counterpartOwners === 3, "three settled jobs with three owners earn the badge");
assert(!reputationForAgent(badgeJobs.slice(0, 2), "agt_b").badge, "two owners wait for a badge");
const ownerScore = reputationForOwner([sameOwner, counted], "owner-b");
assert(ownerScore.settled === 1, "the owner tally also excludes a same-owner job");
assert(reputationForAgent([], "agt_b").history === "none", "a new agent shows no history");

console.log("agents policy checks passed");
