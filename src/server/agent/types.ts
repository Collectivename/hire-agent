import type { OwnerAsk } from "../owner-ask";

export type AgentRunKind = "chat" | "task" | "heartbeat";

export type AgentScope = "owner" | "peer" | "task" | "heartbeat";

export type AgentRun = {
  version: number;
  kind: AgentRunKind;
  provider: string;
  modelId: string;
  skills: string[];
  tools: string[];
  memory: string[];
  files: string[];
  truncated: { path: string; kept: number; omitted: number }[];
  bootChecks: { name: string; ok: boolean }[];
};

export type AgentRuntimeDoc = {
  platformId: string;
  lastBootAt: number;
  lastHeartbeatAt: number;
  lastRun: AgentRun | null;
  ownerAsk?: OwnerAsk | null;
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  approval: "auto" | "prompt";
};

export type McpAuth = "none" | "bearer" | "header" | "oauth";

export type McpServer = {
  platformId: string;
  name: string;
  description: string;
  url: string;
  transport: "streamable-http";
  auth: McpAuth;
  headerName: string;
  enabled: boolean;
  approval: "auto" | "prompt";
  instructions: string;
  tools: McpTool[];
  sessionId: string;
  status: "new" | "connected" | "error" | "disabled";
  lastError: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  updatedAt: number;
};

export type McpSecret = {
  bearer?: string;
  headerValue?: string;
  oauthClient?: string;
  access?: string;
  refresh?: string;
  expiresAt?: number;
};
