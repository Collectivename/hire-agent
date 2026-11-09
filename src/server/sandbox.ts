import "server-only";
import { AgentsError } from "./errors";
import { toolCallsInText } from "./owner-ask";
import { MODEL_PROVIDERS, providerSpec, sandboxSpec, scriptSandboxName, type ModelProvider } from "./modal-policy";
import { agentStore } from "./store";

const APP_NAME = "collective-agents";
const TASK_PY = `
import base64, json, os, http.client, ssl, uuid
from urllib.parse import urlparse
req = json.loads(os.environ["TASK_JSON"])
if req.get("mode") == "transcribe":
    audio = urlparse(req.get("audioUrl") or "")
    if audio.scheme != "https" or not audio.hostname or audio.hostname == "api.meta.ai":
        print("400")
        print("audio url refused")
        raise SystemExit
    down = http.client.HTTPSConnection(audio.hostname, audio.port or 443, timeout=30, context=ssl.create_default_context())
    target = audio.path or "/"
    if audio.query:
        target += "?" + audio.query
    down.request("GET", target)
    got = down.getresponse()
    blob = got.read(15 * 1024 * 1024 + 1)
    if got.status != 200 or len(blob) < 44 or len(blob) > 15 * 1024 * 1024:
        print(str(got.status if got.status != 200 else 400))
        print("audio was not readable")
        raise SystemExit
    boundary = "muse" + uuid.uuid4().hex
    settings = json.dumps({"mode": "DIARIZATION", "model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV"}).encode()
    mark = boundary.encode()
    payload = b"".join([
        b"--" + mark + b"\\r\\n",
        b'Content-Disposition: form-data; name="request"\\r\\n',
        b"Content-Type: application/json\\r\\n\\r\\n",
        settings, b"\\r\\n",
        b"--" + mark + b"\\r\\n",
        b'Content-Disposition: form-data; name="audio"; filename="audio.wav"\\r\\n',
        b"Content-Type: audio/wav\\r\\n\\r\\n",
        blob, b"\\r\\n",
        b"--" + mark + b"--\\r\\n",
    ])
    conn = http.client.HTTPSConnection("api.meta.ai", timeout=90)
    conn.request("POST", "/v1/asr/transcribe?sessionId=hire", body=payload, headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    resp = conn.getresponse()
    print(resp.status)
    print(resp.read().decode("utf-8", "replace"))
    raise SystemExit
def fetch_image(uri):
    parsed = urlparse(uri)
    if parsed.scheme != "https" or not parsed.hostname or parsed.hostname == "generativelanguage.googleapis.com":
        return None
    down = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=20, context=ssl.create_default_context())
    target = parsed.path or "/"
    if parsed.query:
        target += "?" + parsed.query
    down.request("GET", target)
    got = down.getresponse()
    blob = got.read(4 * 1024 * 1024 + 1)
    kind = (got.getheader("Content-Type") or "").split(";")[0].strip().lower()
    if got.status != 200 or not kind.startswith("image/") or len(blob) < 32 or len(blob) > 4 * 1024 * 1024:
        return None
    return kind, base64.b64encode(blob).decode("ascii")
body = req["body"]
if req.get("host") == "generativelanguage.googleapis.com":
    for message in body.get("contents") or []:
        parts = []
        for part in message.get("parts") or []:
            uri = ((part.get("fileData") or {}).get("fileUri")) or ""
            if not str(uri).startswith("https://"):
                parts.append(part)
                continue
            fetched = fetch_image(uri)
            if fetched:
                parts.append({"inlineData": {"mimeType": fetched[0], "data": fetched[1]}})
        message["parts"] = parts or [{"text": "The image could not be viewed."}]
headers = {"Content-Type": "application/json"}
for key, value in (req.get("headers") or {}).items():
    if key.lower() in ("authorization", "x-api-key", "x-goog-api-key"):
        continue
    headers[key] = str(value)
conn = http.client.HTTPSConnection(req["host"], timeout=90)
conn.request("POST", req["path"], body=json.dumps(body).encode(), headers=headers)
resp = conn.getresponse()
print(resp.status)
print(resp.read().decode("utf-8", "replace"))
`.trim();

