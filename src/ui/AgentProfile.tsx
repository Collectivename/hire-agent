import Link from "next/link";
import { fresh } from "../server/jobs";
import { reputationForAgent, reputationForOwner, type ReputationCard } from "../server/reputation";
import { agentStore, publicAgent } from "../server/store";

export async function AgentProfile({ id, network = "mainnet" }: { id: string; network?: "mainnet" | "devnet" }) {
  let agent: ReturnType<typeof publicAgent> | null = null;
  let unavailable = false;
  let reputation: ReputationCard | null = null;
  let ownerReputation: ReputationCard | null = null;
  try {
    const stored = await agentStore().getAgent(id);
    const sameNetwork = stored != null && (stored.network === "devnet" ? "devnet" : "mainnet") === network;
    agent = stored && sameNetwork ? publicAgent(stored) : null;
    if (stored && agent) {
      // This page is force-dynamic. The clock is this request's time, used once
      // to decide which job receipts are past their deadline.
      // eslint-disable-next-line react-hooks/purity
      const now = Date.now();
      try {
        const jobs = await agentStore().listJobsForAgent(stored.platformId);
        reputation = reputationForAgent(
          jobs.map((job) => fresh(job, now)),
          stored.platformId
        );
      } catch {
        reputation = null;
      }
      try {
        const jobs = await agentStore().listJobsForOwner(stored.owner);
        ownerReputation = reputationForOwner(
          jobs.map((job) => fresh(job, now)),
          stored.owner
        );
      } catch {
        ownerReputation = null;
      }
    }
  } catch {
    unavailable = true;
  }

  return (
    <>
      <Link href={network === "devnet" ? "/devnet/hire" : "/agents"} className="text-sm font-semibold text-accent">
        Agents
      </Link>
      {unavailable ? (
        <p className="mt-6 text-ink-2">Profiles are unavailable until Firestore is configured.</p>
      ) : !agent ? (
        <h1 className="mt-6 font-display text-3xl font-bold text-ink">Agent not found</h1>
      ) : (
        <article className="mt-6 space-y-4">
          <h1 className="font-display text-3xl font-bold text-ink">{agent.name}</h1>
          <dl className="grid gap-3 rounded-lg border border-line bg-surface p-4 text-sm">
            <div>
              <dt className="text-ink-3">Identifier</dt>
              <dd className="break-all font-mono text-ink">{agent.identifier ?? "Not registered"}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Platform id</dt>
              <dd className="break-all font-mono text-ink">{agent.platformId}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Solana wallet</dt>
              <dd className="break-all font-mono text-ink">{agent.walletAddress}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Status</dt>
              <dd className="text-ink">{agent.status}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Endpoint</dt>
              <dd className="break-all text-ink">{agent.endpoint ?? "No proved endpoint"}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Skills</dt>
              <dd className="break-all text-ink">
                {agent.hireable === false
                  ? "Not listed. This agent reviews deliveries."
                  : agent.directorySkills.length
                    ? agent.directorySkills.join(", ")
                    : "No listed skill"}
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">XMTP</dt>
              <dd className="break-all font-mono text-ink">{agent.slimName ?? "Not named"}</dd>
            </div>
            {agent.transferredAt ? (
              <div>
                <dt className="text-ink-3">Owner transferred</dt>
                <dd className="text-ink">{new Date(agent.transferredAt).toISOString()}</dd>
              </div>
            ) : null}
          </dl>
          <Receipts title="Receipts" card={reputation} />
          <Receipts title="Owner wallet" card={ownerReputation} />
          <p className="text-sm text-ink-2">
            The wallet pays USDC on a hired job. Receipts count settled, rejected, expired, and unanswered
            jobs. A job between one owner&apos;s agents stays off the score. A listed skill is an OASF path on
            the registration file. Search keeps a result only when the registry account and the asset both point at that file.
          </p>
        </article>
      )}
    </>
  );
}

function Receipts({ title, card }: { title: string; card: ReputationCard | null }) {
  if (!card) return <p className="text-sm text-ink-2">{title}: history is unavailable.</p>;
  if (card.history === "none") return <p className="text-sm text-ink-2">{title}: no history.</p>;
  return (
    <p className="text-sm text-ink-2">
      {title}: {card.settled} settled, {card.rejected} rejected, {card.expired} expired, {card.unanswered} unanswered.
      {card.badge ? " Badge earned." : ""}
    </p>
  );
}
