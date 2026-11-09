/**
 * Owner provider keys stay in named Modal secrets.
 * Run: npx tsx --conditions=react-server hire/scripts/byok-check.ts
 *
 * The Modal client is a fake. A live sandbox runs only when MODAL_TOKEN_ID
 * and BYOK_LIVE_KEY are both set, and this process still does not call the provider.
 */
import { NextRequest } from "next/server";
import { sha256Hex } from "../src/server/crypto";
import { assertSpecHidesKey, byokSecretName, sandboxSpec } from "../src/server/modal-policy";
import { useModalSecretClient } from "../src/server/modal-secrets";
import { handleAgentsRequest } from "../src/server/router";
import { imageLinks, museTalkModel, taskRequest, useSandboxRuntime, type TaskRequest } from "../src/server/sandbox";
import { agentStore } from "../src/server/store";

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const owner = "OwnerByok11111111111111111111111111111111";
const other = "OwnerOther111111111111111111111111111111";
const key = "sk-test-openai-key-000000000001";
const nextKey = "sk-test-openai-key-000000000002";

async function main(): Promise<void> {
  if (process.env.FIREBASE_SERVICE_ACCOUNT?.trim() || process.env.NODE_ENV === "production") {
    console.log("byok check skipped");
    return;
  }
  const calls: { op: string; task?: TaskRequest }[] = [];
  useSandboxRuntime({
    async ensure(owner, providers) {
      calls.push({ op: "ensure" });
      return { name: sandboxSpec(owner, providers[0] ?? "openai").name, domains: providers.map((provider) => sandboxSpec(owner, provider).experimentalOutboundPolicy.replacements[0]!.domain) };
    },
    async exec(_owner, task) {
      calls.push({ op: "exec", task });
      return { stdout: "200\n{\"ok\":true}", exitCode: 0 };
    },
    async updatePolicy() {
      calls.push({ op: "update" });
    },
    async terminate() {
      calls.push({ op: "terminate" });
    },
  });
  const secrets = new Map<string, Record<string, string>>();
  useModalSecretClient({
    async create(name, entries, requiredKeys) {
      if (secrets.has(name)) throw new Error("create does not replace an existing secret");
      if (!requiredKeys.every((key) => key in entries)) throw new Error("create is missing a required key");
      secrets.set(name, { ...entries });
    },
    async update(name, entries, requiredKeys) {
      const current = secrets.get(name) ?? {};
      if (!requiredKeys.every((key) => key in current || key in entries)) throw new Error("update is missing a required key");
      secrets.set(name, { ...current, ...entries });
    },
    async delete(name) {
      secrets.delete(name);
    },
    async lookup(name, requiredKeys) {
      const current = secrets.get(name);
      return Boolean(current && requiredKeys.every((key) => key in current));
    },
  });

  const now = Date.now();
  async function session(token: string, wallet: string) {
    const hash = sha256Hex(token);
    await agentStore().putSecret(hash, {
      kind: "owner-session",
      hash,
      platformId: "",
      owner: wallet,
      expiresAt: now + 60 * 60_000,
      revokedAt: null,
      createdAt: now,
    });
  }
  await session("own_byok", owner);
  await session("own_byok_other", other);

  async function call(token: string, method: string, path: string, body?: unknown) {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (body) headers.set("content-type", "application/json");
    const res = await handleAgentsRequest(
      new NextRequest(`http://localhost/api/agents/v1/${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      }),
      method,
      path.split("/").filter(Boolean)
    );
    const json = (await res.json()) as {
      error?: { code?: string; message?: string };
      provider?: { hint?: string; secretName?: string; modelId?: string };
    };
    return { status: res.status, json, text: JSON.stringify(json) };
  }

  const spec = sandboxSpec(owner, "openai");
  assertSpecHidesKey(spec, key);
  assert(spec.secrets.length === 0, "customer keys are not sandbox secrets");
  assert(!("outboundDomainAllowlist" in spec), "the outbound policy is not combined with a domain allowlist");
  assert(spec.experimentalOutboundPolicy.replacements[0]?.domain === "api.openai.com", "OpenAI host is exact");
  assert(spec.experimentalOutboundPolicy.replacements[0]?.requiredKeys[0] === "OPENAI_API_KEY", "OpenAI lookup requires its key");
  assert(sandboxSpec(owner, "anthropic").experimentalOutboundPolicy.replacements[0]?.domain === "api.anthropic.com", "Anthropic host is exact");
  assert(
    sandboxSpec(owner, "gemini").experimentalOutboundPolicy.replacements[0]?.domain === "generativelanguage.googleapis.com",
    "Gemini host is exact"
  );
  const muse = sandboxSpec(owner, "muse");
  assert(muse.experimentalOutboundPolicy.replacements[0]?.domain === "api.meta.ai", "Muse host is exact");
  assert(muse.experimentalOutboundPolicy.replacements[0]?.requiredKeys[0] === "MODEL_API_KEY", "Muse lookup requires its key");
  assert(muse.experimentalOutboundPolicy.replacements[0]?.headers.Authorization === "Bearer $MODEL_API_KEY", "Muse uses the bearer placeholder");
  assert(!JSON.stringify(muse).includes("*"), "Muse injection domain is exact");
  const spark = taskRequest("muse", "muse-spark-1.3", "hello", false);
  assert(spark.host === "api.meta.ai" && spark.path === "/v1/chat/completions" && spark.body.model === "muse-spark-1.3", "Muse Spark uses chat completions");
  const wonder = taskRequest("muse", "muse-wonder-1.0", "hello", false);
  assert(wonder.body.model === "muse-wonder-1.0" && wonder.path === "/v1/chat/completions", "Muse Wonder uses chat completions");
  const image = taskRequest("muse", "muse-image-1.0", "a red fox", false);
  assert(image.path === "/v1/images/generations" && image.body.model === "muse-image-1.0" && image.body.response_format === "url", "Muse Image uses image generation");
  const heard = taskRequest("muse", "muse-voice-transcribe-1.0", "notes https://cdn.example.com/note.wav", false);
  assert(heard.mode === "transcribe" && heard.audioUrl === "https://cdn.example.com/note.wav" && !JSON.stringify(heard.headers).toLowerCase().includes("authorization"), "Muse Transcription uploads the WAV");
  let samRefused = false;
  try {
    taskRequest("muse", "sam-3.1", "bus", false);
  } catch {
    samRefused = true;
  }
  assert(samRefused, "Muse SAM requires an image URL");
  const sam = taskRequest("muse", "sam-3.1", "yellow school bus https://cdn.example.com/street.png", false);
  assert(sam.host === "api.meta.ai" && sam.path === "/v1/responses" && sam.body.model === "sam-3.1", "Muse SAM uses the responses API");
  assert(museTalkModel("muse-image-1.0") === "muse-spark-1.3", "Muse Image chat talks through Muse Spark");
  assert(museTalkModel("muse-voice-transcribe-1.0") === "muse-spark-1.3", "Muse Transcription chat talks through Muse Spark");
  assert(museTalkModel("sam-3.1") === "muse-spark-1.3", "Muse SAM chat talks through Muse Spark");
  assert(museTalkModel("muse-spark-1.3") == null && museTalkModel("muse-wonder-1.0") == null, "Spark and Wonder stay the conversation");
  const picture = "Delivery:\nhttps://cdn.example.com/logo.png";
  assert(imageLinks(picture)[0] === "https://cdn.example.com/logo.png", "a delivery image link is recognized");
  assert(imageLinks("Delivery:\nhttps://cdn.example.com/notes.txt").length === 0, "a non-image link is not attached");
  const looked = taskRequest("muse", "muse-spark-1.3", picture, false, "Review the delivery.");
  assert(JSON.stringify(looked.body).includes('"image_url"') && JSON.stringify(looked.body).includes("https://cdn.example.com/logo.png"), "Muse Spark is shown the delivery image");
  const wondered = taskRequest("muse", "muse-wonder-1.0", picture, false);
  assert(JSON.stringify(wondered.body).includes('"image_url"'), "Muse Wonder is shown the delivery image");
  const described = taskRequest("openai", "gpt-4o", picture, false);
  assert(JSON.stringify(described.body).includes('"image_url"'), "a vision chat model is shown the delivery image");
  assert(!JSON.stringify(spec).includes("*"), "injection domains are exact");
  assert(!JSON.stringify(spec).includes("evil.example"), "a caller cannot add a host");

  const name = byokSecretName(owner, "openai");
  const connected = await call("own_byok", "POST", "providers/connect", { provider: "openai", credential: key });
  assert(connected.status === 200, `connect failed (${connected.json.error?.message ?? connected.status})`);
  assert(!connected.text.includes(key), "the connect response has no raw key");
  assert(secrets.get(name)?.OPENAI_API_KEY === key, "connect creates the named secret");
  const stored = await agentStore().getProvider(owner, "openai");
  const storedText = JSON.stringify(stored);
  assert(Boolean(stored) && stored?.hint === "0001" && !storedText.includes(key), "metadata keeps a hint and not the key");

  const replaced = await call("own_byok", "POST", "providers/replace", { provider: "openai", credential: nextKey });
  assert(replaced.status === 200 && secrets.get(name)?.OPENAI_API_KEY === nextKey, "replace uses the secret update");
  assert(!JSON.stringify(replaced.json).includes(nextKey), "replace does not return the key");

  const foreign = await call("own_byok_other", "POST", "runtime/turn", {
    provider: "openai",
    choice: name,
  });
  assert(foreign.status === 403, "another owner's secret name is refused");

  const ignored = await call("own_byok", "POST", "runtime/turn", {
    provider: "openai",
    choice: name,
    text: "Say hello.",
  });
  assert(ignored.status === 200, `the task did not run in the sandbox (${ignored.json.error?.message ?? ignored.status})`);
  assert(!ignored.text.includes(key), "the task response has no raw key");
  const ran = calls.find((item) => item.op === "exec");
  assert(Boolean(ran?.task), "the task was executed in the sandbox");
  assert(ran?.task?.host === "api.openai.com", "the task calls the provider host directly");
  assert(!JSON.stringify(ran?.task).includes(key), "the sandbox task does not carry the key");
  assert(!JSON.stringify(ran?.task?.headers).toLowerCase().includes("authorization"), "the sandbox does not set the auth header");
  assert(calls.some((item) => item.op === "ensure"), "connect creates the owner's sandbox");

  const changed = await call("own_byok", "POST", "providers/model", { provider: "openai", choice: "gpt-4.1" });
  assert(changed.status === 200 && changed.json.provider?.modelId === "gpt-4.1", "the owner chooses an allow-listed model");

  const gone = await call("own_byok", "POST", "providers/disconnect", { provider: "openai" });
  assert(gone.status === 200 && !secrets.has(name), "disconnect deletes the secret");
  assert(calls.some((item) => item.op === "update"), "replace reapplies the sandbox policy");
  assert(calls.some((item) => item.op === "terminate"), "disconnect terminates the sandbox");
  const local = taskRequest("openai", "gpt-4o", "hello");
  assert(local.body.stream === true, "the sandbox request asks for a streamed response");
  const after = await agentStore().getProvider(owner, "openai");
  assert(after?.status === "disconnected", "disconnect clears the connection");

  if (process.env.MODAL_TOKEN_ID?.trim() && process.env.BYOK_LIVE_KEY?.trim()) {
    console.log("byok live tokens are present. This check still refuses to place the key in a sandbox from the Next server.");
  } else {
    console.log("byok live sandbox was not run. Streaming stays outside this process, and the key stays in Modal.");
  }
  useSandboxRuntime(null);
  useModalSecretClient(null);
  console.log("byok check passed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
