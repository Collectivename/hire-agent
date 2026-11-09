import { AgentsError } from "../errors";
import { agentStore } from "../store";
import { openInboxKey, sealInboxKey } from "../xmtp";
import {
  defaultWorkspace,
  normalizeWorkspace,
  type AgentWorkspace,
} from "../workspace";
import { now } from "../workspace";
import type { AgentRuntimeDoc, McpSecret, McpServer } from "./types";

function clone(workspace: AgentWorkspace): AgentWorkspace {
  return {
    ...workspace,
    files: Object.fromEntries(Object.entries(workspace.files).map(([path, file]) => [path, { ...file }])),
  };
}

export async function loadWorkspace(platformId: string, name: string): Promise<AgentWorkspace> {
  const raw: unknown = await agentStore().getWorkspace(platformId);
  return normalizeWorkspace(raw, name) ?? defaultWorkspace(platformId, name, now());
}

export async function changeWorkspace(
  platformId: string,
  name: string,
  change: (workspace: AgentWorkspace) => void
): Promise<AgentWorkspace> {
  return agentStore().updateWorkspace(platformId, (current) => {
    const base = normalizeWorkspace(current, name) ?? defaultWorkspace(platformId, name, now());
    const next = clone(base);
    change(next);
    next.platformId = platformId;
    next.version = (current ? base.version : 0) + 1;
    next.updatedAt = now();
    return next;
  });
}

function emptyRuntime(platformId: string): AgentRuntimeDoc {
  return { platformId, lastBootAt: 0, lastHeartbeatAt: 0, lastRun: null };
}

export async function loadRuntime(platformId: string): Promise<AgentRuntimeDoc> {
  return (await agentStore().getRuntime(platformId)) ?? emptyRuntime(platformId);
}

export async function saveRuntime(doc: AgentRuntimeDoc): Promise<void> {
  await agentStore().saveRuntime(doc);
}

export async function listServers(platformId: string): Promise<McpServer[]> {
  return agentStore().listMcp(platformId);
}

export async function saveServer(server: McpServer): Promise<void> {
  await agentStore().saveMcp(server);
}

export async function removeServer(platformId: string, name: string): Promise<void> {
  await agentStore().deleteMcp(platformId, name);
  await agentStore().deleteSeal(sealId(platformId, name));
}

export function sealId(platformId: string, name: string): string {
  return `mcp:${platformId}:${name}`;
}

export function sealSecret(secret: McpSecret): string | null {
  return sealInboxKey(JSON.stringify(secret));
}

export async function readSecret(platformId: string, name: string): Promise<McpSecret | null> {
  const sealed = await agentStore().getSeal(sealId(platformId, name));
  if (!sealed) return null;
  const opened = openInboxKey(sealed);
  if (!opened) return null;
  try {
    const parsed = JSON.parse(opened) as McpSecret;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeSecret(platformId: string, name: string, secret: McpSecret): Promise<void> {
  const sealed = sealSecret(secret);
  if (!sealed) throw new AgentsError("NOT_READY", "Credential storage is not configured.", 503);
  await agentStore().saveSeal(sealId(platformId, name), sealed);
}
