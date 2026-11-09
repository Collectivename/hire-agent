import type { AgentWorkspace } from "../workspace";
import { readFile } from "../workspace";
import type { McpServer } from "./types";

export type BootReport = { at: number; checks: { name: string; ok: boolean }[]; unrecognized: number };

const KNOWN = new Set(["workspace", "identity", "memory", "tools", "mcp"]);

/** Runs the startup checks named by BOOT.md. Prose in that file is counted, not executed. */
export function runBoot(workspace: AgentWorkspace, servers: McpServer[], at: number): BootReport {
  const checks = [
    { name: "workspace", ok: Object.keys(workspace.files).length > 0 },
    { name: "identity", ok: Boolean(readFile(workspace, "IDENTITY.md").trim()) },
    { name: "memory", ok: Boolean(readFile(workspace, "MEMORY.md").trim()) || Object.keys(workspace.files).some((path) => path.startsWith("memory/")) },
    { name: "tools", ok: true },
    { name: "mcp", ok: servers.every((server) => !server.enabled || server.status === "connected" || server.status === "new") },
  ];
  let unrecognized = 0;
  for (const line of readFile(workspace, "BOOT.md").split("\n")) {
    const named = /^-\s*check:\s*([a-z]+)\s*$/.exec(line.trim());
    if (named) {
      if (!KNOWN.has(named[1]!)) unrecognized += 1;
      continue;
    }
    if (line.trim()) unrecognized += 1;
  }
  return { at, checks, unrecognized };
}

export function heartbeatInterval(workspace: AgentWorkspace): number | null {
  const text = readFile(workspace, "HEARTBEAT.md").trim();
  if (!text) return null;
  const match = /interval:\s*(\d+)\s*(m|h)/i.exec(text);
  const amount = match ? Number(match[1]) : 30;
  const unit = match?.[2]?.toLowerCase() ?? "m";
  const ms = (unit === "h" ? amount * 60 : amount) * 60_000;
  if (!Number.isFinite(ms)) return 30 * 60_000;
  return Math.min(Math.max(ms, 60_000), 7 * 24 * 60 * 60_000);
}
