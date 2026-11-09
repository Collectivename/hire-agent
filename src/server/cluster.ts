import { AsyncLocalStorage } from "node:async_hooks";

export type HireCluster = "mainnet" | "devnet";

const storage = new AsyncLocalStorage<HireCluster>();

/** The request cluster. Routes that do not opt in stay on mainnet. */
export function hireCluster(): HireCluster {
  return storage.getStore() ?? "mainnet";
}

export function runWithHireCluster<T>(cluster: HireCluster, fn: () => T): T {
  return storage.run(cluster, fn);
}

/** Missing network is mainnet, so agents saved before the devnet page stay there. */
export function agentMatchesCluster(agent: { network?: string | null }): boolean {
  return (agent.network === "devnet" ? "devnet" : "mainnet") === hireCluster();
}
