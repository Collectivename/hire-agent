import "server-only";
import { NextResponse } from "next/server";
import { AgentsError } from "./errors";
import { createNamedSecret, deleteNamedSecret, updateNamedSecret } from "./modal-secrets";
import { ensureOwnerSandbox, modelText, museTalkModel, refreshOwnerSandbox, runOwnerTask, runVisionReview, taskRequest, terminateOwnerSandbox } from "./sandbox";
import {
  OUTBOUND_POLICY_LIMIT,
  allowedModel,
  assertSpecHidesKey,
  byokSecretName,
  defaultModel,
  modelProvider,
  providerSpec,
  sandboxSpec,
  type ModelProvider,
} from "./modal-policy";
import { agentStore, type ProviderLink, type StoredAgent } from "./store";

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

function hintOf(credential: string): string {
  const tail = credential.slice(-4);
  return tail.length === 4 ? tail : "";
}

function view(link: ProviderLink) {
  return {
    provider: link.provider,
    status: link.status,
    hint: link.hint,
    modelId: link.modelId,
    secretName: link.secretName,
    storedIn: "modal",
    updatedAt: link.updatedAt,
  };
}

const turns = new Map<string, number[]>();

export function noteModelTurn(owner: string): void {
  const now = Date.now();
  const recent = (turns.get(owner) ?? []).filter((at) => at >= now - 60_000);
  if (recent.length >= 60) {
    throw new AgentsError("RATE_LIMITED", "This owner has reached the model request cap.", 429);
  }
  recent.push(now);
  turns.set(owner, recent);
}

export function resetModelTurns(): void {
  turns.clear();
}

export async function listOwnerProviders(owner: string): Promise<NextResponse> {
  const links = await agentStore().listProviders(owner);
  return json({
    providers: links.filter((link) => link.status === "connected").map(view),
    copy: "The credential is stored in our Modal workspace.",
  });
}

export async function connectProvider(owner: string, providerName: string, credential: string): Promise<NextResponse> {
  const provider = modelProvider(providerName);
  if (credential.trim().length < 20 || credential.length > 300) {
    throw new AgentsError("INVALID_PARAMS", "That credential is not a provider key.", 400);
  }
  const spec = providerSpec(provider);
  const name = byokSecretName(owner, provider);
  const box = sandboxSpec(owner, provider);
  assertSpecHidesKey(box, credential);
  await createNamedSecret(name, spec.env, credential);
  const now = Date.now();
  // Reconnecting a key must not silently reset the chosen model to the
  // provider default. Only a first connect starts on the default.
  const existing = await agentStore().getProvider(owner, provider);
  const link: ProviderLink = {
    owner,
    provider,
    secretName: name,
    status: "connected",
    hint: hintOf(credential),
    modelId: existing && existing.status === "connected" ? existing.modelId : defaultModel(provider),
    requestsToday: 0,
    day: new Date(now).toISOString().slice(0, 10),
    updatedAt: now,
  };
  await agentStore().saveProvider(link);
  let sandbox: { name: string; domains: string[] };
  try {
    sandbox = await ensureOwnerSandbox(owner);
  } catch (error) {
    await deleteNamedSecret(name).catch(() => undefined);
    await agentStore().saveProvider({ ...link, status: "disconnected", hint: "", updatedAt: Date.now() });
    throw error;
  }
  return json({
    provider: view(link),
    sandbox: {
      name: sandbox.name,
      created: true,
      injectionDomains: sandbox.domains,
      limit: OUTBOUND_POLICY_LIMIT,
    },
  });
}

export async function replaceProvider(owner: string, providerName: string, credential: string): Promise<NextResponse> {
  const provider = modelProvider(providerName);
  const existing = await agentStore().getProvider(owner, provider);
  if (!existing || existing.status !== "connected") {
    throw new AgentsError("NOT_FOUND", "That provider is not connected.", 404);
  }
  if (credential.trim().length < 20 || credential.length > 300) {
    throw new AgentsError("INVALID_PARAMS", "That credential is not a provider key.", 400);
  }
  const expected = byokSecretName(owner, provider);
  if (existing.secretName !== expected) {
    throw new AgentsError("POLICY_DENIED", "The stored secret name does not match this owner.", 403);
  }
  const spec = providerSpec(provider);
  await updateNamedSecret(expected, spec.env, credential);
  const box = sandboxSpec(owner, provider);
  assertSpecHidesKey(box, credential);
  await refreshOwnerSandbox(owner);
  const next: ProviderLink = {
    ...existing,
    hint: hintOf(credential),
    updatedAt: Date.now(),
  };
  await agentStore().saveProvider(next);
  return json({ provider: view(next), sandboxRefreshed: true });
}

export async function disconnectProvider(owner: string, providerName: string): Promise<NextResponse> {
  const provider = modelProvider(providerName);
  const existing = await agentStore().getProvider(owner, provider);
  if (!existing) throw new AgentsError("NOT_FOUND", "That provider is not connected.", 404);
  const expected = byokSecretName(owner, provider);
  if (existing.secretName !== expected) {
    throw new AgentsError("POLICY_DENIED", "The stored secret name does not match this owner.", 403);
  }
  await deleteNamedSecret(expected);
  await agentStore().saveProvider({ ...existing, status: "disconnected", hint: "", updatedAt: Date.now() });
  const remaining = (await agentStore().listProviders(owner)).filter((link) => link.status === "connected");
  if (remaining.length === 0) await terminateOwnerSandbox(owner);
  else await refreshOwnerSandbox(owner);
  return json({ provider, status: "disconnected" });
}

