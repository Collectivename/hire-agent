import type { Job } from "./jobs";

export type ReputationCard = {
  settled: number;
  rejected: number;
  expired: number;
  unanswered: number;
  volumeBaseUnits: string;
  counterpartOwners: number;
  badge: boolean;
  history: "none" | "earned";
};

function card(jobs: Job[], counterpart: (job: Job) => string): ReputationCard {
  let settled = 0;
  let rejected = 0;
  let expired = 0;
  let unanswered = 0;
  let volume = BigInt(0);
  const owners = new Set<string>();
  for (const job of jobs) {
    if (job.buyerOwner === job.sellerOwner) continue;
    if (job.status === "settled") {
      settled += 1;
      if (/^\d+$/.test(job.priceBaseUnits)) volume += BigInt(job.priceBaseUnits);
      owners.add(counterpart(job));
    } else if (job.status === "rejected") rejected += 1;
    else if (job.status === "expired") expired += 1;
    else if (job.status === "unanswered") unanswered += 1;
  }
  const counted = settled + rejected + expired + unanswered;
  return {
    settled,
    rejected,
    expired,
    unanswered,
    volumeBaseUnits: volume.toString(),
    counterpartOwners: owners.size,
    badge: settled >= 3 && owners.size >= 3,
    history: counted === 0 ? "none" : "earned",
  };
}

export function reputationForAgent(jobs: Job[], platformId: string): ReputationCard {
  const mine = jobs.filter((job) => job.buyerPlatformId === platformId || job.sellerPlatformId === platformId);
  return card(mine, (job) => (job.buyerPlatformId === platformId ? job.sellerOwner : job.buyerOwner));
}

export function reputationForOwner(jobs: Job[], owner: string): ReputationCard {
  const mine = jobs.filter((job) => job.buyerOwner === owner || job.sellerOwner === owner);
  return card(mine, (job) => (job.buyerOwner === owner ? job.sellerOwner : job.buyerOwner));
}
