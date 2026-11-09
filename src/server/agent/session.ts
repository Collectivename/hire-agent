import { compileContext, type Truncation } from "./context";
import { runBoot } from "./boot";
import { skillCatalog } from "./skills";
import type { McpServer } from "./types";
import type { AgentWorkspace } from "../workspace";
import { now } from "../workspace";

export type SessionPin = {
  platformId: string;
  version: number;
  system: string;
  skills: string[];
  truncated: Truncation[];
  bootChecks: { name: string; ok: boolean }[];
  bootedAt: number;
};

const PROMPT_REVISION = 3;
const pins = new Map<string, SessionPin>();

export function resetSessions(): void {
  pins.clear();
}

export function pinSession(workspace: AgentWorkspace, servers: McpServer[], audience: "owner" | "peer" = "owner"): SessionPin {
  const key = `${workspace.platformId}:${audience}:${PROMPT_REVISION}`;
  const existing = pins.get(key);
  if (existing && existing.version === workspace.version) return existing;
  const boot = runBoot(workspace, servers, now());
  const compiled = compileContext(workspace, servers, skillCatalog(workspace), audience);
  const pin: SessionPin = {
    platformId: workspace.platformId,
    version: workspace.version,
    system: compiled.system,
    skills: compiled.skills,
    truncated: compiled.truncated,
    bootChecks: boot.checks.map((check) => ({ name: check.name, ok: check.ok })),
    bootedAt: boot.at,
  };
  pins.set(key, pin);
  return pin;
}