export async function selectModel(owner: string, providerName: string, modelId: string): Promise<NextResponse> {
  const provider = modelProvider(providerName);
  const existing = await agentStore().getProvider(owner, provider);
  if (!existing || existing.status !== "connected") {
    throw new AgentsError("NOT_FOUND", "That provider is not connected.", 404);
  }
  const choice = allowedModel(provider, modelId);
  const next = { ...existing, modelId: choice, updatedAt: Date.now() };
  await agentStore().saveProvider(next);
  return json({ provider: view(next) });
}

export function assertSuppliedSecret(owner: string, providerName: string, supplied: string): void {
  if (!supplied.startsWith("byok-")) return;
  const provider = modelProvider(providerName);
  if (supplied !== byokSecretName(owner, provider)) {
    throw new AgentsError("POLICY_DENIED", "Another owner's secret name is refused.", 403);
  }
}

export async function chosenModel(owner: string): Promise<{ provider: ModelProvider; modelId: string }> {
  const links = await agentStore().listProviders(owner);
  const connected = links
    .filter((link) => link.status === "connected")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const link = connected[0];
  if (!link) throw new AgentsError("NOT_FOUND", "Connect a model before talking to this agent.", 409);
  const provider = modelProvider(link.provider);
  return { provider, modelId: allowedModel(provider, link.modelId) };
}

/**
 * The model one agent runs on. A per-agent choice made by its owner wins over
 * the owner's global provider link, so existing agents can be moved between
 * models without re-enrolling. Text models (Muse Spark, Muse Wonder, and the
 * chat models of other providers) talk and use tools. A selected Muse
 * specialty model (Image, Transcription, SAM) is never swapped for a text
 * model outside chat: the agent loop routes work to it directly.
 */
export async function chosenModelForAgent(agent: {
  owner: string;
  agentModel?: { provider: string; modelId: string } | null;
}): Promise<{ provider: ModelProvider; modelId: string }> {
  const pick = agent.agentModel;
  if (pick?.provider && pick?.modelId) {
    try {
      const provider = modelProvider(pick.provider);
      const link = await agentStore().getProvider(agent.owner, provider);
      if (link?.status === "connected") {
        return { provider, modelId: allowedModel(provider, pick.modelId) };
      }
    } catch {
      // A stale per-agent choice falls back to the owner model.
    }
  }
  return chosenModel(agent.owner);
}

/** The agent's words come from the model chosen for this owner, with that agent's workspace in front. */
export async function speakWithChosenModel(
  owner: string,
  text: string,
  instructions: string
): Promise<{ provider: ModelProvider; modelId: string; text: string }> {
  const chosen = await chosenModel(owner);
  noteModelTurn(owner);
  // This is a written text answer (the supervisor review, its only caller).
  // A specialty Muse model has no text endpoint, so words come from the
  // Muse talk model on the same key. Work tasks never take this path: they
  // run on the chosen model in the agent loop.
  const effective = chosen.provider === "muse" ? (museTalkModel(chosen.modelId) ?? chosen.modelId) : chosen.modelId;
  const result = await runOwnerTask(owner, chosen.provider, effective, text, false, instructions);
  return { provider: chosen.provider, modelId: effective, text: modelText(chosen.provider, result.output) };
}

/** A written answer from one agent, on that agent's own chosen model. */
export async function speakForAgent(
  agent: StoredAgent,
  text: string,
  instructions: string,
  images: string[] = []
): Promise<{ provider: ModelProvider; modelId: string; text: string }> {
  const chosen = await chosenModelForAgent(agent);
  noteModelTurn(agent.owner);
  // Words need a text endpoint. A specialty Muse model has none, so the
  // Muse talk model on the same key writes the words. Work tasks never
  // take this path: they run on the agent's chosen model in the loop.
  const effective = chosen.provider === "muse" ? (museTalkModel(chosen.modelId) ?? chosen.modelId) : chosen.modelId;
  if (chosen.provider === "muse" && images.length) {
    try {
      const seen = await runVisionReview(agent.owner, effective, instructions, text, images.slice(0, 3));
      if (seen.trim()) return { provider: chosen.provider, modelId: effective, text: seen.trim() };
    } catch {
      // Fall through to the text answer below.
    }
  }
  const result = await runOwnerTask(agent.owner, chosen.provider, effective, text, false, instructions);
  return { provider: chosen.provider, modelId: effective, text: modelText(chosen.provider, result.output) };
}

export async function runConnectedTask(
  owner: string,
  providerName: string,
  text: string,
  suppliedModel: string,
  instructions = ""
): Promise<NextResponse> {
  const provider = modelProvider(providerName);
  assertSuppliedSecret(owner, providerName, suppliedModel);
  const link = await agentStore().getProvider(owner, provider);
  if (!link || link.status !== "connected") throw new AgentsError("NOT_FOUND", "That provider is not connected.", 404);
  const modelId = suppliedModel.startsWith("byok-") || !suppliedModel ? link.modelId : allowedModel(provider, suppliedModel);
  if (!text.trim() || text.length > 4000) throw new AgentsError("INVALID_PARAMS", "text is invalid.", 400);
  const task = taskRequest(provider, modelId, text, true, instructions);
  const result = await runOwnerTask(owner, provider, modelId, text, true, instructions);
  return json({ ...result, host: task.host });
}
