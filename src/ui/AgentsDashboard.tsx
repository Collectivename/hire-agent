"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { canonicalJson, defaultPolicy, type Policy } from "../protocol";
import { OASF_SKILLS } from "../protocol/oasf-taxonomy";

type PublicAgent = {
  platformId: string;
  identifier: string | null;
  name: string;
  owner: string;
  status: string;
  walletAddress: string;
  walletProvider: string;
  endpoint: string | null;
  slimName: string | null;
  directoryCid: string | null;
  directorySkills: string[];
  hireable?: boolean;
  agentModel?: { provider: string; modelId: string } | null;
};

type Detail = {
  agent: PublicAgent & { signCredentialIssuedAt: number | null; providerWalletId: string };
  policy: Policy;
  balanceLamports: string | null;
  balanceVerified: boolean;
};

type JobView = {
  id: string;
  buyerPlatformId: string;
  sellerPlatformId: string;
  status: string;
  priceBaseUnits: string;
  mint: string;
  sellerWallet: string;
  deadline: number;
  terms: string;
  proof: string;
  expectedProof: string;
  deliveryNote: string;
  deliveryProof: string;
  deliveryFiles?: { path: string; content: string }[];
  reviewReport: string;
  revisionNote: string;
  termsDigest: string;
  approvalDigest: string;
  settlementSignature: string;
  fundSignature: string;
  refundSignature: string;
  funded: boolean;
  sameOwner: boolean;
};

type ReputationCard = {
  settled: number;
  rejected: number;
  expired: number;
  unanswered: number;
  badge: boolean;
  history: "none" | "earned";
};

type OwnerAsk = {
  prompt: string;
  choices: string[];
  multiple: boolean;
  inputLabel: string;
};

function ownerAnswer(input: { picked: string[]; other: string; typed: string }): string {
  const custom = input.other.replace(/\s+/g, " ").trim();
  const notes = input.typed.replace(/\s+/g, " ").trim();
  const choices = input.picked.map((item) => item.trim()).filter(Boolean);
  if (custom) choices.push(custom);
  return [choices.join(", "), notes].filter(Boolean).join(". ");
}

function readOwnerAsk(value: unknown): OwnerAsk | null {
  if (!value || typeof value !== "object") return null;
  const ask = value as OwnerAsk;
  if (typeof ask.prompt !== "string" || !Array.isArray(ask.choices)) return null;
  return {
    prompt: ask.prompt,
    choices: ask.choices.filter((choice) => typeof choice === "string" && choice.trim()),
    multiple: ask.multiple === true,
    inputLabel: typeof ask.inputLabel === "string" ? ask.inputLabel : "",
  };
}

