import type { Policy, PolicyDecision, PolicyRequest, Risk } from "./types";

const KNOWN_ACTIONS = [
  "dao.read",
  "propose",
  "vote",
  "trade",
  "launch",
  "pay",
] as const;

export function defaultPolicy(): Policy {
  return {
    perTxCapLamports: "0",
    dailyBudgetLamports: "0",
    allowedActions: [],
    allowedPrograms: [],
    allowedRecipients: [],
    allowedMints: [],
    maxPerMinute: 0,
  };
}

export function knownActions(): readonly string[] {
  return KNOWN_ACTIONS;
}

function parseLamports(value: string): bigint | null {
  if (!/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function decide(
  allow: boolean,
  reason: string,
  risk: Risk,
  signer: PolicyDecision["signer"] = "none"
): PolicyDecision {
  return { allow, reason, risk, signer: allow ? signer : "none" };
}

/** Fail closed. Registration does not authorize spending. */
export function evaluatePolicy(policy: Policy, request: PolicyRequest): PolicyDecision {
  const amount = parseLamports(request.amountLamports);
  const cap = parseLamports(policy.perTxCapLamports);
  const daily = parseLamports(policy.dailyBudgetLamports);
  const spent = parseLamports(request.spentTodayLamports);
  if (amount == null || cap == null || daily == null || spent == null) {
    return decide(false, "Amount or budget is not a lamport integer.", "high");
  }

  const unknownProgram = request.programIds.some(
    (id) => !policy.allowedPrograms.includes(id)
  );
  const overCap = amount > cap;
  const high =
    request.authorityChange ||
    request.payment ||
    request.action === "pay" ||
    request.action === "launch" ||
    overCap ||
    unknownProgram;
  const risk: Risk = high ? "high" : request.action === "dao.read" ? "low" : "medium";

  if (request.paused) return decide(false, "Agent is paused.", risk);
  if (!KNOWN_ACTIONS.includes(request.action as (typeof KNOWN_ACTIONS)[number])) {
    return decide(false, "Unknown action.", "high");
  }
  if (!policy.allowedActions.includes(request.action)) {
    return decide(false, "Action is not allowed.", risk);
  }
  if (policy.maxPerMinute <= 0 || request.actionsLastMinute >= policy.maxPerMinute) {
    return decide(false, "Request frequency is exhausted.", risk);
  }
  if (overCap) return decide(false, "Amount is over the per-transaction cap.", "high");
  if (spent + amount > daily) return decide(false, "Daily budget is exhausted.", risk);
  if (unknownProgram) return decide(false, "Program id is not allowed.", "high");
  const listed = request.recipients ?? [];
  const recipients = listed.length > 0 ? listed : request.recipient ? [request.recipient] : [];
  if (amount > BigInt(0) || request.payment || listed.length > 0) {
    if (recipients.length === 0 || recipients.some((item) => !policy.allowedRecipients.includes(item))) {
      return decide(false, "Recipient is not allowed.", risk);
    }
  }
  if (request.mint && !policy.allowedMints.includes(request.mint)) {
    return decide(false, "Mint is not allowed.", risk);
  }
  if (risk === "high") {
    return decide(true, "Owner signature required for this payload.", "high", "owner");
  }
  return decide(true, "Allowed inside the owner policy.", risk, "agent");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
