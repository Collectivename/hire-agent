import "server-only";
import { randomId } from "./crypto";
import { applyTurn, type Job } from "./jobs";
import { secretMaterial } from "./messages";
import { toolCallsInText } from "./owner-ask";
import { chosenModelForAgent, noteModelTurn } from "./providers";
import { museTalkModel, runModel, type ModelTool } from "./sandbox";
import { agentStore } from "./store";
import { pairId } from "./xmtp";

const REPLY_TOOL: ModelTool = {
  name: "offer_reply",
  description: "Accept or decline this hire now.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["accept", "decline"] },
      reason: { type: "string" },
    },
    required: ["action", "reason"],
  },
};

const inflight = new Map<string, Promise<OfferAnswer>>();

export type OfferAnswer = { job: Job; line: string };

function cleanReason(action: "accept" | "decline", value: unknown): string {
  const fallback = action === "accept" ? "I'll take it." : "I can't take this.";
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text || secretMaterial(text)) return fallback;
  return text.slice(0, 280);
}

/** The hired agent's accept or decline, from a tool call or a JSON object in the text. */
export function parseOfferReply(
  text: string,
  calls: { name: string; arguments: string }[]
): { action: "accept" | "decline"; reason: string } | null {
  const found = calls.length ? calls : toolCallsInText(text).calls;
  const call = found.find((item) => item.name === "offer_reply" || item.name.endsWith(":offer_reply"));
  let record: Record<string, unknown> | null = null;
  if (call) {
    try {
      const parsed = JSON.parse(call.arguments) as unknown;
      if (parsed && typeof parsed === "object") record = parsed as Record<string, unknown>;
    } catch {
      record = null;
    }
  }
  if (!record) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
        if (parsed && typeof parsed === "object") record = parsed as Record<string, unknown>;
      } catch {
        record = null;
      }
    }
  }
  if (!record) return null;
  const actionRaw = typeof record.action === "string" ? record.action.trim().toLowerCase() : "";
  if (actionRaw === "ask") return { action: "accept", reason: cleanReason("accept", record.question ?? record.reason) };
  if (actionRaw !== "accept" && actionRaw !== "decline" && actionRaw !== "refuse" && actionRaw !== "reject") return null;
  const action = actionRaw === "accept" ? "accept" : "decline";
  return { action, reason: cleanReason(action, record.reason) };
}

function priceLabel(units: string): string {
  if (!/^\d+$/.test(units)) return units;
  const padded = units.padStart(7, "0");
  const dollars = padded.slice(0, -6).replace(/^0+/, "") || "0";
  const cents = padded.slice(-6).replace(/0+$/, "");
  return cents ? `${dollars}.${cents}` : dollars;
}

async function claim(job: Job): Promise<"go" | Job> {
  const outcome = await agentStore().updateJob<{ go: boolean; job: Job }>(job.id, (current) => {
    if (!current || current.status !== "offered") return { job: current, result: { go: false as const, job: current ?? job } };
    const reply = current.offerReply ?? "";
    const busy = reply === "running" && Date.now() - current.updatedAt < 90_000;
    if (reply === "accept" || reply === "decline" || busy) return { job: current, result: { go: false as const, job: current } };
    const next: Job = { ...current, offerReply: "running", updatedAt: Date.now() };
    return { job: next, result: { go: true as const, job: next } };
  });
  if (!outcome?.go) return outcome?.job ?? job;
  return "go";
}

async function askSeller(job: Job): Promise<{ action: "accept" | "decline"; reason: string } | null> {
  const seller = await agentStore().getAgent(job.sellerPlatformId);
  if (!seller || seller.status === "paused" || seller.status === "removed") {
    return { action: "decline", reason: "I can't take this." };
  }
  const chosen = await chosenModelForAgent(seller);
  noteModelTurn(seller.owner);
  const talk = chosen.provider === "muse" ? museTalkModel(chosen.modelId) : null;
  const who = seller.publicDescription?.trim() ? `${seller.name}. ${seller.publicDescription.trim()}` : seller.name;
  const instruction = [
    `You are ${who}.`,
    "You are the hired agent. Another agent offered you this job. Decide in this reply. Do not wait for another message.",
    "Accept when you can do this work at the offered price. Decline only when you cannot do the work.",
    "Call offer_reply. action is accept or decline. reason is one short sentence in your own words.",
    `Task: ${job.terms}`,
    `Price: ${priceLabel(job.priceBaseUnits)} USDC`,
    `Deliver by: ${new Date(job.deadline).toISOString()}`,
  ].join("\n");
  const step = await runModel(
    seller.owner,
    chosen.provider,
    talk ?? chosen.modelId,
    instruction,
    [{ role: "user", content: "Reply to this offer now." }],
    [REPLY_TOOL]
  );
  return parseOfferReply(step.text, step.toolCalls);
}

async function applyDecision(id: string, decision: { action: "accept" | "decline"; reason: string }): Promise<Job | null> {
  return agentStore().updateJob(id, (current) => {
    if (!current || current.status !== "offered") return { job: current, result: current };
    try {
      const turned =
        decision.action === "accept"
          ? applyTurn(current, { kind: "accept", buyerWallet: current.buyerWallet, sellerWallet: current.sellerWallet }, Date.now())
          : applyTurn(current, { kind: "decline" }, Date.now());
      const next: Job = { ...turned, offerReply: decision.action };
      return { job: next, result: next };
    } catch {
      return { job: current, result: current };
    }
  });
}

async function record(job: Job, line: string): Promise<void> {
  const now = Date.now();
  await agentStore().appendPeer(pairId(job.buyerPlatformId, job.sellerPlatformId), {
    id: randomId("msg"),
    fromPlatformId: job.sellerPlatformId,
    toPlatformId: job.buyerPlatformId,
    text: line,
    createdAt: now,
  });
  for (const platformId of [job.buyerPlatformId, job.sellerPlatformId]) {
    await agentStore().saveAudit({
      id: randomId("aud"),
      platformId,
      actionId: null,
      kind: "job.reply",
      summary: line,
      verified: false,
      reported: true,
      detail: { jobId: job.id, status: job.status },
      createdAt: now,
    });
  }
}

async function decide(job: Job): Promise<OfferAnswer> {
  const gate = await claim(job);
  if (gate !== "go") return { job: gate, line: "" };
  let decision: { action: "accept" | "decline"; reason: string } = { action: "accept", reason: "I'll take it." };
  try {
    decision = (await askSeller(job)) ?? decision;
  } catch (error) {
    console.error("[agents] offer reply", error instanceof Error ? error.name : "error");
  }
  const finished = await applyDecision(job.id, decision);
  const next = finished ?? job;
  if (next.status === "accepted" || next.status === "declined") {
    try {
      await record(next, decision.reason);
    } catch (error) {
      console.error("[agents] offer reply", error instanceof Error ? error.name : "error");
    }
  }
  return { job: next, line: decision.reason };
}

/** The hired agent accepts or declines before the owner is told. A missing reply stands as accepted. */
export function answerOpenOffer(job: Job): Promise<OfferAnswer> {
  if (job.status !== "offered") return Promise.resolve({ job, line: "" });
  const pending = inflight.get(job.id);
  if (pending) return pending;
  const run = decide(job)
    .catch((error: unknown) => {
      console.error("[agents] offer reply", error instanceof Error ? error.name : "error");
      return { job, line: "" };
    })
    .finally(() => inflight.delete(job.id));
  inflight.set(job.id, run);
  return run;
}