const SCRIPT_PY = `
import base64, os, traceback
try:
    src = base64.b64decode(os.environ.get("SCRIPT_B64", "")).decode("utf-8")
    exec(compile(src, "skill.py", "exec"), {"__name__": "skill"})
except Exception:
    print(traceback.format_exc())
`.trim();

export type TaskRequest = {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  mode?: "model" | "python" | "transcribe";
  script?: string;
  audioUrl?: string;
};

const MUSE_HOST = "api.meta.ai";

function museChat(modelId: string): boolean {
  return modelId === "muse-spark-1.3" || modelId === "muse-wonder-1.0";
}

/** Image, Transcription, and SAM have no conversation endpoint. Chat uses Muse Spark on the same key. */
export function museTalkModel(modelId: string): string | null {
  if (modelId === "muse-image-1.0" || modelId === "muse-voice-transcribe-1.0" || modelId === "sam-3.1") return "muse-spark-1.3";
  return null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function hostedImage(value: string): string | null {
  try {
    const url = new URL(value.replace(/[),.;]+$/, ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.includes(":")) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    if (host === MUSE_HOST || host === "api.openai.com" || host === "api.anthropic.com" || host === "generativelanguage.googleapis.com") return null;
    if (!IMAGE_EXT.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Public image links in a delivery note. The model receives these as pictures, not as text. */
export function imageLinks(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/https:\/\/[^\s]+/g)) {
    const image = hostedImage(match[0]);
    if (!image || found.includes(image)) continue;
    found.push(image);
    if (found.length === 3) break;
  }
  return found;
}

function imageMime(url: string): string {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function seenImages(text: string, images: string[]): unknown {
  return [
    { type: "text", text },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

function httpsMedia(text: string): string | null {
  const match = text.match(/https:\/\/[^\s]+/);
  if (!match) return null;
  try {
    const url = new URL(match[0].replace(/[),.;]+$/, ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.hostname === MUSE_HOST || url.hostname === "api.openai.com" || url.hostname === "api.anthropic.com" || url.hostname === "generativelanguage.googleapis.com") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export type SandboxRuntime = {
  ensure(owner: string, providers: ModelProvider[]): Promise<{ name: string; domains: string[] }>;
  exec(owner: string, task: TaskRequest): Promise<{ stdout: string; exitCode: number }>;
  updatePolicy(owner: string, providers: ModelProvider[]): Promise<void>;
  terminate(owner: string): Promise<void>;
};

let override: SandboxRuntime | null = null;

export function useSandboxRuntime(runtime: SandboxRuntime | null): void {
  override = runtime;
}

export function taskRequest(provider: ModelProvider, modelId: string, text: string, stream = true, system = ""): TaskRequest {
  const guidance = system.trim();
  const images = imageLinks(text);
  if (provider === "openai") {
    const content = images.length ? seenImages(text, images) : text;
    const messages = guidance
      ? [
          { role: "system", content: guidance },
          { role: "user", content },
        ]
      : [{ role: "user", content }];
    return {
      host: "api.openai.com",
      path: "/v1/chat/completions",
      headers: {},
      body: { model: modelId, messages, stream },
    };
  }
  if (provider === "anthropic") {
    const content = images.length
      ? [...images.map((url) => ({ type: "image", source: { type: "url", url } })), { type: "text", text }]
      : text;
    return {
      host: "api.anthropic.com",
      path: "/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      body: {
        model: modelId,
        max_tokens: 1024,
        ...(guidance ? { system: guidance } : {}),
        messages: [{ role: "user", content }],
        stream,
      },
    };
  }
  if (provider === "muse") {
    if (museChat(modelId)) {
      const content = images.length ? seenImages(text, images) : text;
      const messages = guidance
        ? [
            { role: "system", content: guidance },
            { role: "user", content },
          ]
        : [{ role: "user", content }];
      return { host: MUSE_HOST, path: "/v1/chat/completions", headers: {}, body: { model: modelId, messages, stream } };
    }
    if (modelId === "muse-image-1.0") {
      const prompt = text.trim().slice(0, 4000);
      if (!prompt) throw new AgentsError("INVALID_PARAMS", "Muse Image needs a prompt.", 400);
      return {
        host: MUSE_HOST,
        path: "/v1/images/generations",
        headers: {},
        body: { model: modelId, prompt, n: 1, response_format: "url" },
      };
    }
    const media = httpsMedia(text);
    if (modelId === "muse-voice-transcribe-1.0") {
      if (!media) throw new AgentsError("INVALID_PARAMS", "Muse Transcription needs an https WAV URL.", 400);
      return { host: MUSE_HOST, path: "/v1/asr/transcribe?sessionId=hire", headers: {}, body: {}, mode: "transcribe", audioUrl: media };
    }
    if (!media) throw new AgentsError("INVALID_PARAMS", "Muse SAM needs an object name and an https image URL.", 400);
    const phrase = text.replace(media, "").trim().slice(0, 200);
    if (!phrase) throw new AgentsError("INVALID_PARAMS", "Muse SAM needs an object name and an https image URL.", 400);
    return {
      host: MUSE_HOST,
      path: "/v1/responses",
      headers: {},
      body: {
        model: modelId,
        stream: false,
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: phrase },
              { type: "input_image", image_url: media },
            ],
          },
        ],
      },
    };
  }
  const path = stream
    ? `/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`
    : `/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
  return {
    host: "generativelanguage.googleapis.com",
    path,
    headers: {},
    body: {
      ...(guidance ? { systemInstruction: { parts: [{ text: guidance }] } } : {}),
      contents: [
        {
          role: "user",
          parts: images.length
            ? [{ text }, ...images.map((url) => ({ fileData: { mimeType: imageMime(url), fileUri: url } }))]
            : [{ text }],
        },
      ],
    },
  };
}

function museReply(parsed: {
  choices?: { message?: { content?: unknown } }[];
  data?: { url?: unknown }[];
  transcript?: unknown;
  output?: { content?: { text?: unknown }[] }[];
}): string {
  const chat = parsed.choices?.[0]?.message?.content;
  if (typeof chat === "string" && chat.trim()) return chat.trim();
  const image = parsed.data?.[0]?.url;
  if (typeof image === "string" && image.trim()) return image.trim();
  if (typeof parsed.transcript === "string" && parsed.transcript.trim()) return parsed.transcript.trim().slice(0, 1000);
  const sam = (parsed.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
  if (!sam) return "";
  if (sam.length <= 1000) return sam;
  const boxes = [...sam.matchAll(/<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+)/g)].slice(0, 8);
  if (!boxes.length) return sam.slice(0, 1000);
  return `SAM boxes:\n${boxes.map((box) => `${box[1]},${box[2]} to ${box[3]},${box[4]}`).join("\n")}`.slice(0, 1000);
}

export function modelText(provider: ModelProvider, body: string): string {
  let parsed: {
    choices?: { message?: { content?: unknown } }[];
    content?: { text?: unknown }[];
    candidates?: { content?: { parts?: { text?: unknown }[] } }[];
    data?: { url?: unknown }[];
    transcript?: unknown;
    output?: { content?: { text?: unknown }[] }[];
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new AgentsError("PROVIDER_UNAVAILABLE", "The model reply was not readable.", 502);
  }
  const text =
    provider === "openai"
      ? parsed.choices?.[0]?.message?.content
      : provider === "anthropic"
        ? parsed.content?.[0]?.text
        : provider === "muse"
          ? museReply(parsed)
          : parsed.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new AgentsError("PROVIDER_UNAVAILABLE", "The model reply was empty.", 502);
  }
  return text.trim();
}

function assertTaskHasNoKey(task: TaskRequest): void {
  const forbidden = ["authorization", "x-api-key", "x-goog-api-key"];
  for (const key of Object.keys(task.headers)) {
    if (forbidden.includes(key.toLowerCase())) {
      throw new AgentsError("POLICY_DENIED", "The sandbox request must not carry the provider key.", 500);
    }
  }
}

async function connectedProviders(owner: string): Promise<ModelProvider[]> {
  const links = await agentStore().listProviders(owner);
  return links
    .filter((link) => link.status === "connected")
    .map((link) => link.provider)
    .filter((provider): provider is ModelProvider => (MODEL_PROVIDERS as readonly string[]).includes(provider));
}

async function modalRuntime(): Promise<SandboxRuntime> {
  const tokenId = process.env.MODAL_TOKEN_ID?.trim();
  const tokenSecret = process.env.MODAL_TOKEN_SECRET?.trim();
  if (!tokenId || !tokenSecret) {
    throw new AgentsError("PROVIDER_UNAVAILABLE", "Modal workspace tokens are not configured.", 503);
  }
  const { ExperimentalOutboundPolicy, ModalClient, NotFoundError } = await import("modal");
  const modal = new ModalClient({ tokenId, tokenSecret });

  async function policyForOwner(owner: string, providers: ModelProvider[]) {
    let policy = new ExperimentalOutboundPolicy();
    for (const provider of providers) {
      const spec = providerSpec(provider);
      const secret = await modal.secrets.fromName(sandboxSpec(owner, provider).experimentalOutboundPolicy.replacements[0]!.secretName, {
        requiredKeys: [spec.env],
      });
      policy = policy.withHeaderReplacement({
        domain: spec.domain,
        secret,
        headers: { [spec.header]: spec.value },
      });
    }
    return policy;
  }

  async function openScript(owner: string) {
    const name = scriptSandboxName(owner);
    try {
      return await modal.sandboxes.fromName(APP_NAME, name);
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw new AgentsError("PROVIDER_UNAVAILABLE", "The skill sandbox could not be opened.", 503);
      }
    }
    const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true });
    const image = modal.images.fromRegistry("python:3.13-slim");
    return modal.sandboxes.create(app, image, {
      name,
      command: ["sleep", "infinity"],
      timeoutMs: 60 * 60 * 1000,
      idleTimeoutMs: 30 * 60 * 1000,
      blockNetwork: true,
      secrets: [],
    });
  }

  async function open(owner: string, providers: ModelProvider[]) {
    if (providers.length === 0) throw new AgentsError("NOT_FOUND", "That provider is not connected.", 404);
    const name = sandboxSpec(owner, providers[0]!).name;
    const domains = providers.map((provider) => providerSpec(provider).domain);
    const policy = await policyForOwner(owner, providers);
    try {
      const existing = await modal.sandboxes.fromName(APP_NAME, name);
      await existing.experimentalUpdateOutboundPolicy(policy);
      return { name, domains };
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw new AgentsError("PROVIDER_UNAVAILABLE", "The owner's sandbox could not be opened.", 503);
      }
    }
    const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true });
    const image = modal.images.fromRegistry("python:3.13-slim");
    await modal.sandboxes.create(app, image, {
      name,
      command: ["sleep", "infinity"],
      timeoutMs: 60 * 60 * 1000,
      idleTimeoutMs: 30 * 60 * 1000,
      experimentalOutboundPolicy: policy,
      secrets: [],
    });
    return { name, domains };
  }

  return {
    async ensure(owner, providers) {
      return open(owner, providers);
    },
    async exec(owner, task) {
      assertTaskHasNoKey(task);
      const python = task.mode === "python";
      const sandbox = python
        ? await openScript(owner)
        : await modal.sandboxes.fromName(APP_NAME, sandboxSpec(owner, "openai").name);
      const proc = await sandbox.exec(["python", "-c", python ? SCRIPT_PY : TASK_PY], {
        env: python
          ? { SCRIPT_B64: Buffer.from(task.script ?? "", "utf8").toString("base64") }
          : { TASK_JSON: JSON.stringify({ host: task.host, path: task.path, headers: task.headers, body: task.body, mode: task.mode ?? "model", audioUrl: task.audioUrl ?? "" }) },
        timeoutMs: python ? 20_000 : 120_000,
      });
      const reader = proc.stdout.getReader();
      let stdout = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        stdout += next.value;
      }
      const exitCode = await proc.wait();
      return { stdout, exitCode };
    },
    async updatePolicy(owner, providers) {
      await open(owner, providers);
    },
    async terminate(owner) {
      for (const name of [sandboxSpec(owner, "openai").name, scriptSandboxName(owner)]) {
        try {
          const sandbox = await modal.sandboxes.fromName(APP_NAME, name);
          await sandbox.terminate();
        } catch (error) {
          if (!(error instanceof NotFoundError)) {
            throw new AgentsError("PROVIDER_UNAVAILABLE", "The sandbox could not be terminated.", 503);
          }
        }
      }
    },
  };
}

async function runtime(): Promise<SandboxRuntime> {
  if (override) return override;
  return modalRuntime();
}

export async function ensureOwnerSandbox(owner: string): Promise<{ name: string; domains: string[] }> {
  const providers = await connectedProviders(owner);
  return (await runtime()).ensure(owner, providers);
}

export async function refreshOwnerSandbox(owner: string): Promise<void> {
  const providers = await connectedProviders(owner);
  await (await runtime()).updatePolicy(owner, providers);
}

export async function terminateOwnerSandbox(owner: string): Promise<void> {
  await (await runtime()).terminate(owner);
}

/** A specialty result for the chat, or an empty string when this message is only conversation. */
export async function museSpecialty(owner: string, modelId: string, text: string): Promise<string> {
  if (!museTalkModel(modelId)) return "";
  const media = httpsMedia(text);
  if (modelId !== "muse-image-1.0" && !media) return "";
  if (modelId === "sam-3.1" && media && !text.replace(media, "").trim()) return "";
  try {
    const output = await providerOutput(owner, taskRequest("muse", modelId, text, false));
    const result = modelText("muse", output);
    if (modelId === "muse-image-1.0") return result;
    if (modelId === "sam-3.1") return `Segmentation:\n${result}`;
    return `Transcript:\n${result}`;
  } catch {
    if (modelId === "muse-image-1.0") return "";
    return modelId === "sam-3.1" ? "The image could not be segmented." : "The audio could not be transcribed.";
  }
}

export async function runOwnerTask(
  owner: string,
  provider: ModelProvider,
  modelId: string,
  text: string,
  stream = true,
  system = ""
): Promise<{
  sandbox: string;
  status: number;
  output: string;
  transport: "http/1.1";
}> {
  const task = taskRequest(provider, modelId, text, stream, system);
  assertTaskHasNoKey(task);
  await ensureOwnerSandbox(owner);
  const ran = await (await runtime()).exec(owner, task);
  if (ran.exitCode !== 0) {
    throw new AgentsError("PROVIDER_UNAVAILABLE", "The sandbox task did not finish.", 502);
  }
  const newline = ran.stdout.indexOf("\n");
  const status = Number(newline >= 0 ? ran.stdout.slice(0, newline) : ran.stdout);
  const output = newline >= 0 ? ran.stdout.slice(newline + 1) : "";
  if (status === 401) {
    throw new AgentsError("PROVIDER_UNAVAILABLE", "The connected credential may be invalid.", 502);
  }
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new AgentsError("PROVIDER_UNAVAILABLE", "The provider refused the sandbox call.", 502);
  }
  return { sandbox: sandboxSpec(owner, provider).name, status, output, transport: "http/1.1" };
}

export type ModelMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolCallId?: string;
  name?: string;
};

export type ModelTool = { name: string; description: string; parameters: Record<string, unknown> };

export type ModelStep = { text: string; toolCalls: { id: string; name: string; arguments: string }[] };

function withTextCalls(step: ModelStep): ModelStep {
  const found = toolCallsInText(step.text);
  if (!found.calls.length) return { ...step, text: found.text };
  return { text: found.text, toolCalls: step.toolCalls.length ? step.toolCalls : found.calls };
}

function museResponsesBody(modelId: string, system: string, messages: ModelMessage[], tools: ModelTool[]): Record<string, unknown> {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId ?? "", output: message.content });
      continue;
    }
    if (message.role === "assistant") {
      if (message.content.trim()) {
        input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: message.content }] });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      }
      continue;
    }
    input.push({ type: "message", role: "user", content: [{ type: "input_text", text: message.content }] });
  }
  return {
    model: modelId,
    stream: false,
    ...(system ? { instructions: system } : {}),
    input,
    ...(tools.length
      ? {
          tool_choice: "auto",
          tools: tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            defer_loading: false,
            parameters: tool.parameters,
          })),
        }
      : {}),
  };
}

export function stepFromResponses(body: string): ModelStep {
  let parsed: { output_text?: unknown; output?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new AgentsError("PROVIDER_UNAVAILABLE", "The model reply was not readable.", 502);
  }
  const output = Array.isArray(parsed.output) ? parsed.output : [];
  const textParts: string[] = [];
  const toolCalls: ModelStep["toolCalls"] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; content?: unknown; name?: unknown; arguments?: unknown; call_id?: unknown; id?: unknown };
    if (record.type === "message" && Array.isArray(record.content)) {
      for (const part of record.content) {
        if (!part || typeof part !== "object") continue;
        const piece = part as { type?: unknown; text?: unknown };
        if (piece.type === "output_text" && typeof piece.text === "string") textParts.push(piece.text);
      }
    }
    if (record.type === "function_call" && typeof record.name === "string") {
      const args = typeof record.arguments === "string" ? record.arguments : JSON.stringify(record.arguments ?? {});
      const id = typeof record.call_id === "string" ? record.call_id : typeof record.id === "string" ? record.id : `call_${toolCalls.length}`;
      toolCalls.push({ id, name: record.name, arguments: args });
    }
  }
  const text = textParts.join("\n").trim() || (typeof parsed.output_text === "string" ? parsed.output_text.trim() : "");
  return withTextCalls({ text, toolCalls });
}

function jsonValue(value: string): unknown {
  try {
    return JSON.parse(value || "{}") as unknown;
  } catch {
    return {};
  }
}

function providerBody(
  provider: ModelProvider,
  modelId: string,
  system: string,
  messages: ModelMessage[],
  tools: ModelTool[]
): Record<string, unknown> {
  if (provider === "openai") {
    const rows = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages.map((message) => {
        if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
        if (message.role === "assistant" && message.toolCalls?.length) {
          return {
            role: "assistant",
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          };
        }
        return { role: message.role, content: message.content };
      }),
    ];
    return {
      model: modelId,
      messages: rows,
      stream: false,
      ...(tools.length
        ? { tools: tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) }
        : {}),
    };
  }
  if (provider === "anthropic") {
    const rows = messages.map((message) => {
      if (message.role === "tool") {
        return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] };
      }
      if (message.role === "assistant" && message.toolCalls?.length) {
        return {
          role: "assistant",
          content: [
            ...(message.content ? [{ type: "text", text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: jsonValue(call.arguments),
            })),
          ],
        };
      }
      return { role: message.role === "assistant" ? "assistant" : "user", content: message.content };
    });
    return {
      model: modelId,
      max_tokens: 1024,
      ...(system ? { system } : {}),
      messages: rows,
      stream: false,
      ...(tools.length
        ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }
        : {}),
    };
  }
  const contents = messages.map((message) => {
    if (message.role === "tool") {
      return { role: "user", parts: [{ functionResponse: { name: message.name ?? message.toolCallId, response: { result: message.content } } }] };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "model",
        parts: message.toolCalls.map((call) => ({
          functionCall: { name: call.name, args: jsonValue(call.arguments) },
        })),
      };
    }
    return { role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] };
  });
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(tools.length
      ? { tools: [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }] }
      : {}),
  };
}

function stepFrom(provider: ModelProvider, body: string): ModelStep {
  let parsed: {
    choices?: { message?: { content?: unknown; tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[] } }[];
    content?: { type?: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown }[];
    candidates?: { content?: { parts?: { text?: unknown; functionCall?: { name?: unknown; args?: unknown } }[] } }[];
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new AgentsError("PROVIDER_UNAVAILABLE", "The model reply was not readable.", 502);
  }
  if (provider === "openai") {
    const message = parsed.choices?.[0]?.message;
    const toolCalls = (message?.tool_calls ?? []).flatMap((call, index) => {
      const name = call.function?.name;
      if (typeof name !== "string") return [];
      return [{ id: typeof call.id === "string" ? call.id : `call_${index}`, name, arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "{}" }];
    });
    return withTextCalls({ text: typeof message?.content === "string" ? message.content.trim() : "", toolCalls });
  }
  if (provider === "anthropic") {
    const blocks = parsed.content ?? [];
    const text = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => String(block.text)).join("\n").trim();
    const toolCalls = blocks.flatMap((block, index) => {
      if (block.type !== "tool_use" || typeof block.name !== "string") return [];
      return [{ id: typeof block.id === "string" ? block.id : `call_${index}`, name: block.name, arguments: JSON.stringify(block.input ?? {}) }];
    });
    return withTextCalls({ text, toolCalls });
  }
  const parts = parsed.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n").trim();
  const toolCalls = parts.flatMap((part, index) => {
    const name = part.functionCall?.name;
    if (typeof name !== "string") return [];
    return [{ id: `call_${index}`, name, arguments: JSON.stringify(part.functionCall?.args ?? {}) }];
  });
  return withTextCalls({ text, toolCalls });
}

async function providerOutput(owner: string, task: TaskRequest): Promise<string> {
  assertTaskHasNoKey(task);
  await ensureOwnerSandbox(owner);
  const ran = await (await runtime()).exec(owner, task);
  if (ran.exitCode !== 0) throw new AgentsError("PROVIDER_UNAVAILABLE", "The sandbox task did not finish.", 502);
  const newline = ran.stdout.indexOf("\n");
  const status = Number(newline >= 0 ? ran.stdout.slice(0, newline) : ran.stdout);
  const output = newline >= 0 ? ran.stdout.slice(newline + 1) : "";
  if (status === 401) throw new AgentsError("PROVIDER_UNAVAILABLE", "The connected credential may be invalid.", 502);
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    throw new AgentsError("PROVIDER_UNAVAILABLE", "The provider refused the sandbox call.", 502);
  }
  return output;
}

export async function runModel(
  owner: string,
  provider: ModelProvider,
  modelId: string,
  system: string,
  messages: ModelMessage[],
  tools: ModelTool[]
): Promise<ModelStep> {
  if (provider === "muse" && !museChat(modelId)) {
    const last = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const output = await providerOutput(owner, taskRequest(provider, modelId, last, false));
    return { text: modelText(provider, output), toolCalls: [] };
  }
  if (provider === "muse") {
    const output = await providerOutput(owner, {
      host: MUSE_HOST,
      path: "/v1/responses",
      headers: {},
      body: museResponsesBody(modelId, system, messages, tools),
    });
    const step = stepFromResponses(output);
    if (!step.text && step.toolCalls.length === 0) throw new AgentsError("PROVIDER_UNAVAILABLE", "The model reply was empty.", 502);
    return step;
  }
  const chatProvider = provider;
  const path = chatProvider === "openai" ? "/v1/chat/completions" : chatProvider === "anthropic" ? "/v1/messages" : `/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
  const host = chatProvider === "openai" ? "api.openai.com" : chatProvider === "anthropic" ? "api.anthropic.com" : "generativelanguage.googleapis.com";
  const headers: Record<string, string> = chatProvider === "anthropic" ? { "anthropic-version": "2023-06-01" } : {};
  const output = await providerOutput(owner, { host, path, headers, body: providerBody(chatProvider, modelId, system, messages, tools) });
  const step = stepFrom(chatProvider, output);
  if (!step.text && step.toolCalls.length === 0) throw new AgentsError("PROVIDER_UNAVAILABLE", "The model reply was empty.", 502);
  return step;
}

/** A Muse review that can actually see image files, supplied as data URLs so no remote fetch is needed. */
export async function runVisionReview(
  owner: string,
  modelId: string,
  instructions: string,
  text: string,
  images: string[]
): Promise<string> {
  if (!images.length) return "";
  const output = await providerOutput(owner, {
    host: MUSE_HOST,
    path: "/v1/responses",
    headers: {},
    body: {
      model: modelId,
      stream: false,
      ...(instructions ? { instructions } : {}),
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text },
            ...images.map((image) => ({ type: "input_image", image_url: image })),
          ],
        },
      ],
    },
  });
  return stepFromResponses(output).text;
}

export async function runSkillPython(owner: string, source: string): Promise<string> {
  if (source.length > 8_000) throw new AgentsError("INVALID_PARAMS", "That skill script is too long.", 400);
  const ran = await (await runtime()).exec(owner, { host: "", path: "", headers: {}, body: {}, mode: "python", script: source });
  if (ran.exitCode !== 0) throw new AgentsError("PROVIDER_UNAVAILABLE", "The skill script did not finish.", 502);
  return ran.stdout.trim();
}
