import { AgentsError } from "../errors";
import { chosenModelForAgent, noteModelTurn } from "../providers";
import { museSpecialty, museTalkModel, runModel, type ModelMessage, type ModelTool } from "../sandbox";
import type { StoredAgent } from "../store";
import { legacySelf, readFile, writeAgentSelf } from "../workspace";
import { now } from "../workspace";
import { heartbeatInterval } from "./boot";
import { changeWorkspace, loadRuntime, loadWorkspace, listServers, saveRuntime } from "./persist";
import { compileOwnerChat } from "./context";
import { withIdentifier } from "./registry";
import { pinSession, type SessionPin } from "./session";
import { executeTool, toolSpecs } from "./tools";
import type { AgentRun, AgentRunKind, AgentScope } from "./types";
import type { OwnerAsk } from "../owner-ask";
import { listOwnerThread } from "../xmtp-thread";

export type AgentTurn = {
  text: string;
  run: AgentRun;
  skipped?: string;
};

const tails = new Map<string, Promise<unknown>>();
const rounds = 5;

function specialtyGuidance(modelId: string): string {
  if (modelId === "muse-image-1.0") {
    return "Your image model runs when the owner asks for a picture. Answer in words. An image link is added after your answer. Do not invent a link.";
  }
  if (modelId === "muse-voice-transcribe-1.0") {
    return "Your transcription model runs when the owner asks about an audio file. If a transcript is included, talk about that transcript. If no audio link was included, answer in words and ask for an https WAV link.";
  }
  return "Your segmentation model runs when the owner asks about an object in an image. If segmentation is included, talk about those boxes. If no image link was included, answer in words and ask for an object name plus an https image link.";
}

function serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  tails.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

function scopeFor(kind: AgentRunKind, peer: boolean): AgentScope {
  if (peer) return "peer";
  if (kind === "heartbeat") return "heartbeat";
  if (kind === "task") return "task";
  return "owner";
}

function emptyRun(pin: SessionPin, kind: AgentRunKind, provider: string, modelId: string): AgentRun {
  return {
    version: pin.version,
    kind,
    provider,
    modelId,
    skills: pin.skills,
    tools: [],
    memory: [],
    files: [],
    truncated: pin.truncated,
    bootChecks: pin.bootChecks,
  };
}

function configured(identity: string): boolean {
  return /^Name:\s*\S/m.test(identity) && /^Role:\s*\S/m.test(identity);
}

function ownerChatInput(turns: { fromRole: string; text: string }[], message: string): string {
  const prior = turns.slice(-12);
  const last = prior.at(-1);
  if (last?.fromRole === "owner" && last.text.trim() === message.trim()) prior.pop();
  const lines = prior.map((turn) => `${turn.fromRole === "owner" ? "Owner" : "Agent"}: ${turn.text.slice(0, 2_000)}`);
  lines.push(`Owner: ${message}`);
  return lines.join("\n\n");
}

