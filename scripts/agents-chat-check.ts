/**
 * Owner-agent inbox: speaker labels, pending replies, and who may post.
 * Run: npx tsx --conditions=react-server hire/scripts/agents-chat-check.ts
 *
 * Uses the in-memory store. Skips if Firestore is configured so it never
 * writes a thread to a real project.
 */
import crypto from "crypto";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import bs58 from "bs58";
import { NextRequest } from "next/server";
import { guardAgent } from "../../lib/agent/guard";
import { sha256Hex } from "../src/server/crypto";
import { byokSecretName } from "../src/server/modal-policy";
import { resetModelTurns } from "../src/server/providers";
import { handleAgentsRequest } from "../src/server/router";
import { useSandboxRuntime } from "../src/server/sandbox";
import { useOwnerThread } from "../src/server/xmtp-thread";
import { useX402Facilitator } from "../src/server/x402";
import { agentStore, type StoredAction, type StoredAgent } from "../src/server/store";

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const owner = "Owner1111111111111111111111111111111111111";
const platformId = "agt_chat_check";

function request(method: string, path: string, token: string | null, body?: unknown): NextRequest {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (body) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost/api/agents/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await handleAgentsRequest(request(method, path, token, body), method, path.split("/").filter(Boolean));
  const json = (await res.json()) as {
    error?: { code?: string; message?: string };
    message?: { id: string; from: { role: string; wallet?: string; platformId?: string } };
    pending?: { id: string; from: { role: string; wallet?: string } }[];
    messages?: { id: string; from: { role: string; wallet?: string; platformId?: string }; text: string }[];
    owner?: string;
    wake?: string;
    nonce?: string;
    reply?: { text: string };
  };
  return { status: res.status, json };
}