function OwnerAskBar({ ask, disabled, onSend }: { ask: OwnerAsk; disabled: boolean; onSend: (message: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [otherOn, setOtherOn] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [typed, setTyped] = useState("");
  const needsField = ask.inputLabel.length > 0;
  const needsChoice = ask.choices.length > 0;
  const message = ownerAnswer({ picked, other: otherOn ? otherText : "", typed });
  const ready =
    (!needsChoice || picked.length > 0 || (otherOn && otherText.trim().length > 0)) &&
    (!otherOn || otherText.trim().length > 0) &&
    (!needsField || typed.trim().length > 0);

  function choose(label: string) {
    if (!ask.multiple && !needsField) {
      onSend(label);
      return;
    }
    if (!ask.multiple) setOtherOn(false);
    setPicked((current) => {
      if (ask.multiple) return current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
      return current[0] === label ? [] : [label];
    });
  }

  return (
    <div className="space-y-2 border-t border-line px-3 py-3">
      <p className="text-sm text-ink">{ask.prompt}</p>
      {needsChoice ? (
        <div className="flex flex-wrap gap-2">
          {ask.choices.map((label) => {
            const on = picked.includes(label);
            return (
              <button
                key={label}
                type="button"
                disabled={disabled}
                aria-pressed={ask.multiple || needsField ? on : undefined}
                className={`rounded-full border px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${on ? "border-accent bg-accent text-on-accent" : "border-line-strong text-ink"}`}
                onClick={() => choose(label)}
              >
                {label}
              </button>
            );
          })}
          <button
            type="button"
            disabled={disabled}
            aria-pressed={otherOn}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${otherOn ? "border-accent bg-accent text-on-accent" : "border-line-strong text-ink"}`}
            onClick={() => {
              if (!ask.multiple) setPicked([]);
              setOtherOn((current) => !current);
            }}
          >
            Other
          </button>
        </div>
      ) : null}
      {needsField || ask.multiple || otherOn ? (
        <div className="flex flex-wrap items-end gap-2">
          {otherOn ? (
            <label className="min-w-0 flex-1 text-xs text-ink-2">
              Other
              <input
                className="mt-1 w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink"
                value={otherText}
                disabled={disabled}
                onChange={(event) => setOtherText(event.target.value)}
              />
            </label>
          ) : null}
          {needsField ? (
            <label className="min-w-0 flex-1 text-xs text-ink-2">
              {ask.inputLabel}
              <input
                className="mt-1 w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink"
                value={typed}
                disabled={disabled}
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
          ) : null}
          <button
            type="button"
            disabled={disabled || !ready}
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-50"
            onClick={() => onSend(message)}
          >
            Send
          </button>
        </div>
      ) : null}
    </div>
  );
}

type ChatMessage = {
  id: string;
  from: { role: "owner"; wallet: string } | { role: "agent"; platformId: string };
  text: string;
  replyExpected: boolean;
  answeredAt: number | null;
  createdAt: number;
};

function fileName(path: string): string {
  return path.split("/").at(-1) || path;
}

function downloadText(path: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName(path);
  anchor.click();
  URL.revokeObjectURL(url);
}

function DeliveryFiles({
  files,
  openPath,
  onOpen,
}: {
  files: { path: string; content: string }[];
  openPath: string;
  onOpen: (path: string) => void;
}) {
  if (!files.length) return null;
  return (
    <ul className="space-y-2">
      {files.map((file) => {
        const open = openPath === file.path;
        return (
          <li key={file.path} className="rounded-md border border-line bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{fileName(file.path)}</p>
                <p className="truncate font-mono text-xs text-ink-2">{file.path}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" className="rounded-md border border-line-strong px-3 py-1 text-xs font-semibold text-ink" onClick={() => onOpen(open ? "" : file.path)}>
                  {open ? "Close" : "Open"}
                </button>
                <button type="button" className="rounded-md border border-line-strong px-3 py-1 text-xs font-semibold text-ink" onClick={() => downloadText(file.path, file.content)}>
                  Download
                </button>
              </div>
            </div>
            {open ? <pre className="max-h-80 overflow-auto border-t border-line px-3 py-2 font-mono text-xs text-ink">{file.content}</pre> : null}
          </li>
        );
      })}
    </ul>
  );
}

function speakerLabel(message: ChatMessage, ownerWallet: string): string {
  if (message.from.role === "agent") return "Agent";
  return message.from.wallet === ownerWallet ? "You" : "Previous owner";
}

const SESSION_KEY = "collective.agents.owner";
const SKILL_LIMIT = 5;

const SKILL_FILE = /^skills\/([a-z0-9][a-z0-9-]{0,31})\/SKILL\.md$/;

function skillSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function readSkillFile(content: string): { description: string; enabled: boolean; body: string } {
  let description = "";
  let enabled = true;
  let body = content.trim();
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      body = content.slice(end + 4).trim();
      for (const line of content.slice(4, end).split("\n")) {
        const match = /^([a-zA-Z]+):\s*(.*)$/.exec(line.trim());
        if (!match) continue;
        const key = match[1]!.toLowerCase();
        const value = match[2]!.trim().replace(/^["']|["']$/g, "");
        if (key === "description") description = value;
        if (key === "enabled") enabled = value !== "false";
      }
    }
  }
  return { description, enabled, body };
}

function skillWords(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const SKILL_GROUPS = (() => {
  const groups = new Map<string, { path: string; label: string }[]>();
  for (const path of OASF_SKILLS) {
    const parts = path.split("/");
    const category = skillWords(parts[0] ?? path);
    const items = groups.get(category) ?? [];
    items.push({ path, label: skillWords(parts[parts.length - 1] ?? path) });
    groups.set(category, items);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
})();

function SkillOptions({ taken = [] }: { taken?: string[] }) {
  const hidden = new Set(taken);
  return (
    <>
      {SKILL_GROUPS.map((group) => (
        <optgroup key={group.category} label={group.category}>
          {group.items.map((item) => (
            <option key={item.path} value={item.path} disabled={hidden.has(item.path)}>
              {item.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

const MODELS = {
  openai: ["gpt-4o", "gpt-4.1", "gpt-4o-mini"],
  anthropic: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  muse: ["muse-spark-1.3", "muse-wonder-1.0", "muse-image-1.0", "muse-voice-transcribe-1.0", "sam-3.1"],
} as const;

const MODEL_LABELS: Record<string, string> = {
  "muse-spark-1.3": "Muse Spark",
  "muse-wonder-1.0": "Muse Wonder",
  "muse-image-1.0": "Muse Image",
  "muse-voice-transcribe-1.0": "Muse Transcription",
  "sam-3.1": "Muse SAM",
};

const PROVIDERS = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini" },
  { id: "muse", label: "Muse" },
] as const;

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function AgentsDashboard({
  apiBase = "/api/agents/v1",
  profileBase = "/agents",
  screen = "setup",
  agentId = "",
}: {
  apiBase?: string;
  profileBase?: string;
  screen?: "setup" | "mine" | "thread";
  agentId?: string;
}) {
  const router = useRouter();
  const sessionKey = profileBase === "/agents" ? SESSION_KEY : `${SESSION_KEY}.devnet`;
  const { connection } = useConnection();
  const { publicKey, signMessage, sendTransaction, connected } = useWallet();
  const owner = publicKey?.toBase58() ?? "";
  const [token, setToken] = useState("");
  const [agents, setAgents] = useState<PublicAgent[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [threadDenied, setThreadDenied] = useState("");
  const [audit, setAudit] = useState<{ kind: string; summary: string; label: string; createdAt: number }[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [reputation, setReputation] = useState<ReputationCard | null>(null);
  const [modelLinks, setModelLinks] = useState<{ provider: string; hint: string; modelId: string; status: string; updatedAt?: number }[]>([]);
  const [modelProviderName, setModelProviderName] = useState("openai");
  const [modelCredential, setModelCredential] = useState("");
  const [modelChoice, setModelChoice] = useState("gpt-4o");
  const [agentPick, setAgentPick] = useState<{ platformId: string; provider: string; modelId: string } | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [skillSlugInput, setSkillSlugInput] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [skillEnabled, setSkillEnabled] = useState(true);
  const [filePath, setFilePath] = useState("SOUL.md");
  const [openDelivery, setOpenDelivery] = useState("");
  const [showDelivered, setShowDelivered] = useState(true);
  const [fileDraft, setFileDraft] = useState("");
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const [servers, setServers] = useState<{ name: string; url: string; status: string; lastError?: string; tools: { name: string; enabled: boolean }[] }[]>([]);
  const [searchSkill, setSearchSkill] = useState("");
  const [skillHits, setSkillHits] = useState<{ platformId: string; asset: string; skills: string[]; name?: string; description?: string }[] | null>(null);
  const [skillComplete, setSkillComplete] = useState(true);
  const [searchingSkills, setSearchingSkills] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpBearer, setMcpBearer] = useState("");
  const [runSummary, setRunSummary] = useState("");
  const [draft, setDraft] = useState("");
  const [needsReply, setNeedsReply] = useState(true);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [ownerAsk, setOwnerAsk] = useState<OwnerAsk | null>(null);
  const [failedSendId, setFailedSendId] = useState("");
  const sendingRef = useRef(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createSkills, setCreateSkills] = useState<string[]>([]);
  const [signingIn, setSigningIn] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [panel, setPanel] = useState<"workspace" | "skills" | "hires" | "policy" | "account">("workspace");
  const threadEnd = useRef<HTMLDivElement | null>(null);
  const openedThread = useRef("");
  const [policyText, setPolicyText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [registering, setRegistering] = useState(false);
  const [pendingRegistry, setPendingRegistry] = useState<{ platformId: string; asset: string; signature: string } | null>(null);

  const api = useCallback(
    async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? "Request failed");
      return json as Record<string, unknown>;
    },
    [apiBase, token]
  );

  const modelSynced = useRef(false);
  useEffect(() => {
    const saved = sessionStorage.getItem(sessionKey);
    const savedWallet = sessionStorage.getItem(`${sessionKey}.wallet`);
    const timer = window.setTimeout(() => {
      if (saved && savedWallet && savedWallet === owner) setToken(saved);
      else setToken("");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sessionKey, owner]);

  useEffect(() => {
    if (!token) return;
    void api("GET", "/mine")
      .then((json) => setAgents((json.agents as PublicAgent[]) ?? []))
      .catch((err: Error) => setError(err.message));
    void api("GET", "/providers")
      .then((json) => {
        const links = (json.providers as { provider: string; hint: string; modelId: string; status: string; updatedAt?: number }[]) ?? [];
        setModelLinks(links);
        // Start the picker on what is stored, not on provider defaults, so a
        // later click cannot silently switch back to the first list entry.
        if (!modelSynced.current && links.length > 0) {
          modelSynced.current = true;
          const latest = [...links].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
          if (latest) {
            setModelProviderName(latest.provider);
            setModelChoice(latest.modelId);
          }
        }
      })
      .catch(() => setModelLinks([]));
  }, [api, token]);

  async function sign(message: string): Promise<string> {
    if (!signMessage) throw new Error("This wallet cannot sign messages.");
    const signature = await signMessage(new TextEncoder().encode(message));
    return bs58.encode(signature);
  }

  async function signIn() {
    setError("");
    setSigningIn(true);
    setNotice("Waiting for the wallet signature.");
    try {
    const opened = await fetch(`${apiBase}/owner-session/nonce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner }),
    });
    const nonceBody = (await opened.json()) as { nonce?: string; message?: string; error?: { message?: string } };
    if (!opened.ok || !nonceBody.nonce || !nonceBody.message) {
      throw new Error(nonceBody.error?.message ?? "Could not start the owner session.");
    }
    const signature = await sign(nonceBody.message);
    setNotice("Opening the owner session.");
    const session = await fetch(`${apiBase}/owner-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, nonce: nonceBody.nonce, signature }),
    });
    const created = (await session.json()) as { token?: string; error?: { message?: string } };
    if (!session.ok || !created.token) throw new Error(created.error?.message ?? "Owner session failed.");
    sessionStorage.setItem(sessionKey, created.token);
    sessionStorage.setItem(`${sessionKey}.wallet`, owner);
    setToken(created.token);
    setNotice("Signed in. Connect a model next.");
    } finally {
      setSigningIn(false);
    }
  }

  async function deployOnSolana(platformId: string) {
    if (!publicKey || publicKey.toBase58() !== owner) throw new Error("Connect the owner wallet for this agent.");
    if (!sendTransaction) throw new Error("This wallet cannot sign transactions.");
    setNotice("Preparing the Solana registration.");
    const assetKey = Keypair.generate();
    const prepared = await api("POST", `/agents/${platformId}/registry/prepare`, {
      asset: assetKey.publicKey.toBase58(),
    });
    const tx = Transaction.from(bytesFromBase64(String(prepared.transaction)));
    tx.partialSign(assetKey);
    const assetSigned = tx.signatures.some((entry) => entry.publicKey.equals(assetKey.publicKey) && entry.signature != null);
    if (!assetSigned) throw new Error("The asset key did not sign the registry transaction.");
    setNotice("Confirm the registration in your wallet.");
    const signature = await sendTransaction(tx, connection, { preflightCommitment: "confirmed", maxRetries: 0 });
    const pending = { platformId, asset: assetKey.publicKey.toBase58(), signature };
    setPendingRegistry(pending);
    setNotice("Waiting for the registration to land.");
    try {
      await connection.confirmTransaction(
        {
          signature,
          blockhash: String(prepared.blockhash),
          lastValidBlockHeight: Number(prepared.lastValidBlockHeight),
        },
        "confirmed"
      );
    } catch {
      // The confirm route reads the chain itself.
    }
    await api("POST", `/agents/${platformId}/registry/confirm`, { asset: pending.asset, signature });
    setPendingRegistry(null);
  }

  async function createAndDeploy() {
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    if (!trimmedName || trimmedName.length > 32) {
      setCreateError("The agent name must be 1–32 characters.");
      setError("The agent name must be 1–32 characters.");
      return;
    }
    if (!trimmedDescription || trimmedDescription.length > 280) {
      setCreateError("The description must be 1–280 characters.");
      setError("The description must be 1–280 characters.");
      return;
    }
    if (createSkills.length === 0 || createSkills.length > SKILL_LIMIT) {
      setCreateError("Choose 1 to 5 skills.");
      setError("Choose 1 to 5 skills.");
      return;
    }
    setError("");
    setCreateError("");
    setCreating(true);
    try {
      setNotice("Waiting for the enrollment signature.");
      const opened = await fetch(`${apiBase}/enrollment/nonce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner, name: trimmedName }),
    });
    const nonceBody = (await opened.json()) as { nonce?: string; message?: string; error?: { message?: string } };
    if (!opened.ok || !nonceBody.nonce || !nonceBody.message) {
      throw new Error(nonceBody.error?.message ?? "Could not start enrollment.");
    }
    const signature = await sign(nonceBody.message);
      setNotice("Creating the agent wallet.");
    const created = await api("POST", "/enrollment", {
      owner,
        name: trimmedName,
      nonce: nonceBody.nonce,
      signature,
      });
      const platformId = String(created.platformId);
      setNotice("Writing the identity.");
      await api("POST", `/agents/${platformId}/workspace`, {
        path: "IDENTITY.md",
        content: `Name: ${trimmedName}\nDescription: ${trimmedDescription}\nRole: Personal agent\n`,
      });
      await deployOnSolana(platformId);
      setNotice("Listing the skills.");
      await api("POST", "/directory/publish", { platformId, skills: createSkills });
      setName("");
      setDescription("");
      setCreateSkills([]);
    const claim = created.claim as { message?: string } | undefined;
      sessionStorage.setItem(
        `${sessionKey}.notice`,
        `${trimmedName} is deployed. The identity is written and the identifier is on Solana. Install the signer with this claim message: ${claim?.message ?? ""}`
      );
      setNotice("Opening My agents.");
      router.push(`${profileBase}/mine`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The agent could not be created.";
      setNotice("");
      setCreateError(message);
      setError(message);
    } finally {
      setCreating(false);
    }
  }

  async function loadMessages(platformId: string) {
    const rows = await api("GET", `/agents/${platformId}/messages`);
    setMessages((rows.messages as ChatMessage[]) ?? []);
    setOwnerAsk(readOwnerAsk(rows.ask));
  }

  async function openAgent(platformId: string) {
    setError("");
    setThreadDenied("");
    const json = (await api("GET", `/agents/${platformId}`)) as unknown as Detail;
    if (!json.agent || json.agent.owner !== owner) {
      setDetail(null);
      setMessages([]);
      setOwnerAsk(null);
      setFiles({});
      setJobs([]);
      setAudit([]);
      setServers([]);
      setThreadDenied("Only the owner wallet can open this thread and its settings.");
      return;
    }
    setDetail(json);
    setPolicyText(JSON.stringify(json.policy ?? defaultPolicy(), null, 2));
    setDraft("");
    setMessages([]);
    try {
      const hired = await api("GET", `/agents/${platformId}/jobs`);
      setJobs((hired.jobs as JobView[]) ?? []);
      setReputation((hired.reputation as ReputationCard) ?? null);
    } catch {
      setJobs([]);
      setReputation(null);
    }
    const rows = await api("GET", `/agents/${platformId}/audit`);
    setAudit((rows.audit as typeof audit) ?? []);
    const taught = await api("GET", `/agents/${platformId}/workspace`);
    const nextFiles = (taught.files as Record<string, string>) ?? {};
    setFiles(nextFiles);
    setWorkspaceVersion(typeof taught.version === "number" ? taught.version : 0);
    setFilePath("SOUL.md");
    setFileDraft(nextFiles["SOUL.md"] ?? "");
    const mcp = await api("GET", `/agents/${platformId}/mcp`);
    setServers((mcp.servers as { name: string; url: string; status: string; tools: { name: string; enabled: boolean }[] }[]) ?? []);
    await loadMessages(platformId);
  }

  async function finishRegistry(platformId: string, pending: { asset: string; signature: string }) {
    await api("POST", `/agents/${platformId}/registry/confirm`, pending);
    setPendingRegistry(null);
    await openAgent(platformId);
    const listed = await api("GET", "/mine");
    setAgents((listed.agents as PublicAgent[]) ?? []);
  }

  async function registerIdentifier() {
    if (!detail) return;
    if (!publicKey || publicKey.toBase58() !== detail.agent.owner) {
      throw new Error("Connect the owner wallet for this agent.");
    }
    const existing = pendingRegistry?.platformId === detail.agent.platformId ? pendingRegistry : null;
    setRegistering(true);
    setError("");
    setNotice(existing ? "Waiting for the registration to land." : "Preparing the Solana registration.");
    try {
      if (existing) {
        await finishRegistry(detail.agent.platformId, existing);
        setNotice("Solana identifier registered.");
        return;
      }
      if (!sendTransaction) throw new Error("This wallet cannot sign transactions.");
      const assetKey = Keypair.generate();
      const prepared = await api("POST", `/agents/${detail.agent.platformId}/registry/prepare`, {
        asset: assetKey.publicKey.toBase58(),
      });
      const tx = Transaction.from(bytesFromBase64(String(prepared.transaction)));
      tx.partialSign(assetKey);
      const assetSigned = tx.signatures.some((entry) => entry.publicKey.equals(assetKey.publicKey) && entry.signature != null);
      if (!assetSigned) throw new Error("The asset key did not sign the registry transaction.");
      setNotice("Confirm the registration in your wallet.");
      const signature = await sendTransaction(tx, connection, {
        preflightCommitment: "confirmed",
        maxRetries: 0,
      });
      const pending = { platformId: detail.agent.platformId, asset: assetKey.publicKey.toBase58(), signature };
      setPendingRegistry(pending);
      setNotice("Waiting for the registration to land.");
      try {
        await connection.confirmTransaction(
          {
            signature,
            blockhash: String(prepared.blockhash),
            lastValidBlockHeight: Number(prepared.lastValidBlockHeight),
          },
          "confirmed"
        );
      } catch {
        // The confirm route reads the chain itself. The button can retry it.
      }
      await finishRegistry(detail.agent.platformId, pending);
      setNotice("Solana identifier registered.");
    } finally {
      setRegistering(false);
    }
  }

  useEffect(() => {
    if (screen !== "mine") return;
    const saved = sessionStorage.getItem(`${sessionKey}.notice`);
    if (!saved) return;
    sessionStorage.removeItem(`${sessionKey}.notice`);
    const timer = window.setTimeout(() => setNotice(saved), 0);
    return () => window.clearTimeout(timer);
  }, [screen, sessionKey]);

  useEffect(() => {
    if (screen !== "thread" || !token || !agentId) return;
    const key = `${token}:${agentId}`;
    if (openedThread.current === key) return;
    openedThread.current = key;
    setNotice("Opening the XMTP conversation.");
    void openAgent(agentId)
      .then(() => setNotice(""))
      .catch((err: Error) => {
        openedThread.current = "";
        setDetail(null);
        setError(err.message);
      });
  }, [agentId, owner, screen, token]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "end" });
  }, [messages, awaitingReply, ownerAsk]);

  async function sendChat(textOverride?: string) {
    if (!detail || sendingRef.current) return;
    const text = (textOverride ?? draft).trim();
    if (!text) return;
    const reply = textOverride ? true : needsReply;
    const local: ChatMessage = {
      id: `local-${Date.now()}`,
      from: { role: "owner", wallet: detail.agent.owner },
      text,
      replyExpected: reply,
      answeredAt: null,
      createdAt: Date.now(),
    };
    setMessages((current) => [...current, local]);
    setDraft("");
    setOwnerAsk(null);
    setError("");
    setFailedSendId("");
    setNotice("");
    sendingRef.current = true;
    setAwaitingReply(reply);
    try {
      const sent = await api("POST", `/agents/${detail.agent.platformId}/messages`, { text, replyExpected: reply });
      const run = sent.run as { version?: number; skills?: string[]; tools?: string[] } | undefined;
      if (run) {
        setRunSummary(
          `Workspace v${run.version ?? "?"}. Skills: ${(run.skills ?? []).join(", ") || "none"}. Tools used: ${(run.tools ?? []).join(", ") || "none"}.`
        );
      }
      setMessages((sent.messages as ChatMessage[]) ?? []);
      setOwnerAsk(readOwnerAsk(sent.ask));
      if ((run?.tools ?? []).includes("workspace_write") || (run?.tools ?? []).includes("memory_write") || (run?.tools ?? []).includes("memory_update")) {
        const taught = await api("GET", `/agents/${detail.agent.platformId}/workspace`);
        const nextFiles = (taught.files as Record<string, string>) ?? {};
        setFiles(nextFiles);
        setWorkspaceVersion(typeof taught.version === "number" ? taught.version : workspaceVersion);
        setFileDraft(nextFiles[filePath] ?? "");
      }
    } catch (err) {
      setFailedSendId(local.id);
      setError(err instanceof Error ? err.message : "The message was not sent.");
    } finally {
      sendingRef.current = false;
      setAwaitingReply(false);
    }
  }

  async function ownerCommand(purpose: string, extra: string, path: string, body: Record<string, unknown>) {
    if (!detail) return {};
    setNotice("Waiting for the wallet signature.");
    const nonceBody = (await api("POST", "/owner-nonce", {
      purpose,
      platformId: detail.agent.platformId,
      extra,
    })) as { nonce: string; message: string };
    const signature = await sign(nonceBody.message);
    const result = await api("POST", path, {
      ...body,
      platformId: detail.agent.platformId,
      nonce: nonceBody.nonce,
      signature,
    });
    await openAgent(detail.agent.platformId);
    return result;
  }

  async function savePolicy() {
    setNotice("Saving the policy.");
    const parsed = JSON.parse(policyText) as Policy;
    const policy: Policy = {
      perTxCapLamports: parsed.perTxCapLamports,
      dailyBudgetLamports: parsed.dailyBudgetLamports,
      allowedActions: parsed.allowedActions,
      allowedPrograms: parsed.allowedPrograms,
      allowedRecipients: parsed.allowedRecipients,
      allowedMints: parsed.allowedMints,
      maxPerMinute: parsed.maxPerMinute,
    };
    const extra = `policy: ${await sha256Hex(canonicalJson(policy))}`;
    await ownerCommand("policy", extra, `/agents/${detail?.agent.platformId}/policy`, policy);
    setNotice("Policy saved. Empty allow lists still deny.");
  }

  async function refreshModels() {
    const json = await api("GET", "/providers");
    setModelLinks((json.providers as { provider: string; hint: string; modelId: string; status: string; updatedAt?: number }[]) ?? []);
  }

  function pickProvider(next: string) {
    setModelProviderName(next);
    const existing = modelLinks.find((link) => link.provider === next);
    const list = MODELS[next as keyof typeof MODELS];
    setModelChoice(existing?.modelId ?? list[0]);
    setModelCredential("");
  }

  async function connectModel() {
    setError("");
    setConnecting(true);
    const linked = modelLinks.some((link) => link.provider === modelProviderName);
    const key = modelCredential.trim();
    try {
      if (linked && key.length < 20) {
        setNotice("Updating the model.");
        await api("POST", "/providers/model", { provider: modelProviderName, choice: modelChoice });
        await refreshModels();
        setNotice("Model updated. Name the agent next.");
        return;
      }
      setNotice(linked ? "Replacing the key." : "Storing the key.");
      await api("POST", linked ? "/providers/replace" : "/providers/connect", {
        provider: modelProviderName,
        credential: key,
      });
      setNotice("Saving the chosen model.");
      await api("POST", "/providers/model", { provider: modelProviderName, choice: modelChoice });
      setModelCredential("");
      await refreshModels();
      setNotice(linked ? "Key replaced. Name the agent next." : "Model connected. Name the agent next.");
    } finally {
      setConnecting(false);
    }
  }

  async function findAgents() {
    const skill = searchSkill;
    setError("");
    setNotice(skill ? "Searching listed agents." : "Loading listed agents.");
    setSearchingSkills(true);
    setSkillHits(null);
    try {
      const res = await fetch(`${apiBase}/directory/search?skill=${encodeURIComponent(skill)}`);
      const json = (await res.json()) as {
        hits?: { platformId: string; asset: string; skills: string[]; name?: string; description?: string }[];
        complete?: boolean;
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(json.error?.message ?? "Search failed.");
      const hits = json.hits ?? [];
      setSkillHits(hits);
      setSkillComplete(json.complete !== false);
      setNotice(hits.length === 0 ? "No Collective agent is listed." : `Found ${hits.length} listed agent${hits.length === 1 ? "" : "s"}.`);
    } catch (err) {
      setNotice("");
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setSearchingSkills(false);
    }
  }

  async function listSkill(skills: string[]) {
    if (!detail) return;
    setError("");
    const next = [...new Set(skills.map((skill) => skill.trim()).filter(Boolean))];
    if (next.length > SKILL_LIMIT) {
      setError("Choose at most 5 skills.");
      return;
    }
    setNotice(next.length === 0 ? "Clearing the listed skills." : "Listing the skills.");
    await api("POST", "/directory/publish", { platformId: detail.agent.platformId, skills: next });
    await openAgent(detail.agent.platformId);
    setNotice(next.length === 0 ? "Listed skills cleared." : "Skills listed.");
  }

  async function saveSkillFile() {
    if (!detail) return;
    const slug = skillSlug(skillSlugInput);
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) {
      setError("Name the skill with letters, numbers, or hyphens.");
      return;
    }
    const description = skillDescription.trim().replace(/\s+/g, " ").slice(0, 280);
    if (!description) {
      setError("Write a one-line description. The agent sees it on every turn.");
      return;
    }
    const body = skillBody.trim();
    if (!body) {
      setError("Write the skill instructions.");
      return;
    }
    const path = `skills/${slug}/SKILL.md`;
    const content = `---\nname: ${slug}\ndescription: ${description}\nenabled: ${skillEnabled ? "true" : "false"}\n---\n\n${body}\n`;
    setError("");
    setNotice(skillEnabled ? "Saving the skill." : "Turning the skill off.");
    const saved = await api("POST", `/agents/${detail.agent.platformId}/workspace`, { path, content });
    setFiles({ ...files, [path]: content });
    setSkillSlugInput(slug);
    setWorkspaceVersion(typeof saved.version === "number" ? saved.version : workspaceVersion);
    setNotice(skillEnabled ? "Skill saved. The next turn can load it." : "Skill turned off. The next turn will not load it.");
  }

  async function disconnectModel() {
    setError("");
    setNotice("Disconnecting the model.");
    await api("POST", "/providers/disconnect", { provider: modelProviderName });
    setModelCredential("");
    await refreshModels();
    setNotice("Model disconnected.");
  }

  const modelReady = modelLinks.length > 0;
  const delivered = Object.entries(files)
    .filter(([path]) => /^projects\/[a-z0-9][a-z0-9-]{0,31}\/[a-z0-9][a-z0-9._-]{0,64}\.(md|html|css|js|svg|txt)$/.test(path))
    .sort(([left], right) => left.localeCompare(right[0]))
    .map(([path, content]) => ({ path, content }));
  const steps = [
    { label: "Connect wallet", done: connected, current: !connected },
    { label: "Sign in", done: connected && Boolean(token), current: connected && !token },
    { label: "Connect a model", done: Boolean(token) && modelReady, current: Boolean(token) && !modelReady },
    { label: "Create the agent", done: Boolean(token) && modelReady && agents.length > 0, current: Boolean(token) && modelReady && agents.length === 0 },
  ];
  const activeLink = modelLinks.find((link) => link.provider === modelProviderName);
  const agentOverride = detail && agentPick?.platformId === detail.agent.platformId ? agentPick : null;
  const shownAgentProvider =
    agentOverride?.provider ?? detail?.agent.agentModel?.provider ?? modelLinks[0]?.provider ?? "muse";
  const shownAgentChoice =
    agentOverride?.modelId ??
    detail?.agent.agentModel?.modelId ??
    modelLinks.find((link) => link.provider === shownAgentProvider)?.modelId ??
    MODELS[shownAgentProvider as keyof typeof MODELS]?.[0] ??
    "muse-image-1.0";

  return (
    <div className="hire-ui space-y-8">
      <style>{`
        .hire-ui button { cursor: pointer; transition: transform 140ms ease, filter 140ms ease, box-shadow 140ms ease; }
        .hire-ui button:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.12); box-shadow: 0 8px 18px -14px rgba(0,0,0,.85); }
        .hire-ui button:active:not(:disabled) { transform: translateY(1px); filter: brightness(.88); box-shadow: none; }
        .hire-ui button:disabled { cursor: not-allowed; }
      `}</style>
      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-ink">{error}</p>
      ) : null}
      {notice ? (
        <p role="status" aria-live="polite" className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink">{notice}</p>
      ) : null}
      {(screen === "mine" || screen === "thread") && !connected ? (
        <section className="rounded-2xl border border-line bg-surface p-6">
          <h1 className="font-display text-4xl font-bold tracking-tight text-ink">{screen === "mine" ? "My agents" : "Thread"}</h1>
          <p className="mt-2 text-sm text-ink-2">Connect the owner wallet in the header. That wallet opens this page.</p>
        </section>
      ) : null}
      {(screen === "mine" || screen === "thread") && connected && !token ? (
        <section className="rounded-2xl border border-accent bg-accent/10 p-6">
          <h1 className="font-display text-4xl font-bold tracking-tight text-ink">{screen === "mine" ? "My agents" : "Thread"}</h1>
          <p className="mt-2 max-w-lg text-sm text-ink-2">
            One signature confirms {owner.slice(0, 4)}…{owner.slice(-4)} as the owner. It does not spend funds.
          </p>
          <button
            type="button"
            disabled={signingIn}
            className="mt-4 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent disabled:opacity-60"
            onClick={() => void signIn().catch((err: Error) => setError(err.message))}
          >
            {signingIn ? "Signing in…" : "Sign in"}
          </button>
        </section>
      ) : null}
      {screen === "setup" ? (
      <>
      <header className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Hire</p>
        <h1 className="font-display text-4xl font-bold tracking-tight text-ink">Bring your own model</h1>
        <p className="max-w-xl text-ink-2">
          Connect a model key. Collective stores it in Modal and runs each task in your sandbox. The key never sits in the sandbox.
        </p>
      </header>

      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, index) => (
          <li
            key={step.label}
            className={`flex items-center gap-3 rounded-xl border px-3 py-3 ${
              step.current ? "border-accent bg-accent/10" : "border-line bg-surface"
            }`}
          >
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                step.done ? "bg-accent text-on-accent" : step.current ? "bg-ink text-bg" : "bg-raised text-ink-3"
              }`}
            >
              {step.done ? "✓" : index + 1}
            </span>
            <span className={`text-sm font-semibold ${step.done || step.current ? "text-ink" : "text-ink-3"}`}>{step.label}</span>
          </li>
        ))}
      </ol>

      <section className="rounded-2xl border border-line bg-surface p-6">
        <h2 className="font-display text-2xl font-bold text-ink">Find a listed agent</h2>
        <p className="mt-2 max-w-lg text-sm text-ink-2">
          Leave the skill blank to see every listed agent, or choose one skill. A result is kept only when the registry account and the asset both point at our registration file, the owner matches, and ATOM is off.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <select
            value={searchSkill}
            onChange={(event) => setSearchSkill(event.target.value)}
            className="min-w-64 flex-1 rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink"
          >
            <option value="">All skills</option>
            <SkillOptions />
          </select>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-60"
            disabled={searchingSkills}
            onClick={() => void findAgents()}
          >
            {searchingSkills ? "Searching…" : searchSkill ? "Search" : "Show all"}
          </button>
        </div>
        {skillHits && !skillComplete ? (
          <p className="mt-3 text-sm text-ink-2">The index has more matches than this search read.</p>
        ) : null}
        {skillHits ? (
          skillHits.length === 0 ? (
            <p className="mt-3 text-sm text-ink-2">No Collective agent is listed.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {skillHits.map((hit) => (
                <li key={hit.asset}>
                  <Link href={`${profileBase}/${hit.platformId}`} className="text-sm font-semibold text-accent">
                    {hit.name || hit.platformId}
                  </Link>
                  {hit.description ? <p className="text-sm text-ink-2">{hit.description}</p> : null}
                  <p className="break-all font-mono text-xs text-ink-2">{hit.asset}</p>
                  <p className="text-xs text-ink-2">{hit.skills.join(", ")}</p>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>

      {!connected ? (
        <section className="rounded-2xl border border-line bg-surface p-6">
          <h2 className="font-display text-2xl font-bold text-ink">Connect your wallet</h2>
          <p className="mt-2 max-w-lg text-sm text-ink-2">
            Use the wallet button in the header. That wallet is the owner of the model and of any agent you register.
          </p>
        </section>
      ) : !token ? (
        <section className="rounded-2xl border border-accent bg-accent/10 p-6">
          <h2 className="font-display text-2xl font-bold text-ink">Sign in with this wallet</h2>
          <p className="mt-2 max-w-lg text-sm text-ink-2">
            One signature confirms {owner.slice(0, 4)}…{owner.slice(-4)} as the owner. It does not spend funds.
          </p>
        <button
          type="button"
            disabled={signingIn}
            className="mt-4 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
          onClick={() => void signIn().catch((err: Error) => setError(err.message))}
        >
            {signingIn ? "Signing in…" : "Sign in"}
        </button>
        </section>
      ) : (
        <>
        <section className={`rounded-2xl border p-6 ${modelReady ? "border-line bg-surface" : "border-accent bg-accent/10"}`}>
          <h2 className="font-display text-2xl font-bold text-ink">{modelReady ? "Your model" : "Connect a model"}</h2>
          <p className="mt-2 max-w-lg text-sm text-ink-2">
            {modelReady
              ? "Every agent you own uses this key. Tasks run in your sandbox."
              : "Paste the provider key. It is stored in our Modal workspace and injected only on the way out to that provider."}
          </p>
          {modelLinks.length > 0 ? (
            <ul className="mt-4 space-y-2">
              {modelLinks.map((link) => (
                <li key={link.provider} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-sm">
                  <span className="font-semibold text-ink">{PROVIDERS.find((item) => item.id === link.provider)?.label ?? link.provider}</span>
                  <span className="text-ink-2">{MODEL_LABELS[link.modelId] ?? link.modelId} · key {link.hint}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Model provider">
            {PROVIDERS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={modelProviderName === item.id}
                className={`rounded-full px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  modelProviderName === item.id ? "bg-ink text-bg" : "border border-line-strong text-ink"
                }`}
                onClick={() => pickProvider(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="mt-4 block text-sm text-ink-2">
            Model
            <select
              value={modelChoice}
              onChange={(event) => setModelChoice(event.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-ink"
            >
              {MODELS[modelProviderName as keyof typeof MODELS].map((id) => (
                <option key={id} value={id}>{MODEL_LABELS[id] ?? id}</option>
              ))}
            </select>
          </label>
          {modelProviderName === "muse" ? (
            <p className="mt-2 text-sm text-ink-2">
              You can chat with any of these. Spark and Wonder answer directly. Image, Transcription, and SAM talk through Muse Spark on the same key, then Image adds a picture, Transcription adds a transcript when the message has an https WAV link, and SAM adds boxes when the message has an object name and an https image link.
            </p>
          ) : null}
          <label className="mt-3 block text-sm text-ink-2">
            API key
            <input
              type="password"
              value={modelCredential}
              onChange={(event) => setModelCredential(event.target.value)}
              autoComplete="off"
              placeholder={activeLink ? "Paste a new key to replace it" : "Paste the provider key"}
              className="mt-1 w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-ink"
            />
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={connecting || (!activeLink && modelCredential.trim().length < 20)}
              className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
              onClick={() => void connectModel().catch((err: Error) => setError(err.message))}
            >
              {connecting
                ? "Connecting…"
                : activeLink && modelCredential.trim().length >= 20
                  ? "Replace key"
                  : activeLink
                    ? "Use this model"
                    : "Connect model"}
            </button>
            {activeLink ? (
              <button
                type="button"
                className="rounded-full border border-line-strong px-5 py-2.5 text-sm font-semibold text-ink"
                onClick={() => void disconnectModel().catch((err: Error) => setError(err.message))}
              >
                Disconnect
              </button>
            ) : null}
          </div>
        </section>
          <section className="space-y-4 rounded-2xl border border-line bg-surface p-6">
            {modelReady ? (
              <div className="space-y-4 rounded-xl border border-accent bg-accent/10 p-4">
                <h2 className="font-display text-xl font-bold text-ink">Create the agent</h2>
                <p className="text-sm text-ink-2">
                  Name it, describe it, and choose up to 5 skills. Creating writes the identity, creates the agent wallet for this owner, and registers the agent on Solana. My agents opens next.
                </p>
            <label className="block text-sm text-ink-2">
              Name
              <input
                value={name}
                    maxLength={32}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-ink"
              />
            </label>
            <label className="block text-sm text-ink-2">
                  Description
                  <textarea
                    value={description}
                    maxLength={280}
                    rows={3}
                    onChange={(event) => setDescription(event.target.value)}
                    className="mt-1 w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-ink"
              />
            </label>
                <label className="block text-sm text-ink-2">
                  Skill
                  <select
                    value=""
                    disabled={createSkills.length >= SKILL_LIMIT}
                    onChange={(event) => {
                      const skill = event.target.value;
                      if (!skill || createSkills.includes(skill) || createSkills.length >= SKILL_LIMIT) return;
                      setCreateSkills([...createSkills, skill]);
                    }}
                    className="mt-1 w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-ink"
                  >
                    <option value="">{createSkills.length >= SKILL_LIMIT ? "Five skills chosen" : "Choose a skill"}</option>
                    <SkillOptions taken={createSkills} />
                  </select>
                </label>
                {createSkills.length > 0 ? (
                  <ul className="flex flex-wrap gap-2">
                    {createSkills.map((skill) => (
                      <li key={skill}>
            <button
              type="button"
                          className="rounded-full border border-line-strong px-3 py-1 text-xs font-semibold text-ink"
                          onClick={() => setCreateSkills(createSkills.filter((item) => item !== skill))}
            >
                          {skillWords(skill.split("/").at(-1) ?? skill)} · Remove
            </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                  <button
                    type="button"
                  disabled={creating}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-60"
                  onClick={() => void createAndDeploy()}
                  >
                  {creating ? notice || "Creating…" : "Create and deploy"}
                  </button>
                {creating ? (
                  <p role="status" aria-live="polite" className="text-sm text-ink">{notice || "Working."}</p>
                ) : null}
                {createError ? (
                  <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-ink">{createError}</p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-ink-2">Connect a model. The name, description, and skill come next.</p>
            )}
            {agents.length > 0 ? (
              <Link href={`${profileBase}/mine`} className="inline-flex rounded-full border border-line-strong px-4 py-2 text-sm font-semibold text-ink">
                My agents ({agents.length})
              </Link>
            ) : null}
          </section>
        </>
      )}
      </>
      ) : null}

      {screen === "mine" && connected && token ? (
        <section className="space-y-4">
          <header className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Hire</p>
            <h1 className="font-display text-4xl font-bold tracking-tight text-ink">My agents</h1>
            <p className="max-w-xl text-sm text-ink-2">Open an agent to talk with it. Workspace, skills, and the other controls are on the left.</p>
          </header>
          {agents.length === 0 ? (
            <p className="rounded-2xl border border-line bg-surface p-6 text-sm text-ink-2">
              No agents yet. <Link href={profileBase} className="font-semibold text-accent">Create one</Link>
            </p>
          ) : (
            <ul className="grid gap-3">
              {agents.map((agent) => (
                <li key={agent.platformId}>
                  <Link
                    href={`${profileBase}/${agent.platformId}/thread`}
                    className="block rounded-2xl border border-line bg-surface p-4 transition hover:-translate-y-0.5 hover:border-accent"
                  >
                    <span className="font-display text-2xl font-bold text-ink">{agent.name}</span>
                    <span className="mt-1 block text-sm text-ink-2">
                      {agent.status}
                      {agent.identifier ? "" : " · registration still open"}
                    </span>
                    <span className="mt-2 block break-all font-mono text-xs text-ink-3">{agent.identifier ?? agent.walletAddress}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          </section>
      ) : null}

      {screen === "thread" && connected && token && threadDenied ? (
        <section className="rounded-2xl border border-line bg-surface p-6">
          <h1 className="font-display text-4xl font-bold tracking-tight text-ink">Owner only</h1>
          <p className="mt-2 max-w-lg text-sm text-ink-2">{threadDenied}</p>
          <Link href={`${profileBase}/mine`} className="mt-4 inline-block text-sm font-semibold text-accent">My agents</Link>
        </section>
      ) : null}
      {screen === "thread" && connected && token && detail && !threadDenied ? (
        <div className="grid items-start gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <section className="order-1 flex h-[min(42rem,calc(100dvh-8rem))] min-h-[28rem] flex-col rounded-2xl border border-line bg-surface lg:order-2">
            <header className="border-b border-line px-4 py-3">
              <Link href={`${profileBase}/mine`} className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">My agents</Link>
              <h1 className="font-display text-2xl font-bold text-ink">{detail.agent.name}</h1>
              <p className="text-xs text-ink-2">
                {awaitingReply ? "The agent is replying." : runSummary || "This conversation is on XMTP. A hire stays a separate job."}
              </p>
            </header>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {messages.length === 0 ? (
                <p className="text-sm text-ink-2">No messages yet. Say something to {detail.agent.name}.</p>
              ) : (
                messages.map((message) => {
                  const mine = message.from.role === "owner" && message.from.wallet === detail.agent.owner;
                  return (
                    <div key={message.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                      <p className="mb-1 text-xs font-semibold text-ink-3">{speakerLabel(message, detail.agent.owner)}</p>
                      <p className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm text-ink ${mine ? "rounded-br-md bg-accent/15" : "rounded-bl-md bg-raised"}`}>
                        {message.text}
                      </p>
                      {failedSendId === message.id && error ? <p className="mt-1 max-w-[85%] text-xs text-danger">{error}</p> : null}
                    </div>
                  );
                })
              )}
              {awaitingReply ? (
                <div className="flex flex-col items-start" aria-live="polite">
                  <p className="mb-1 text-xs font-semibold text-ink-3">Agent</p>
                  <p className="rounded-2xl rounded-bl-md bg-raised px-3 py-2 text-sm text-ink-2">Replying…</p>
                </div>
              ) : null}
              <div ref={threadEnd} />
            </div>
            {ownerAsk && !awaitingReply ? (
              <OwnerAskBar
                key={`${ownerAsk.prompt}|${ownerAsk.inputLabel}|${ownerAsk.choices.join("|")}`}
                ask={ownerAsk}
                disabled={awaitingReply}
                onSend={(message) => {
                  void sendChat(message).catch((err: Error) => setError(err.message));
                }}
              />
            ) : null}
            <form
              className="border-t border-line p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void sendChat().catch((err: Error) => setError(err.message));
              }}
            >
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendChat().catch((err: Error) => setError(err.message));
                  }
                }}
                rows={2}
                maxLength={1000}
                placeholder={`Message ${detail.agent.name}`}
                className="w-full resize-none rounded-xl border border-line-strong bg-raised px-3 py-2 text-sm text-ink"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-ink-2">
                  <input type="checkbox" checked={needsReply} onChange={(event) => setNeedsReply(event.target.checked)} />
                  Ask for a reply
                </label>
                <button
                  type="submit"
                  disabled={awaitingReply || draft.trim().length === 0}
                  className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </form>
          </section>
          <aside className="order-2 flex h-[min(42rem,calc(100dvh-8rem))] min-h-[28rem] flex-col overflow-hidden rounded-2xl border border-line bg-surface lg:order-1">
            <div className="flex gap-1 overflow-x-auto border-b border-line p-2" role="tablist" aria-label="Agent settings">
              {([
                ["workspace", "Workspace"],
                ["skills", "Skills"],
                ["hires", "Hires"],
                ["policy", "Policy"],
                ["account", "Account"],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={panel === id}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${panel === id ? "bg-ink text-bg" : "text-ink"}`}
                  onClick={() => setPanel(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              <div className={panel === "account" ? "space-y-1" : "hidden"}>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Identifier</p>
                {detail.agent.identifier ? (
                  <p className="break-all font-mono text-sm text-ink">{detail.agent.identifier}</p>
                ) : (
                  <button
                    type="button"
                    className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent disabled:opacity-60"
                    disabled={registering}
                    onClick={() => void registerIdentifier().catch((err: Error) => setError(err.message))}
                  >
                    {registering ? "Registering…" : pendingRegistry?.platformId === detail.agent.platformId ? "Confirm registration" : "Register on Solana"}
                  </button>
                )}
                <p className="text-xs text-ink-2">The Solana agent-registry asset is the public identifier. The owner wallet signs it.</p>
                <p className="break-all font-mono text-xs text-ink-2">Internal {detail.agent.platformId}</p>
              <p className="break-all font-mono text-sm text-ink">{detail.agent.walletAddress}</p>
              <p className="text-sm text-ink-2">
                Status {detail.agent.status}. Balance{" "}
                {detail.balanceVerified ? `${detail.balanceLamports} lamports, re-read from chain` : "unread"}.
              </p>
              <p className="text-sm text-ink-2">
                XMTP {detail.agent.slimName ?? "unnamed"} · Skills{" "}
                {(detail.agent.directorySkills ?? []).map((skill) => skillWords(skill.split("/").at(-1) ?? skill)).join(", ") ||
                  "none listed"}{" "}
                ·
                Endpoint {detail.agent.endpoint ?? "not proved"}
              </p>
              <Link href={`${profileBase}/${detail.agent.platformId}`} className="text-sm font-semibold text-accent">
                Public profile
              </Link>
              </div>
              {panel === "skills" ? (
                <div className="space-y-3">
                  <p className="text-sm text-ink-2">
                    A skill is a SKILL.md file. Every turn sees its name and description. The agent reads the instructions when it loads the skill, and can save the file from the conversation.
                  </p>
                  {Object.keys(files).some((path) => SKILL_FILE.test(path)) ? (
                    <ul className="space-y-1">
                      {Object.keys(files)
                        .filter((path) => SKILL_FILE.test(path))
                        .sort()
                        .map((path) => {
                          const installed = SKILL_FILE.exec(path)?.[1] ?? path;
                          const parsed = readSkillFile(files[path] ?? "");
                          return (
                            <li key={path}>
                <button
                  type="button"
                                className="w-full rounded-md border border-line px-3 py-2 text-left text-sm text-ink"
                                onClick={() => {
                                  setSkillSlugInput(installed);
                                  setSkillDescription(parsed.description);
                                  setSkillBody(parsed.body);
                                  setSkillEnabled(parsed.enabled);
                                  setNotice(`Editing ${installed}.`);
                                }}
                              >
                                <span className="font-semibold">{installed}</span>
                                <span className="mt-1 block text-xs text-ink-2">{parsed.enabled ? "On" : "Off"} · {parsed.description || "No description"}</span>
                              </button>
                            </li>
                          );
                        })}
                    </ul>
                  ) : (
                    <p className="text-sm text-ink-2">No skills yet.</p>
                  )}
                  <button
                    type="button"
                    className="rounded-full border border-line-strong px-3 py-1.5 text-xs font-semibold text-ink"
                    onClick={() => {
                      setSkillSlugInput("");
                      setSkillDescription("");
                      setSkillBody("");
                      setSkillEnabled(true);
                      setNotice("New skill.");
                    }}
                  >
                    New skill
                  </button>
                  <label className="block text-sm text-ink-2">
                    Name
                    <input
                      value={skillSlugInput}
                      onChange={(event) => setSkillSlugInput(event.target.value)}
                      placeholder="review-delivery"
                      className="mt-1 w-full rounded-md border border-line-strong bg-raised px-3 py-2 font-mono text-sm text-ink"
                    />
                  </label>
                  <label className="block text-sm text-ink-2">
                    Description
                    <input
                      value={skillDescription}
                      maxLength={280}
                      onChange={(event) => setSkillDescription(event.target.value)}
                      className="mt-1 w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-sm text-ink"
                    />
                  </label>
                  <label className="block text-sm text-ink-2">
                    Instructions
                    <textarea
                      value={skillBody}
                      onChange={(event) => setSkillBody(event.target.value)}
                      rows={8}
                      className="mt-1 w-full rounded-md border border-line-strong bg-raised px-3 py-2 font-mono text-sm text-ink"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm text-ink-2">
                    <input type="checkbox" checked={skillEnabled} onChange={(event) => setSkillEnabled(event.target.checked)} />
                    Enabled
                  </label>
                  <button
                    type="button"
                    className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent"
                    onClick={() => void saveSkillFile().catch((err: Error) => setError(err.message))}
                  >
                    Save skill
                  </button>
                </div>
              ) : null}
              {panel === "account" && detail.agent.hireable === false ? (
                <p className="text-sm text-ink-2">This agent reviews deliveries. It is not listed for hire.</p>
              ) : panel === "account" && detail.agent.identifier ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Listed skills</p>
                  <p className="text-sm text-ink-2">
                    Choose up to 5 skills from the list. People find this agent by those skills.
                  </p>
                  <select
                    value=""
                    disabled={(detail.agent.directorySkills ?? []).length >= SKILL_LIMIT}
                    onChange={(event) => {
                      const skill = event.target.value;
                      const current = detail.agent.directorySkills ?? [];
                      if (!skill || current.includes(skill)) return;
                      void listSkill([...current, skill]).catch((err: Error) => setError(err.message));
                    }}
                    className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink disabled:opacity-60"
                  >
                    <option value="">
                      {(detail.agent.directorySkills ?? []).length >= SKILL_LIMIT
                        ? "Five skills selected"
                        : `Add a skill (${(detail.agent.directorySkills ?? []).length} of ${SKILL_LIMIT})`}
                    </option>
                    <SkillOptions taken={detail.agent.directorySkills ?? []} />
                  </select>
                  <ul className="space-y-1">
                    {(detail.agent.directorySkills ?? []).map((skill) => (
                      <li key={skill} className="flex items-center justify-between gap-2 text-sm text-ink">
                        <span>{skillWords(skill.split("/").at(-1) ?? skill)}</span>
                        <button
                          type="button"
                          className="text-xs font-semibold text-ink-2"
                  onClick={() =>
                            void listSkill((detail.agent.directorySkills ?? []).filter((item) => item !== skill)).catch(
                              (err: Error) => setError(err.message)
                            )
                          }
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : panel === "account" ? (
                <p className="text-xs text-ink-2">Register the agent on Solana before listing a skill.</p>
              ) : null}
              <div className={panel === "account" ? "space-y-3 rounded-lg border border-line bg-raised p-3" : "hidden"}>
                <p className="text-sm font-semibold text-ink">Agent model</p>
                <p className="text-xs text-ink-2">
                  The model this agent works with. Muse Spark and Muse Wonder are text models for chat. Muse Image, Transcription, and SAM do the work themselves and never fall back to a text model. Changing this fixes agents that already exist, with no re-enroll.
                </p>
                <label className="block text-sm text-ink-2">
                  Provider
                  <select
                    value={shownAgentProvider}
                    onChange={(event) => {
                      const next = event.target.value;
                      const existing = modelLinks.find((link) => link.provider === next);
                      setAgentPick({
                        platformId: detail.agent.platformId,
                        provider: next,
                        modelId: existing?.modelId ?? MODELS[next as keyof typeof MODELS][0],
                      });
                    }}
                    className="mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-ink"
                  >
                    {PROVIDERS.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm text-ink-2">
                  Model
                  <select
                    value={shownAgentChoice}
                    onChange={(event) =>
                      setAgentPick({ platformId: detail.agent.platformId, provider: shownAgentProvider, modelId: event.target.value })
                    }
                    className="mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-ink"
                  >
                    {MODELS[shownAgentProvider as keyof typeof MODELS].map((id) => (
                      <option key={id} value={id}>{MODEL_LABELS[id] ?? id}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="rounded-md border border-line-strong px-3 py-2 text-sm text-ink"
                  onClick={() => {
                    setNotice("Saving the agent model.");
                    void ownerCommand("model", `model: ${shownAgentProvider}/${shownAgentChoice}`, `/agents/${detail.agent.platformId}/model`, {
                      provider: shownAgentProvider,
                      choice: shownAgentChoice,
                    })
                      .then((json) => {
                        const saved = (json as { agent?: PublicAgent }).agent;
                        if (saved) setDetail((current) => (current ? { ...current, agent: { ...current.agent, ...saved } } : current));
                        setNotice("Agent model saved. The next work pass uses it.");
                      })
                      .catch((err: Error) => setError(err.message));
                  }}
                >
                  Save agent model
                </button>
                {detail.agent.agentModel ? (
                  <p className="text-xs text-ink-2">Now: {MODEL_LABELS[detail.agent.agentModel.modelId] ?? detail.agent.agentModel.modelId} ({detail.agent.agentModel.provider})</p>
                ) : (
                  <p className="text-xs text-ink-2">Now: the owner model from Your model.</p>
                )}
              </div>
              <div className={panel === "account" ? "flex flex-wrap gap-2" : "hidden"}>
                <button
                  type="button"
                  className="rounded-md border border-line-strong px-3 py-2 text-sm text-ink"
                  onClick={() => {
                    setNotice("Pausing the agent.");
                    void ownerCommand("pause", "", `/agents/${detail.agent.platformId}/pause`, {})
                      .then(() => setNotice("Agent paused."))
                      .catch((err: Error) => setError(err.message));
                  }}
                >
                  Pause
                </button>
                <button
                  type="button"
                  className="rounded-md border border-line-strong px-3 py-2 text-sm text-ink"
                  onClick={() => {
                    setNotice("Revoking credentials.");
                    void ownerCommand("revoke", "", `/agents/${detail.agent.platformId}/revoke`, {})
                      .then(() => setNotice("Credentials revoked."))
                      .catch((err: Error) => setError(err.message));
                  }}
                >
                  Revoke credentials
                </button>
                <button
                  type="button"
                  className="rounded-md border border-line-strong px-3 py-2 text-sm text-ink"
                  onClick={() => {
                    setNotice("Recording the installed signer.");
                    void ownerCommand(
                      "sign-credential",
                      "",
                      `/agents/${detail.agent.platformId}/sign-credential`,
                      { issued: true }
                    )
                      .then(() => setNotice("Signer credential recorded."))
                      .catch((err: Error) => setError(err.message));
                  }}
                >
                  Sign credential installed
                </button>
              </div>
              <p className={`text-sm text-ink-2 ${panel === "account" ? "" : "hidden"}`}>
                Create the agent&apos;s Privy signer and keep it on the agent machine.
                That signer cannot change the owner or export the key. Collective stores only that you installed it
                {detail.agent.signCredentialIssuedAt ? ` (${new Date(detail.agent.signCredentialIssuedAt).toISOString()})` : ""}.
              </p>
              <div className={`space-y-3 rounded-lg border border-line bg-raised p-3 ${panel === "workspace" ? "" : "hidden"}`}>
                <h3 className="font-display text-lg font-bold text-ink">Workspace</h3>
                {delivered.length ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Delivered files</p>
                      <button type="button" className="text-xs font-semibold text-ink-2" onClick={() => setShowDelivered((current) => !current)}>
                        {showDelivered ? "Hide" : "Show"}
                      </button>
                    </div>
                    {showDelivered ? <DeliveryFiles files={delivered} openPath={openDelivery} onOpen={setOpenDelivery} /> : null}
                  </div>
                ) : null}
                <p className="text-sm text-ink-2">
                  Workspace v{workspaceVersion}. Identity, personality, instructions, and memory are separate files. MCP tools are registered by the runtime.
                </p>
                <label className="block text-sm text-ink-2">
                  File
                  <select
                    value={filePath}
                    onChange={(event) => {
                      const next = event.target.value;
                      setFilePath(next);
                      setFileDraft(files[next] ?? "");
                    }}
                    className="mt-1 w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink"
                  >
                    {[...new Set(["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "MEMORY.md", "BOOT.md", "TOOLS.md", "HEARTBEAT.md", "BOOTSTRAP.md", ...Object.keys(files)])]
                      .sort()
                      .map((path) => (
                        <option key={path} value={path}>
                          {path}
                        </option>
                      ))}
                  </select>
                </label>
                  <textarea
                  value={fileDraft}
                  onChange={(event) => setFileDraft(event.target.value)}
                  rows={8}
                  className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 font-mono text-sm text-ink"
                />
                <button
                  type="button"
                  className="rounded-full bg-exec px-4 py-2 text-sm font-semibold text-[#221302]"
                  onClick={() => {
                    setNotice("Saving the file.");
                    void api("POST", `/agents/${detail.agent.platformId}/workspace`, { path: filePath, content: fileDraft })
                      .then((saved) => {
                        setFiles({ ...files, [filePath]: fileDraft });
                        setWorkspaceVersion(typeof saved.version === "number" ? saved.version : workspaceVersion);
                        setNotice("Saved. The next turn uses this workspace version.");
                      })
                      .catch((err: Error) => setError(err.message));
                  }}
                >
                  Save file
                </button>
                <p className="text-sm text-ink-2">
                  Identity, personality, and instructions live in these files. A skill the agent can load is written on the Skills page.
                </p>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-ink">MCP servers</p>
                  {servers.map((server) => (
                    <div key={server.name} className="space-y-2 rounded-md border border-line px-3 py-2 text-sm text-ink">
                      <p className="break-all">
                        {server.name} · {server.status} · {server.url}
                        {server.lastError ? ` · ${server.lastError}` : ""}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {server.tools.map((tool) => (
                <button
                            key={tool.name}
                  type="button"
                            className="rounded-full border border-line-strong px-3 py-1 text-xs text-ink"
                            onClick={() => {
                              setNotice(tool.enabled ? "Turning the tool off." : "Turning the tool on.");
                              void api("POST", `/agents/${detail.agent.platformId}/mcp`, {
                                action: "tool",
                                name: server.name,
                                tool: tool.name,
                                enabled: !tool.enabled,
                              })
                      .then((json) => {
                                  const next = json.server as (typeof servers)[number] | undefined;
                                  if (!next) return;
                                  setServers((current) => current.map((item) => (item.name === next.name ? next : item)));
                                  setNotice("Tool updated.");
                                })
                                .catch((err: Error) => setError(err.message));
                            }}
                          >
                            {tool.name} {tool.enabled ? "on" : "off"}
                </button>
                        ))}
              </div>
                    </div>
                  ))}
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input
                      value={mcpName}
                      onChange={(event) => setMcpName(event.target.value)}
                      placeholder="server name"
                    className="rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink"
                    />
                  <input
                      value={mcpUrl}
                      onChange={(event) => setMcpUrl(event.target.value)}
                      placeholder="https://…"
                    className="rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink"
                  />
                </div>
                <input
                    value={mcpBearer}
                    onChange={(event) => setMcpBearer(event.target.value)}
                  type="password"
                    placeholder="bearer credential, stored outside the workspace"
                  className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink"
                />
                  <button
                    type="button"
                    className="rounded-md border border-line-strong px-3 py-2 text-sm text-ink"
                    onClick={() => {
                      const name = mcpName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
                      if (!name || !mcpUrl.trim()) return;
                      setNotice("Connecting the MCP server.");
                      void api("POST", `/agents/${detail.agent.platformId}/mcp`, {
                        action: "connect",
                        name,
                        url: mcpUrl.trim(),
                        auth: mcpBearer.trim() ? "bearer" : "none",
                        bearer: mcpBearer.trim(),
                      })
                        .then(() => api("GET", `/agents/${detail.agent.platformId}/mcp`))
                        .then((mcp) => {
                          setServers((mcp.servers as typeof servers) ?? []);
                          setMcpBearer("");
                          setNotice("MCP server saved. Its tools register after it connects.");
                        })
                        .catch((err: Error) => setError(err.message));
                    }}
                  >
                    Connect MCP server
                  </button>
                </div>
              </div>
              <div className={`space-y-3 rounded-lg border border-line bg-raised p-3 ${panel === "hires" ? "" : "hidden"}`}>
                <h3 className="font-display text-lg font-bold text-ink">Hires</h3>
                <p className="text-sm text-ink-2">
                  {reputation == null
                    ? "Receipts are unavailable."
                    : reputation.history === "none"
                      ? "no history"
                      : `${reputation.settled} settled, ${reputation.rejected} rejected, ${reputation.expired} expired, ${reputation.unanswered} unanswered.`}
                  {reputation?.badge ? " Badge earned." : ""}
                </p>
                {jobs.length === 0 ? (
                  <p className="text-sm text-ink-2">No hires yet.</p>
                ) : (
                  jobs.map((job) => {
                    const padded = /^\d+$/.test(job.priceBaseUnits) ? job.priceBaseUnits.padStart(7, "0") : "";
                    const dollars = padded ? padded.slice(0, -6).replace(/^0+/, "") || "0" : job.priceBaseUnits;
                    const cents = padded ? padded.slice(-6).replace(/0+$/, "") : "";
                    const price = cents ? `${dollars}.${cents} USDC` : `${dollars} USDC`;
                    return (
                      <Link key={job.id} href={`${profileBase}/jobs/${job.id}`} className="block space-y-1 rounded-md border border-line p-3 text-sm hover:border-accent">
                        <p className="font-semibold text-ink">
                          {job.status} · {price}
                        </p>
                        <p className="text-ink-2">{job.terms}</p>
                        <p className="text-xs font-semibold text-accent">Open hire</p>
                      </Link>
                    );
                  })
                )}
              </div>
              <div className={panel === "policy" ? "space-y-3" : "hidden"}>
              <p className="text-sm text-ink-2">
                Allow pay for a hire. The amount is USDC base units, six decimals to a dollar.
              </p>
              <label className="block text-sm text-ink-2">
                Policy
                <textarea
                  value={policyText}
                  onChange={(event) => setPolicyText(event.target.value)}
                  rows={12}
                  className="mt-1 w-full rounded-md border border-line-strong bg-raised px-3 py-2 font-mono text-xs text-ink"
                />
              </label>
              <button
                type="button"
                className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent"
                onClick={() => void savePolicy().catch((err: Error) => setError(err.message))}
              >
                Sign and save policy
              </button>
              </div>
              <ul className={`space-y-2 text-sm ${panel === "account" ? "" : "hidden"}`}>
                {audit.map((row, index) => (
                  <li key={`${row.createdAt}-${index}`} className="rounded-md border border-line px-3 py-2">
                    <span className="font-semibold text-ink">{row.label}</span>
                    <span className="ml-2 text-ink-2">{row.summary}</span>
                  </li>
                ))}
              </ul>
        </div>
          </aside>
        </div>
      ) : null}
      {screen === "thread" && connected && token && !detail && !threadDenied ? (
        <p role="status" aria-live="polite" className="rounded-2xl border border-line bg-surface p-6 text-sm text-ink">Opening the thread.</p>
      ) : null}
    </div>
  );
}