async function turn(
  agent: StoredAgent,
  text: string,
  kind: AgentRunKind,
  peer: boolean,
  onStep?: (line: string) => void | Promise<void>
): Promise<AgentTurn> {
  let workspace = await loadWorkspace(agent.platformId, agent.name);
  const legacy = kind === "chat" && !peer ? legacySelf(readFile(workspace, "IDENTITY.md")) : null;
  if (legacy) {
    workspace = await changeWorkspace(agent.platformId, agent.name, (draft) => {
      writeAgentSelf(draft, legacy.name, legacy.description);
    });
  } else if (kind === "chat" && !peer && !workspace.bootstrapComplete && configured(readFile(workspace, "IDENTITY.md"))) {
    workspace = await changeWorkspace(agent.platformId, agent.name, (draft) => {
      draft.bootstrapComplete = true;
      delete draft.files["BOOTSTRAP.md"];
    });
  }
  if (kind === "heartbeat") {
    const interval = heartbeatInterval(workspace);
    const runtime = await loadRuntime(agent.platformId);
    if (interval == null) {
      return { text: "", skipped: "This agent has no heartbeat.", run: emptyRun({ platformId: agent.platformId, version: workspace.version, system: "", skills: [], truncated: [], bootChecks: [], bootedAt: 0 }, kind, "", "") };
    }
    if (runtime.lastHeartbeatAt && now() - runtime.lastHeartbeatAt < interval) {
      return { text: "", skipped: "The heartbeat is not due.", run: emptyRun({ platformId: agent.platformId, version: workspace.version, system: "", skills: [], truncated: [], bootChecks: [], bootedAt: runtime.lastBootAt }, kind, "", "") };
    }
  }
  const chosen = await chosenModelForAgent(agent);
  noteModelTurn(agent.owner);
  const talk = chosen.provider === "muse" ? museTalkModel(chosen.modelId) : null;
  const voiceModel = talk ?? chosen.modelId;
  const servers = await listServers(agent.platformId);
  const pin = pinSession(workspace, servers, peer ? "peer" : "owner");
  const system = withIdentifier(pin.system, agent.registryAsset);
  const scope = scopeFor(kind, peer);
  const tools = toolSpecs(scope, servers, !workspace.bootstrapComplete);
  const input = kind === "heartbeat" ? `Heartbeat tick. Follow this task and use tools when they help.\n\n${readFile(workspace, "HEARTBEAT.md")}` : text;
  let guidance = system;
  let aside = "";
  if (kind === "chat" && !peer) {
    guidance = withIdentifier(compileOwnerChat(workspace, servers), agent.registryAsset);
  }
  if (talk && kind === "chat") {
    guidance = `${guidance}\n\n${specialtyGuidance(chosen.modelId)}`;
    if (chosen.modelId !== "muse-image-1.0") {
      try {
        noteModelTurn(agent.owner);
        const extra = await museSpecialty(agent.owner, chosen.modelId, text);
        if (extra) aside = `\n\n${extra}`;
      } catch {
        aside = "";
      }
    }
  }
  if (talk && kind !== "chat") {
    // Muse Spark is the chat fallback only. Work runs on the model the owner
    // chose at the start. Image, transcription, and SAM have no tool
    // conversation, so the task goes straight to that model and its result
    // is the work product. It never falls back to Spark.
    if (onStep && kind === "task") {
      await onStep(`Working with ${chosen.modelId}. The worker is in the sandbox.`);
    }
    const result = await museSpecialty(agent.owner, chosen.modelId, text);
    if (!result.trim()) {
      throw new AgentsError("PROVIDER_UNAVAILABLE", "The chosen model returned no result for this task.", 502);
    }
    if (onStep && kind === "task") {
      await onStep(`The chosen model, ${chosen.modelId}, returned its result.`);
    }
    const run = emptyRun(pin, kind, chosen.provider, chosen.modelId);
    const runtime = await loadRuntime(agent.platformId);
    await saveRuntime({
      platformId: agent.platformId,
      lastBootAt: pin.bootedAt,
      lastHeartbeatAt: kind === "heartbeat" ? now() : runtime.lastHeartbeatAt,
      lastRun: run,
      ownerAsk: runtime.ownerAsk ?? null,
    });
    return { text: result, run };
  }
  const messages: ModelMessage[] = [];
  if (kind === "chat" && !peer) {
    let thread: { fromRole: string; text: string }[] = [];
    try {
      thread = await listOwnerThread(agent);
    } catch {
      thread = [];
    }
    messages.push({ role: "user", content: `${ownerChatInput(thread, text)}${aside}` });
  } else {
    messages.push({ role: "user", content: `${input}${aside}` });
  }
  const called: string[] = [];
  const memory: string[] = [];
  const savedFiles: string[] = [];
  let answer = "";
  let asked: OwnerAsk | null = null;
  const limit = kind === "chat" ? 4 : rounds;
  if (onStep && kind === "task") {
    await onStep(`Working with ${chosen.modelId}. The worker is in the sandbox.`);
  }
  const runStep = async (toolsForStep: ModelTool[]): Promise<{ text: string; toolCalls: { id: string; name: string; arguments: string }[] }> => {
    try {
      return await runModel(agent.owner, chosen.provider, voiceModel, guidance, messages, toolsForStep);
    } catch (error) {
      if (onStep) {
        await onStep(`The model step failed: ${error instanceof Error ? error.message.slice(0, 240) : "The model did not answer."}`);
      }
      throw error;
    }
  };
  for (let round = 0; round < limit; round += 1) {
    if (onStep && kind === "task") await onStep(`Turn ${round + 1}. The worker is thinking.`);
    const step = await runStep(tools);
    if (!step.toolCalls.length) {
      answer = step.text;
      if (onStep && kind === "task") await onStep(`Turn ${round + 1}. The model finished this pass.`);
      break;
    }
    messages.push({ role: "assistant", content: step.text, toolCalls: step.toolCalls });
    for (const call of step.toolCalls) {
      let failed = false;
      const result = await executeTool(agent.platformId, agent.name, agent.owner, scope, servers, call.name, call.arguments).catch((error: unknown) => {
        failed = true;
        return {
          text: error instanceof AgentsError ? error.message : "The tool failed.",
          touched: [] as string[],
          ask: undefined,
        };
      });
      called.push(call.name);
      if (result.ask) asked = result.ask;
      const wroteNow: string[] = [];
      for (const path of result.touched) {
        if (path === "MEMORY.md" || path === "USER.md" || path.startsWith("memory/") || path === "BOOTSTRAP.md") memory.push(path);
        if (path.startsWith("projects/")) {
          savedFiles.push(path);
          wroteNow.push(path);
        }
      }
      if (onStep && kind === "task") {
        if (failed) {
          await onStep(`Turn ${round + 1}. ${call.name} failed: ${result.text.slice(0, 240)}`);
        } else if (wroteNow.length) {
          await onStep(`Turn ${round + 1}. Wrote ${[...new Set(wroteNow)].join(", ")}.`);
        } else {
          const output = result.text.replace(/\s+/g, " ").trim().slice(0, 280);
          await onStep(`Turn ${round + 1}. Ran ${call.name}.${output ? ` Output: ${output}` : ""}`);
        }
      }
      messages.push({ role: "tool", content: result.text, toolCallId: call.id, name: call.name });
    }
    answer = step.text;
    if (asked) break;
  }
  if (!asked && messages.at(-1)?.role === "tool") {
    const step = await runStep([]);
    if (step.text.trim()) answer = step.text;
  }
  if (asked && !answer.trim()) answer = asked.prompt;
  const run = emptyRun(pin, kind, chosen.provider, chosen.modelId);
  run.tools = called;
  run.memory = [...new Set(memory)];
  run.files = [...new Set(savedFiles)];
  const runtime = await loadRuntime(agent.platformId);
  await saveRuntime({
    platformId: agent.platformId,
    lastBootAt: pin.bootedAt,
    lastHeartbeatAt: kind === "heartbeat" ? now() : runtime.lastHeartbeatAt,
    lastRun: run,
    ownerAsk: kind === "chat" && !peer ? asked : runtime.ownerAsk ?? null,
  });
  if (talk && kind === "chat" && chosen.modelId === "muse-image-1.0") {
    try {
      noteModelTurn(agent.owner);
      const image = await museSpecialty(agent.owner, chosen.modelId, text);
      if (image) answer = `${answer}\n${image}`.trim();
    } catch {
      answer = answer.trim();
    }
  }
  if (!answer.trim()) {
    if (kind === "chat" && !peer) throw new AgentsError("PROVIDER_UNAVAILABLE", "The model returned no reply.", 502);
    answer = "The agent did not finish.";
  }
  return { text: answer, run };
}

export function runAgentTurn(
  agent: StoredAgent,
  text: string,
  kind: AgentRunKind,
  peer = false,
  onStep?: (line: string) => void | Promise<void>
): Promise<AgentTurn> {
  return serialize(agent.platformId, () => turn(agent, text, kind, peer, onStep));
}