async function main(): Promise<void> {
  if (process.env.FIREBASE_SERVICE_ACCOUNT?.trim() || process.env.NODE_ENV === "production") {
    console.log("agents chat route check skipped");
    return;
  }

  useOwnerThread("memory");
  const now = Date.now();
  const agent: StoredAgent = {
    platformId,
    owner,
    name: "Chat",
    endpoint: null,
    endpointVerifiedAt: null,
    walletAddress: "Wallet11111111111111111111111111111111111",
    walletProvider: "privy",
    providerWalletId: "privy-wallet",
    retiredWallets: [],
    status: "active",
    slimName: null,
    directoryCid: null,
    oasf: null,
    runtimePublicKey: null,
    signCredentialIssuedAt: null,
    claimNonce: null,
    createdAt: now,
    updatedAt: now,
  };
  await agentStore().saveAgent(agent);
  const other: StoredAgent = { ...agent, platformId: "agt_chat_other", name: "Other" };
  await agentStore().saveAgent(other);

  async function secret(token: string, kind: "owner-session" | "credential", subject: string) {
    const hash = sha256Hex(token);
    await agentStore().putSecret(hash, {
      kind,
      hash,
      platformId: kind === "credential" ? subject : "",
      owner: kind === "owner-session" ? subject : owner,
      expiresAt: now + 60 * 60_000,
      revokedAt: null,
      createdAt: now,
    });
  }
  await secret("own_chat_check", "owner-session", owner);
  await secret("cag_chat_check", "credential", platformId);
  await secret("cag_other_check", "credential", "agt_chat_other");

  let taught = "";
  const taughtPaths: string[] = [];
  useSandboxRuntime({
    async ensure() {
      return { name: "agent-test", domains: ["api.openai.com"] };
    },
    async exec(_owner, task) {
      taught = JSON.stringify(task.body);
      taughtPaths.push(task.path);
      if (task.path === "/v1/images/generations") {
        return { stdout: '200\n{"data":[{"url":"https://cdn.example.com/fox.png"}]}', exitCode: 0 };
      }
      if (task.mode === "transcribe") {
        return { stdout: '200\n{"transcript":"hello there"}', exitCode: 0 };
      }
      if (task.path === "/v1/responses") {
        const model = (task.body as { model?: unknown }).model;
        if (model === "sam-3.1") {
          return { stdout: '200\n{"output":[{"content":[{"text":"box 1,2 to 3,4"}]}]}', exitCode: 0 };
        }
        return {
          stdout: '200\n{"output":[{"type":"message","content":[{"type":"output_text","text":"All quiet."}]}]}',
          exitCode: 0,
        };
      }
      return { stdout: '200\n{"choices":[{"message":{"content":"All quiet."}}]}', exitCode: 0 };
    },
    async updatePolicy() {},
    async terminate() {},
  });
  await agentStore().saveWorkspace({
    platformId,
    version: 1,
    bootstrapComplete: true,
    updatedAt: now,
    files: {
      "IDENTITY.md": { content: "Name: Desk.", updatedAt: now },
      "AGENTS.md": { content: "Follow the desk.", updatedAt: now },
      "skills/watch/SKILL.md": {
        content: "---\nname: watch\ndescription: Report status in one line.\nenabled: true\n---\nFULL-SKILL-BODY\n",
        updatedAt: now,
      },
    },
  });
  await agentStore().saveProvider({
    owner,
    provider: "openai",
    secretName: byokSecretName(owner, "openai"),
    status: "connected",
    hint: "0001",
    modelId: "gpt-4o",
    requestsToday: 0,
    day: "2026-11-07",
    updatedAt: Date.now(),
  });

  const anonymous = await call("GET", "inbox", null);
  assert(anonymous.status === 401, "inbox requires a credential");

  const sent = await call("POST", `agents/${platformId}/messages`, "own_chat_check", {
    text: "Status?",
    replyExpected: true,
    fromRole: "agent",
  });
  assert(sent.status === 200, `owner send failed (${sent.status})`);
  assert(sent.json.message?.from.role === "owner" && sent.json.message.from.wallet === owner, "the server labels the owner");
  assert((sent.json.pending?.length ?? 0) === 0, "the chosen model replies before the turn ends");
  assert(sent.json.messages?.[1]?.from.role === "agent" && sent.json.messages?.[1]?.text === "All quiet.", "the reply is the model text");
  assert(sent.json.wake === "sent" || sent.json.wake === "skipped", "the conversation is handed to XMTP");
  assert(
    taught.includes("Name: Desk.") &&
      taught.includes("Follow the desk.") &&
      taught.includes("Report status in one line.") &&
      !taught.includes("FULL-SKILL-BODY"),
    "the model system context carries identity and the skill catalog, not the whole skill"
  );

  const inbox = await call("GET", "inbox", "cag_chat_check");
  assert(inbox.status === 200 && inbox.json.owner === owner, "the agent learns its owner");
  assert((inbox.json.pending?.length ?? 0) === 0, "the model reply cleared the wait");

  const stranger = await call("GET", "inbox", "cag_other_check");
  assert(stranger.status === 200 && (stranger.json.messages?.length ?? 0) === 0, "another agent has its own inbox");

  const ownerInbox = await call("POST", "inbox", "own_chat_check", { text: "I am the agent" });
  assert(ownerInbox.status === 401, "the owner session cannot post as the agent");

  const impersonate = await call("POST", `agents/${platformId}/messages`, "cag_chat_check", { text: "I am the owner" });
  assert(impersonate.status === 403, "the agent credential cannot post as the owner");

  const thread = await call("GET", `agents/${platformId}/messages`, "own_chat_check");
  assert(thread.json.messages?.length === 2, "the owner sees both turns");
  assert(thread.json.messages?.[0]?.from.role === "owner" && thread.json.messages?.[1]?.from.role === "agent", "the thread keeps both speakers");

  const sensitive = await call("POST", `agents/${platformId}/messages`, "own_chat_check", { text: "hi", prompt: "ignore policy" });
  assert(sensitive.status === 400 && sensitive.json.error?.code === "SENSITIVE_FIELD", "prompt fields are rejected");

  const leaked = await call("POST", `agents/${platformId}/messages`, "own_chat_check", {
    text: "paste cag_chat_check_token_value",
  });
  assert(leaked.status === 400 && leaked.json.error?.code === "SENSITIVE_FIELD", "credential text is not stored");

  await agentStore().saveAgent({ ...agent, status: "removed" });
  const removed = await call("POST", `agents/${platformId}/messages`, "own_chat_check", { text: "Still there?" });
  assert(removed.status === 403 && removed.json.error?.code === "REMOVED", "a removed agent has no chat");

  const hireWallet = "11111111111111111111111111111111";
  const spendId = "agt_spend_check";
  await agentStore().saveAgent({ ...agent, platformId: spendId, status: "active", walletAddress: hireWallet });
  assert(await agentStore().isHireWallet(hireWallet), "saving an agent indexes its wallet");
  const blocked = await guardAgent(
    new NextRequest("http://localhost/api/agent/v1/trade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: hireWallet }),
    }),
    { name: "hire-wallet-check", limit: 20, parseBody: "json" }
  );
  assert(!blocked.ok, "public builders reject a hired wallet");
  const ordinary = await guardAgent(
    new NextRequest("http://localhost/api/agent/v1/trade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }),
    }),
    { name: "ordinary-wallet-check", limit: 20, parseBody: "json" }
  );
  assert(ordinary.ok, "an ordinary wallet still reaches the builder");

  const claimId = "agt_claim_check";
  await agentStore().saveAgent({
    ...agent,
    platformId: claimId,
    status: "pending_credential",
    claimNonce: "nonce-once",
    walletAddress: hireWallet,
  });
  const claimed = await agentStore().claimRuntime({
    platformId: claimId,
    nonce: "nonce-once",
    publicKey: "runtime-key",
    secret: {
      kind: "credential",
      hash: "claim-hash",
      platformId: claimId,
      owner,
      expiresAt: now + 60_000,
      revokedAt: null,
      createdAt: now,
    },
  });
  assert(claimed.claimNonce === null && claimed.status === "active", "claim clears the nonce once");
  let claimedTwice = false;
  try {
    await agentStore().claimRuntime({
      platformId: claimId,
      nonce: "nonce-once",
      publicKey: "other-key",
      secret: {
        kind: "credential",
        hash: "claim-hash-2",
        platformId: claimId,
        owner,
        expiresAt: now + 60_000,
        revokedAt: null,
        createdAt: now,
      },
    });
  } catch {
    claimedTwice = true;
  }
  assert(claimedTwice, "a second claim of the same nonce fails");

  for (let index = 0; index < 45; index += 1) {
    await agentStore().putSecret(`cred-${index}`, {
      kind: "credential",
      hash: `cred-${index}`,
      platformId: claimId,
      owner,
      expiresAt: now + 60_000,
      revokedAt: index < 3 ? now : null,
      createdAt: now,
    });
  }
  const live = await agentStore().listActiveCredentials(claimId);
  assert(live.length === 43, "active credentials are listed past the old 40-row page");

  for (let index = 0; index < 51; index += 1) {
    const row: StoredAction = {
      id: `act-spend-${index}`,
      platformId: spendId,
      name: "pay",
      status: "pending_agent",
      risk: "high",
      signer: "owner",
      payloadHash: "hash",
      unsignedTransactions: [],
      request: {},
      amountLamports: "10",
      simulationPassed: true,
      idempotencyKey: `spend-key-${index}`,
      launchNonce: null,
      launchMint: null,
      launchStep: null,
      confirmedSteps: 0,
      lookupTables: [],
      signature: null,
      verified: false,
      createdAt: now,
      expiresAt: now + 60_000,
    };
    await agentStore().saveAction(row);
  }
  const usage = await agentStore().readUsage(spendId);
  assert(usage.spentTodayLamports === "510", "daily spend sums every open action");
  await agentStore().expirePending(spendId);
  const after = await agentStore().readUsage(spendId);
  assert(after.spentTodayLamports === "0", "pause or policy expiry releases the reserved spend");

  const savedEnv = {
    network: process.env.X402_NETWORK,
    asset: process.env.X402_ASSET,
    facilitator: process.env.X402_FACILITATOR_URL,
    devnetFacilitator: process.env.X402_DEVNET_FACILITATOR_URL,
    feeSecret: process.env.X402_FEE_PAYER,
    authorizerSecret: process.env.X402_RECEIVER_AUTHORIZER,
    testFee: process.env.X402_TEST_FEE_PAYER,
    testAuthorizer: process.env.X402_TEST_RECEIVER_AUTHORIZER,
    supervisor: process.env.HIRE_SUPERVISOR_PLATFORM_ID,
    slim: process.env.SLIM_HTTP_URL,
    escrow: process.env.X402_ESCROW_ADDRESS,
    signer: process.env.X402_ESCROW_SIGNER,
    xmtp: process.env.XMTP_ENV,
  };
  process.env.X402_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  process.env.X402_ASSET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  delete process.env.X402_FACILITATOR_URL;
  delete process.env.X402_DEVNET_FACILITATOR_URL;
  process.env.HIRE_SUPERVISOR_PLATFORM_ID = "agt_job_supervisor";
  delete process.env.X402_FEE_PAYER;
  delete process.env.X402_RECEIVER_AUTHORIZER;
  delete process.env.X402_TEST_FEE_PAYER;
  delete process.env.X402_TEST_RECEIVER_AUTHORIZER;
  const channelNetwork = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as Network;
  const channelFacilitator: FacilitatorClient = {
    async verify() {
      return { isValid: false, invalidReason: "rejected" };
    },
    async settle(_payload, requirements) {
      return {
        success: false,
        transaction: "",
        network: requirements.network,
        errorReason: "rejected",
        errorMessage: "The facilitator did not settle the payment.",
        payer: "",
      };
    },
    async getSupported() {
      return {
        kinds: [
          {
            x402Version: 2,
            scheme: "upto",
            network: channelNetwork,
            extra: {
              feePayer: "11111111111111111111111111111111",
              receiverAuthorizer: "SysvarRent111111111111111111111111111111111",
            },
          },
        ],
        extensions: [],
        signers: {},
      };
    },
  };
  useX402Facilitator(channelFacilitator);
  delete process.env.SLIM_HTTP_URL;
  delete process.env.XMTP_ENV;
  delete process.env.X402_ESCROW_ADDRESS;
  delete process.env.X402_ESCROW_SIGNER;
  try {
    const buyerKeys = crypto.generateKeyPairSync("ed25519");
    const buyerDer = buyerKeys.publicKey.export({ type: "spki", format: "der" });
    const buyerOwner = bs58.encode(buyerDer.subarray(buyerDer.length - 32));
    const signOwner = (message: string) => bs58.encode(crypto.sign(null, Buffer.from(message, "utf8"), buyerKeys.privateKey));
    const buyerId = "agt_job_buyer";
    const sellerId = "agt_job_seller";
    const buyerWallet = "So11111111111111111111111111111111111111112";
    const sellerWallet = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const buyer: StoredAgent = {
      ...agent,
      platformId: buyerId,
      owner: buyerOwner,
      name: "Buyer",
      status: "active",
      walletAddress: buyerWallet,
    };
    const seller: StoredAgent = {
      ...agent,
      platformId: sellerId,
      owner: "seller-owner",
      name: "Seller",
      status: "active",
      walletAddress: sellerWallet,
    };
    const supervisor: StoredAgent = {
      ...agent,
      platformId: "agt_job_supervisor",
      owner: "supervisor-owner",
      name: "Supervisor",
      status: "active",
      walletAddress: "SysvarRent111111111111111111111111111111111",
    };
    await agentStore().saveAgent(buyer);
    await agentStore().saveAgent(seller);
    await agentStore().saveAgent(supervisor);
    await agentStore().saveProvider({
      owner: "supervisor-owner",
      provider: "openai",
      secretName: "byok-supervisor-openai",
      status: "connected",
      hint: "test",
      modelId: "gpt-4o",
      requestsToday: 0,
      day: "2026-11-08",
      updatedAt: Date.now(),
    });
    await secret("own_job_buyer", "owner-session", buyerOwner);
    await secret("cag_job_buyer", "credential", buyerId);
    await secret("cag_job_seller", "credential", sellerId);
    const grantedAt = Date.now();
    await agentStore().saveGrant({ platformId: sellerId, callerPlatformId: buyerId, allowed: true, updatedAt: grantedAt });
    await agentStore().saveGrant({ platformId: buyerId, callerPlatformId: sellerId, allowed: true, updatedAt: grantedAt });
    await agentStore().savePolicy({
      platformId: buyerId,
      perTxCapLamports: "1000000",
      dailyBudgetLamports: "1000000",
      allowedActions: ["pay"],
      allowedPrograms: [],
      allowedRecipients: [sellerWallet],
      allowedMints: [usdc],
      maxPerMinute: 10,
      updatedAt: grantedAt,
    });

    async function jobCall(method: string, path: string, token: string, body?: unknown, extra?: Record<string, string>) {
      const headers = new Headers();
      headers.set("authorization", `Bearer ${token}`);
      if (body) headers.set("content-type", "application/json");
      if (extra) for (const [key, value] of Object.entries(extra)) headers.set(key, value);
      const res = await handleAgentsRequest(
        new NextRequest(`http://localhost/api/agents/v1/${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        }),
        method,
        path.split("/").filter(Boolean)
      );
      const json = (await res.json()) as {
        error?: { code?: string; message?: string };
        job?: {
          id: string;
          status: string;
          priceBaseUnits: string;
          mint: string;
          sellerWallet: string;
          termsDigest: string;
          deliveryNote?: string;
          reviewReport?: string;
          settlementSignature?: string;
        };
        delivery?: { note?: string };
        wake?: string;
        jobs?: { id: string }[];
        message?: { id: string; text?: string };
        messages?: { id: string; text: string }[];
        jobCount?: number;
      };
      return { status: res.status, json, paymentRequired: res.headers.get("PAYMENT-REQUIRED") };
    }

    const deadline = Date.now() + 60 * 60_000;
    const secretOffer = await jobCall("POST", "jobs", "cag_job_buyer", {
      toPlatformId: sellerId,
      priceBaseUnits: "1000",
      deadline,
      terms: "cag_abcdefghijklmnopqrstuvwxyz",
      proof: "subjective",
    });
    assert(secretOffer.status === 400, "secret negotiation text is rejected");

    const offered = await jobCall("POST", "jobs", "cag_job_buyer", {
      toPlatformId: sellerId,
      priceBaseUnits: "1000",
      deadline,
      terms: "Write the note.",
      proof: "subjective",
    });
    await agentStore().saveProvider({
      owner: "seller-owner",
      provider: "openai",
      secretName: byokSecretName("seller-owner", "openai"),
      status: "connected",
      hint: "0001",
      modelId: "gpt-4o",
      requestsToday: 0,
      day: "2026-11-07",
      updatedAt: Date.now(),
    });
    const peer = await jobCall("POST", `agents/${buyerId}/peers/${sellerId}/messages`, "cag_job_buyer", {
      text: "Hello from the buyer agent.",
    });
    assert(peer.status === 200 && Boolean(peer.json.message?.id), "an agent-to-agent message is stored");
    assert(peer.json.jobCount === 1, "an agent-to-agent message does not open a job");
    const peerThread = await jobCall("GET", `agents/${buyerId}/peers/${sellerId}/messages`, "cag_job_buyer");
    assert((peerThread.json.messages?.length ?? 0) === 2, "the peer thread keeps the message and the model reply");
    assert(peerThread.json.messages?.[1]?.text === "All quiet.", "the other agent replies with its owner's model");

    assert(offered.status === 200 && offered.json.job?.status === "offered", "the offer is stored");
    assert(offered.json.wake === "sent" || offered.json.wake === "skipped", "an XMTP wake is reported");
    const jobId = offered.json.job?.id ?? "";
    const countered = await jobCall("POST", `jobs/${jobId}`, "cag_job_seller", {
      kind: "counter",
      priceBaseUnits: "2500",
      deadline,
      terms: "Write the shorter note.",
      proof: "subjective",
    });
    assert(countered.status === 200 && countered.json.job?.priceBaseUnits === "2500", "a counter replaces the open price");
    const accepted = await jobCall("POST", `jobs/${jobId}`, "cag_job_buyer", { kind: "accept" });
    assert(accepted.status === 200 && accepted.json.job?.status === "accepted", "accept locks the job");
    assert(accepted.json.job?.sellerWallet === sellerWallet, "accept freezes the seller wallet");
    const tooSoon = await jobCall("POST", `jobs/${jobId}`, "cag_job_seller", { kind: "deliver", note: "Too soon." });
    assert(tooSoon.status === 409, "accept does not pay, and delivery waits for the channel deposit");
    const fund = await jobCall("GET", `jobs/${jobId}/escrow`, "cag_job_buyer");
    assert(fund.status === 402 && Boolean(fund.paymentRequired), "payment is a 402 until the channel deposit settles");
    const ownerFund = await jobCall("GET", `jobs/${jobId}/escrow`, "own_job_buyer");
    assert(ownerFund.status === 402 && Boolean(ownerFund.paymentRequired), "the buyer owner can open the same channel");
    const fundRequired = decodePaymentRequiredHeader(fund.paymentRequired ?? "");
    const fundAccepts = fundRequired.accepts[0];
    assert(fundAccepts?.payTo === sellerWallet && fundAccepts.asset === usdc, "the channel payee is the seller wallet in USDC");
    assert(fundAccepts?.scheme === "upto" && fundAccepts.amount === "2500", "the 402 amount is the locked price");
    assert(fundAccepts?.extra?.paymentFlow === "escrow", "the 402 uses the x402 escrow flow");
    assert(fundAccepts?.extra?.feePayer === buyerOwner, "the buyer owner signs the channel fee");
    assert(fundAccepts?.extra?.receiverAuthorizer === buyerOwner, "the buyer owner signs the release voucher");
    const signature = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: fundRequired.resource,
      accepted: fundAccepts!,
      payload: { transaction: "unsigned" },
    });
    const unpaid = await jobCall("GET", `jobs/${jobId}/escrow`, "cag_job_buyer", undefined, { "PAYMENT-SIGNATURE": signature });
    assert(unpaid.status === 402 && unpaid.json.error?.code === "PAYMENT_INVALID", "a refused deposit does not pretend the payment settled");
    const stillOpen = await agentStore().getJob(jobId);
    assert(stillOpen?.status === "accepted" && stillOpen.fundSignature === "", "a failed settle leaves the job unpaid");
    await agentStore().saveJob({
      ...stillOpen!,
      fundSignature: "buyer-paid",
      channelId: "11111111111111111111111111111111",
      depositPayload: JSON.stringify({
        x402Version: 2,
        accepted: fundAccepts,
        payload: { channelId: "11111111111111111111111111111111", type: "deposit" },
      }),
    });
    const late = await jobCall("POST", `jobs/${jobId}`, "cag_job_seller", {
      kind: "counter",
      priceBaseUnits: "9000",
      deadline,
      terms: "Too late.",
      proof: "subjective",
    });
    assert(late.status === 409 && late.json.error?.code === "JOB_LOCKED", "a counter after accept is refused");
    const delivered = await jobCall("POST", `jobs/${jobId}`, "cag_job_seller", {
      kind: "deliver",
      note: "The note.",
    });
    assert(delivered.status === 200 && delivered.json.job?.status === "delivered", "delivery is stored");
    assert(delivered.json.job?.deliveryNote === "The note.", "the seller still sees the delivery");
    const sealed = await jobCall("GET", `jobs/${jobId}`, "cag_job_buyer");
    assert(sealed.status === 200 && !sealed.json.delivery && sealed.json.job?.deliveryNote === "", "the buyer cannot read the delivery before acceptance");
    assert(sealed.json.job?.reviewReport === "All quiet.", "the supervisor report is the only delivery text the buyer sees");
    const revised = await jobCall("POST", `jobs/${jobId}`, "cag_job_buyer", { kind: "revise", note: "Tighten the ending." });
    assert(revised.status === 200 && revised.json.job?.status === "accepted", "a revision returns the job to work");
    assert(revised.json.job?.settlementSignature == null || revised.json.job?.settlementSignature === "", "a revision does not release the channel");
    const againDelivered = await jobCall("POST", `jobs/${jobId}`, "cag_job_seller", { kind: "deliver", note: "The note." });
    assert(againDelivered.status === 200 && againDelivered.json.job?.reviewReport === "All quiet.", "the supervisor reviews the revised delivery");
    const digest = againDelivered.json.job?.termsDigest ?? "";
    const nonce = await call("POST", "owner-nonce", "own_job_buyer", {
      purpose: "approve-job",
      platformId: buyerId,
      extra: `job ${jobId} ${digest}`,
    });
    const unreleased = await jobCall("POST", `jobs/${jobId}/approve`, "own_job_buyer", {
      platformId: buyerId,
      nonce: nonce.json.nonce,
      signature: signOwner(String((nonce.json as { message?: string }).message ?? "")),
      jobId,
    });
    assert(unreleased.status === 402 && unreleased.json.error?.code === "PAYMENT_INVALID", "acceptance does not release when the channel deposit is not on chain");
    assert(!unreleased.json.delivery, "a failed release keeps the delivery sealed");

    const mismatch = await jobCall("POST", "jobs", "cag_job_buyer", {
      toPlatformId: sellerId,
      priceBaseUnits: "1000",
      deadline,
      terms: "Match this hash.",
      proof: "hash",
      expectedProof: "a".repeat(64),
    });
    const mismatchId = mismatch.json.job?.id ?? "";
    await jobCall("POST", `jobs/${mismatchId}`, "cag_job_seller", { kind: "accept" });
    const mismatchOpen = await agentStore().getJob(mismatchId);
    mismatchOpen!.fundSignature = "escrow-funded";
    await agentStore().saveJob(mismatchOpen!);
    await jobCall("POST", `jobs/${mismatchId}`, "cag_job_seller", {
      kind: "deliver",
      note: "Wrong file.",
      deliveryProof: "b".repeat(64),
    });
    const refused = await jobCall("GET", `jobs/${mismatchId}`, "cag_job_buyer");
    assert(refused.status === 409 && refused.json.error?.code === "PROOF_MISMATCH", "a hash mismatch never becomes a payment requirement");
    assert(!refused.paymentRequired, "a mismatched delivery has no 402 header");
    const agentRefund = await jobCall("POST", `jobs/${mismatchId}`, "cag_job_buyer", { kind: "reject", reason: "Wrong file." });
    assert(agentRefund.status === 503 && agentRefund.json.error?.code === "FACILITATOR_UNCONFIGURED", "reject does not mark the job rejected when the channel deposit is not stored");
    const stillDelivered = await agentStore().getJob(mismatchId);
    assert(stillDelivered?.status === "delivered", "a failed channel close leaves the delivery in place");

    const paid = await agentStore().getJob(jobId);
    await agentStore().saveJob({ ...paid!, status: "settled", settlementSignature: "buyer-paid" });
    const opened = await jobCall("GET", `jobs/${jobId}`, "cag_job_buyer");
    assert(opened.status === 200 && opened.json.delivery?.note === "The note.", "acceptance is the only release of the delivery");
    const again = await jobCall("GET", `jobs/${jobId}/escrow`, "cag_job_buyer", undefined, { "PAYMENT-SIGNATURE": signature });
    assert(again.status === 409 && again.json.error?.code === "SETTLEMENT_EXISTS", "a second payment is refused");

    const rawPay = await call("POST", "actions/pay", "cag_job_buyer", {
      idempotencyKey: "raw-sol-pay",
      recipient: sellerWallet,
      asset: "SOL",
      amountLamports: "1000",
      expiry: Date.now() + 60_000,
    });
    assert(rawPay.status === 400 && (rawPay.json.error?.message ?? "").includes("SOL"), "a raw SOL pay is refused");
    const doneWord = await jobCall("POST", `jobs/${jobId}`, "cag_job_seller", { kind: "complete" });
    assert(doneWord.status === 400, "a complete turn does not mark the job done");
    const complete = await call("POST", "tasks", "cag_job_buyer", {
      toPlatformId: sellerId,
      kind: "complete",
      text: "done",
    });
    assert(complete.status === 400 && (complete.json.error?.message ?? "").includes("complete"), "a free-form complete is refused");
    const chatJobs = await jobCall("GET", `agents/${platformId}/jobs`, "own_chat_check");
    assert(chatJobs.status === 200 && (chatJobs.json.jobs?.length ?? 0) === 0, "owner chat does not open a job");
    await agentStore().cancelOpenJobs(buyerId);
    const cancelled = await agentStore().getJob(mismatchId);
    const settled = await agentStore().getJob(jobId);
    assert(cancelled?.status === "cancelled", "pause, remove, or transfer cancels an open job");
    const refund = await jobCall("GET", `jobs/${mismatchId}/refund`, "cag_job_buyer");
    assert(refund.status === 503 && refund.json.error?.code === "FACILITATOR_UNCONFIGURED", "a funded cancel does not refund when the channel deposit is not stored");
    assert(!refund.json.delivery, "a refund does not reveal the delivery");
    assert(settled?.status === "settled", "a settled receipt stays settled when open jobs are cancelled");
  } finally {
    if (savedEnv.network === undefined) delete process.env.X402_NETWORK;
    else process.env.X402_NETWORK = savedEnv.network;
    if (savedEnv.asset === undefined) delete process.env.X402_ASSET;
    else process.env.X402_ASSET = savedEnv.asset;
    useX402Facilitator(null);
    if (savedEnv.facilitator === undefined) delete process.env.X402_FACILITATOR_URL;
    else process.env.X402_FACILITATOR_URL = savedEnv.facilitator;
    if (savedEnv.devnetFacilitator === undefined) delete process.env.X402_DEVNET_FACILITATOR_URL;
    else process.env.X402_DEVNET_FACILITATOR_URL = savedEnv.devnetFacilitator;
    if (savedEnv.feeSecret === undefined) delete process.env.X402_FEE_PAYER;
    else process.env.X402_FEE_PAYER = savedEnv.feeSecret;
    if (savedEnv.authorizerSecret === undefined) delete process.env.X402_RECEIVER_AUTHORIZER;
    else process.env.X402_RECEIVER_AUTHORIZER = savedEnv.authorizerSecret;
    if (savedEnv.testFee === undefined) delete process.env.X402_TEST_FEE_PAYER;
    else process.env.X402_TEST_FEE_PAYER = savedEnv.testFee;
    if (savedEnv.testAuthorizer === undefined) delete process.env.X402_TEST_RECEIVER_AUTHORIZER;
    else process.env.X402_TEST_RECEIVER_AUTHORIZER = savedEnv.testAuthorizer;
    if (savedEnv.supervisor === undefined) delete process.env.HIRE_SUPERVISOR_PLATFORM_ID;
    else process.env.HIRE_SUPERVISOR_PLATFORM_ID = savedEnv.supervisor;
    if (savedEnv.slim === undefined) delete process.env.SLIM_HTTP_URL;
    else process.env.SLIM_HTTP_URL = savedEnv.slim;
    if (savedEnv.escrow === undefined) delete process.env.X402_ESCROW_ADDRESS;
    else process.env.X402_ESCROW_ADDRESS = savedEnv.escrow;
    if (savedEnv.signer === undefined) delete process.env.X402_ESCROW_SIGNER;
    else process.env.X402_ESCROW_SIGNER = savedEnv.signer;
    if (savedEnv.xmtp === undefined) delete process.env.XMTP_ENV;
    else process.env.XMTP_ENV = savedEnv.xmtp;
  }

  resetModelTurns();
  await agentStore().saveAgent({ ...agent, platformId: "agt_muse_chat", status: "active", name: "Muse" });
  await agentStore().saveAgent({ ...agent, platformId: "agt_muse_peer", status: "active", name: "Muse peer" });
  await secret("cag_muse_chat", "credential", "agt_muse_chat");
  await agentStore().saveProvider({
    owner,
    provider: "muse",
    secretName: byokSecretName(owner, "muse"),
    status: "connected",
    hint: "muse",
    modelId: "muse-image-1.0",
    requestsToday: 0,
    day: "2026-11-08",
    updatedAt: Date.now() + 10_000,
  });
  const imageChat = await call("POST", "agents/agt_muse_chat/messages", "own_chat_check", {
    text: "Draw a red fox",
    replyExpected: true,
  });
  const imageReply = imageChat.json.messages?.find((message) => message.from.role === "agent")?.text ?? "";
  assert(imageChat.status === 200 && imageReply.includes("All quiet.") && imageReply.includes("https://cdn.example.com/fox.png"), "owner chat with Muse Image answers in words and adds the picture");
  assert(taughtPaths.includes("/v1/chat/completions") && taughtPaths.includes("/v1/images/generations"), "Muse Image chat talks, then generates");
  const imagePeer = await call("POST", "agents/agt_muse_chat/peers/agt_muse_peer/messages", "cag_muse_chat", {
    text: "Draw a red fox",
  });
  assert(imagePeer.status === 200 && (imagePeer.json.reply?.text ?? "").includes("All quiet."), "agent-to-agent chat with Muse Image answers");
  await agentStore().saveProvider({
    owner,
    provider: "muse",
    secretName: byokSecretName(owner, "muse"),
    status: "connected",
    hint: "muse",
    modelId: "muse-voice-transcribe-1.0",
    requestsToday: 0,
    day: "2026-11-08",
    updatedAt: Date.now() + 20_000,
  });
  const talk = await call("POST", "agents/agt_muse_chat/messages", "own_chat_check", {
    text: "Can you hear me?",
    replyExpected: true,
  });
  const talkReply = talk.json.messages?.filter((message) => message.from.role === "agent").at(-1)?.text ?? "";
  assert(talk.status === 200 && talkReply === "All quiet.", "owner chat with Muse Transcription answers without a recording");
  const heard = await call("POST", "agents/agt_muse_peer/messages", "own_chat_check", {
    text: "Listen https://cdn.example.com/note.wav",
    replyExpected: true,
  });
  assert(heard.status === 200, `transcription chat failed (${heard.status} ${heard.json.error?.message ?? ""})`);
  assert(taughtPaths.some((path) => path.startsWith("/v1/asr/transcribe")), "a WAV link is transcribed inside the chat");
  await agentStore().saveProvider({
    owner,
    provider: "muse",
    secretName: byokSecretName(owner, "muse"),
    status: "connected",
    hint: "muse",
    modelId: "sam-3.1",
    requestsToday: 0,
    day: "2026-11-08",
    updatedAt: Date.now() + 30_000,
  });
  const samChat = await call("POST", "agents/agt_muse_chat/peers/agt_muse_peer/messages", "cag_muse_chat", {
    text: "yellow school bus https://cdn.example.com/street.png",
  });
  assert(samChat.status === 200 && (samChat.json.reply?.text ?? "").includes("All quiet.") && taughtPaths.includes("/v1/responses"), "agent-to-agent chat with Muse SAM answers and segments");

  useSandboxRuntime(null);
  console.log("agents chat route check passed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
