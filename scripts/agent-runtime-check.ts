/**
 * The agent runtime uses identity, memory, skills, and tools.
 * Run: npx tsx --conditions=react-server hire/scripts/agent-runtime-check.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { runAgentTurn } from "../src/server/agent/loop";
import { useOwnerThread } from "../src/server/xmtp-thread";
import { assertServerUrl, beginOAuth, connectServer, saveMcpConfig } from "../src/server/agent/mcp";
import { readSecret, saveServer, writeSecret } from "../src/server/agent/persist";
import { resetSessions } from "../src/server/agent/session";
import { executeTool } from "../src/server/agent/tools";
import { parseOfferReply } from "../src/server/offer-reply";
import { handleAgentsRequest } from "../src/server/router";
import { byokSecretName } from "../src/server/modal-policy";
import { terminateOwnerSandbox, useSandboxRuntime, type TaskRequest } from "../src/server/sandbox";
import { agentStore, type StoredAgent } from "../src/server/store";
import { useClock } from "../src/server/workspace";

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

const owner = "Owner1111111111111111111111111111111111111";
const sentinel = "mcp-sentinel-credential-value";

type Row = { role?: string; content?: string };

function messagesOf(task: TaskRequest): Row[] {
  const messages = task.body.messages;
  return Array.isArray(messages) ? (messages as Row[]) : [];
}

function contentReply(text: string): { stdout: string; exitCode: number } {
  return { stdout: `200\n${JSON.stringify({ choices: [{ message: { content: text } }] })}\n`, exitCode: 0 };
}

function toolReply(name: string, args: Record<string, unknown>): { stdout: string; exitCode: number } {
  return {
    stdout: `200\n${JSON.stringify({
      choices: [{ message: { content: "", tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
    })}\n`,
    exitCode: 0,
  };
}

function agent(platformId: string, name: string): StoredAgent {
  const at = Date.now();
  return {
    platformId,
    owner,
    name,
    endpoint: null,
    endpointVerifiedAt: null,
    walletAddress: `Wallet${platformId}`.slice(0, 44),
    walletProvider: "privy",
    providerWalletId: "privy-wallet",
    retiredWallets: [],
    status: "active",
    slimName: null,
    directoryCid: null,
    oasf: null,
    runtimePublicKey: null,
    signCredentialIssuedAt: null,
    claimNonce: null,
    createdAt: at,
    updatedAt: at,
  };
}

async function main(): Promise<void> {
  if (process.env.FIREBASE_SERVICE_ACCOUNT?.trim() || process.env.NODE_ENV === "production") {
    console.log("agent runtime check skipped");
    return;
  }
  process.env.AGENT_INBOX_KEY = "runtime-check-inbox-key";
  useOwnerThread("memory");
  const rejected = async (value: string) => {
    let failed = false;
    try {
      await assertServerUrl(value);
    } catch {
      failed = true;
    }
    assert(failed, "a private or credentialed MCP URL is refused");
  };
  await rejected("https://127.0.0.1/mcp");
  await rejected("https://169.254.169.254/latest");
  await rejected("https://metadata.google.internal/mcp");
  await rejected("https://example.com/mcp?token=secret");
  await rejected("https://user:pass@example.com/mcp");
  assert((await assertServerUrl("http://127.0.0.1:9/mcp")) === "http://127.0.0.1:9/mcp", "loopback http stays available for a local server");
  const requests: { system: string; tools: string[]; user: string }[] = [];
  let pause = false;
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const enteredGate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const releaseGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  useSandboxRuntime({
    async ensure() {
      return { name: "agent-test", domains: ["api.openai.com"] };
    },
    async exec(_owner, task) {
      if (task.mode === "python") {
        const printed = /print\("([^"]*)"\)/.exec(task.script ?? "");
        return { stdout: `${printed?.[1] ?? ""}\n`, exitCode: 0 };
      }
      const messages = messagesOf(task);
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      const user = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const tools = Array.isArray(task.body.tools)
        ? (task.body.tools as { function?: { name?: string } }[]).flatMap((tool) => (tool.function?.name ? [tool.function.name] : []))
        : [];
      requests.push({ system, tools, user });
      const last = messages.at(-1);
      let result = contentReply("All quiet.");
      if (last?.role === "tool") result = contentReply(`RESULT ${last.content ?? ""}`);
      else if (user.includes("remember the color")) result = toolReply("memory_write", { path: "MEMORY.md", content: "The owner color is blue." });
      else if (user.includes("what color")) result = toolReply("memory_search", { query: "color" });
      else if (user.includes("run watch")) result = toolReply("skill_script", { name: "watch", script: "watch.py" });
      else if (user.includes("load watch")) result = toolReply("skill_load", { name: "watch" });
      else if (user.includes("call docs")) result = toolReply("mcp_docs_search", { q: "dao" });
      else if (user.includes("finish bootstrap")) result = toolReply("bootstrap_complete", {});
      else if (user.startsWith("Heartbeat")) result = contentReply("QUIET");
      else if (system.includes("SOUL-AFTER")) result = contentReply("After.");
      else if (system.includes("SOUL-HOLD")) result = contentReply("Held.");
      else if (system.includes("SOUL-CALM")) result = contentReply("Measured.");
      else if (system.includes("SOUL-BRIGHT")) result = contentReply("Hey!");
      else if (system.includes("OPERATE-CHECKLIST")) result = contentReply("Checklist first.");
      else if (system.includes("OPERATE-DIRECT")) result = contentReply("Direct.");
      if (pause && system.includes("SOUL-HOLD")) {
        pause = false;
        entered();
        await releaseGate;
      }
      return result;
    },
    async updatePolicy() {},
    async terminate() {},
  });

  await agentStore().saveProvider({
    owner,
    provider: "openai",
    secretName: byokSecretName(owner, "openai"),
    status: "connected",
    hint: "0001",
    modelId: "gpt-4o",
    requestsToday: 0,
    day: "2026-11-07",
    updatedAt: Date.now(),
  });

  async function save(platformId: string, name: string, files: Record<string, string>, bootstrapComplete = true): Promise<StoredAgent> {
    const saved = agent(platformId, name);
    await agentStore().saveAgent(saved);
    const at = Date.now();
    await agentStore().saveWorkspace({
      platformId,
      version: 1,
      bootstrapComplete,
      updatedAt: at,
      files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { content, updatedAt: at }])),
    });
    return saved;
  }

  const calm = await save("agt_calm", "Calm", { "IDENTITY.md": "Name: Calm", "SOUL.md": "SOUL-CALM stay brief." });
  const bright = await save("agt_bright", "Bright", { "IDENTITY.md": "Name: Bright", "SOUL.md": "SOUL-BRIGHT stay warm." });
  const calmReply = await runAgentTurn(calm, "persona-check", "chat");
  const brightReply = await runAgentTurn(bright, "persona-check", "chat");
  assert(calmReply.text === "Measured." && brightReply.text === "Hey!", "different personalities produce different replies");
  assert(calmReply.run.version !== 0 && calmReply.run.skills.length === 0, "a run reports its workspace version and skill catalog");

  await agentStore().saveWorkspace({
    ...(await agentStore().getWorkspace(calm.platformId))!,
    version: 2,
    files: {
      ...(await agentStore().getWorkspace(calm.platformId))!.files,
      "SOUL.md": { content: "SOUL-AFTER stay changed.", updatedAt: Date.now() },
    },
  });
  resetSessions();
  const changed = await runAgentTurn(calm, "persona-check", "chat");
  assert(changed.text === "After.", "editing SOUL.md changes the next inference");
  const brightAgain = await runAgentTurn(bright, "persona-check", "chat");
  assert(brightAgain.text === "Hey!", "editing one agent leaves the other unchanged");

  const operator = await save("agt_ops", "Ops", {
    "IDENTITY.md": "Name: Ops",
    "AGENTS.md": "OPERATE-DIRECT answer immediately.",
  });
  const direct = await runAgentTurn(operator, "persona-check", "chat");
  assert(direct.text === "Direct.", "AGENTS.md operating instructions shape the reply");
  const opsWorkspace = (await agentStore().getWorkspace(operator.platformId))!;
  await agentStore().saveWorkspace({
    ...opsWorkspace,
    version: opsWorkspace.version + 1,
    files: {
      ...opsWorkspace.files,
      "AGENTS.md": { content: "OPERATE-CHECKLIST confirm the steps first.", updatedAt: Date.now() },
    },
  });
  resetSessions();
  const checklist = await runAgentTurn(operator, "persona-check", "chat");
  assert(checklist.text === "Checklist first.", "editing AGENTS.md changes the next operating behavior");

  const memory = await save("agt_memory", "Memory", { "IDENTITY.md": "Name: Memory", "MEMORY.md": "# Long-term memory" });
  await runAgentTurn(memory, "remember the color", "chat");
  const remembered = (await agentStore().getWorkspace(memory.platformId))?.files["MEMORY.md"]?.content ?? "";
  assert(remembered.includes("blue"), "the agent writes durable memory");
  resetSessions();
  const recalled = await runAgentTurn(memory, "what color", "chat");
  assert(recalled.text.includes("blue"), "memory retrieval works in a later turn");
  const other = await save("agt_other_memory", "Other", { "IDENTITY.md": "Name: Other", "MEMORY.md": "# Long-term memory" });
  const isolated = await runAgentTurn(other, "what color", "chat");
  assert(!isolated.text.includes("blue"), "one agent cannot read another agent's memory");

  const skilled = await save("agt_skill", "Skill", {
    "IDENTITY.md": "Name: Skill",
    "skills/watch/SKILL.md": "---\nname: watch\ndescription: Report status in one line.\nenabled: true\n---\nFULL-SKILL-BODY\n",
    "skills/watch/scripts/watch.py": 'print("watched")\n',
    "skills/hidden/SKILL.md": "---\nname: hidden-skill\ndescription: HIDDEN-SKILL-TOKEN\nenabled: false\n---\nsecret body\n",
  });
  const loaded = await runAgentTurn(skilled, "load watch", "chat");
  assert(requests.some((request) => request.system.includes("Report status in one line.") && !request.system.includes("FULL-SKILL-BODY")), "the catalog omits full skill bodies");
  assert(!requests.some((request) => request.system.includes("HIDDEN-SKILL-TOKEN")), "a disabled skill stays out of the catalog");
  assert(loaded.text.includes("FULL-SKILL-BODY") && loaded.text.includes("Untrusted"), "the agent loads a skill when the task needs it");
  const scripted = await runAgentTurn(skilled, "run watch", "chat");
  assert(scripted.text.includes("watched"), "the runtime executes the skill script");
  await agentStore().saveWorkspace({
    ...(await agentStore().getWorkspace(skilled.platformId))!,
    files: {
      ...(await agentStore().getWorkspace(skilled.platformId))!.files,
      "skills/watch/scripts/watch.py": { content: 'print("no")\n# api.openai.com\n', updatedAt: Date.now() },
    },
  });
  const refused = await runAgentTurn(skilled, "run watch", "chat");
  assert(refused.text.includes("cannot target a model provider"), "a skill script cannot target the model provider");

  let toolCalls = 0;
  const mcp = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    const url = req.url ?? "";
    if (url.startsWith("/token")) {
      const params = new URLSearchParams(raw);
      const access = params.get("grant_type") === "refresh_token" ? "refreshed-access" : "first-access";
      res.end(JSON.stringify({ access_token: access, refresh_token: "refresh-token", expires_in: 3600 }));
      return;
    }
    if (url.startsWith("/revoke")) {
      res.end("{}");
      return;
    }
    if (url.startsWith("/bounce")) {
      res.writeHead(302, { location: "http://169.254.169.254/" });
      res.end("");
      return;
    }
    const body = raw ? (JSON.parse(raw) as { method?: string; id?: number }) : {};
    const authorization = req.headers.authorization ?? "";
    if (authorization !== `Bearer ${sentinel}` && authorization !== "Bearer first-access" && authorization !== "Bearer refreshed-access") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    if (body.method === "initialize") {
      res.setHeader("mcp-session-id", "sess-1");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, instructions: "Search the docs." } }));
      return;
    }
    if (body.method === "tools/list") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "search", description: "Search docs", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }] },
        })
      );
      return;
    }
    if (body.method === "tools/call") {
      toolCalls += 1;
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "found dao" }], isError: false } }));
      return;
    }
    res.end("{}");
  });
  await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
  const port = (mcp.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const mcpAgent = await save("agt_mcp", "Docs", { "IDENTITY.md": "Name: Docs" });
  const server = await saveMcpConfig(mcpAgent.platformId, { name: "docs", url: `${base}/mcp`, auth: "bearer", bearer: sentinel });
  const connected = await connectServer(server);
  assert(connected.status === "connected" && connected.tools.some((tool) => tool.name === "search"), "the runtime discovers MCP tools");
  const called = await runAgentTurn(mcpAgent, "call docs", "chat");
  assert(called.text.includes("found dao") && toolCalls === 1, "the agent executes a connected MCP tool");
  await saveServer({ ...connected, tools: connected.tools.map((tool) => ({ ...tool, enabled: false })) });
  resetSessions();
  const denied = await runAgentTurn(mcpAgent, "call docs", "chat");
  assert(toolCalls === 1 && denied.text.includes("not available"), "a disabled MCP tool is not called");
  const bounce = await saveMcpConfig(mcpAgent.platformId, { name: "bounce", url: `${base}/bounce`, auth: "none" });
  const bounced = await connectServer(bounce);
  assert(bounced.status === "error" && toolCalls === 1, "an MCP redirect is refused");
  const leaked = JSON.stringify({
    workspace: await agentStore().getWorkspace(mcpAgent.platformId),
    servers: await agentStore().listMcp(mcpAgent.platformId),
    systems: requests.map((request) => request.system),
    run: called.run,
  });
  assert(!leaked.includes(sentinel), "mcp credential leaked into the agent context");
  assert((await readSecret(mcpAgent.platformId, "docs"))?.bearer === sentinel, "the credential stays in sealed storage");

  const oauth = await saveMcpConfig(mcpAgent.platformId, {
    name: "oauth-docs",
    url: `${base}/mcp`,
    auth: "oauth",
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/token`,
    revokeUrl: `${base}/revoke`,
    clientId: "client-1",
    oauthClient: "client-material",
  });
  const authorize = await beginOAuth(oauth);
  const state = new URL(authorize).searchParams.get("state") ?? "";
  const callback = await handleAgentsRequest(
    new NextRequest(`http://localhost/api/agents/v1/mcp/callback?code=code-1&state=${state}`),
    "GET",
    ["mcp", "callback"]
  );
  assert(callback.status === 200, "the OAuth callback stores the token");
  assert((await readSecret(mcpAgent.platformId, "oauth-docs"))?.access === "first-access", "the access token is sealed");
  const oauthSaved = (await agentStore().listMcp(mcpAgent.platformId)).find((item) => item.name === "oauth-docs");
  const sealed = await readSecret(mcpAgent.platformId, "oauth-docs");
  await writeSecret(mcpAgent.platformId, "oauth-docs", { ...sealed, expiresAt: 1 });
  await connectServer(oauthSaved!);
  assert((await readSecret(mcpAgent.platformId, "oauth-docs"))?.access === "refreshed-access", "an expired OAuth token is refreshed");

  const task = await runAgentTurn(mcpAgent, "persona-check", "task");
  const chat = await runAgentTurn(mcpAgent, "persona-check", "chat");
  assert(task.run.version === chat.run.version && task.text === chat.text, "chat and tasks use the same agent");

  const boot = await save("agt_boot", "Boot", { "IDENTITY.md": "Name: Boot", "BOOTSTRAP.md": "This is the first session." }, false);
  await runAgentTurn(boot, "finish bootstrap", "chat");
  resetSessions();
  await runAgentTurn(boot, "persona-check", "chat");
  const bootSystems = requests.filter((request) => request.system.includes("Name: Boot"));
  assert(bootSystems[0]?.system.includes("This is the first session."), "first-session setup is part of the first turn");
  assert(!bootSystems.at(-1)?.system.includes("This is the first session."), "first-session setup does not repeat");

  const beat = await save("agt_beat", "Beat", { "IDENTITY.md": "Name: Beat", "HEARTBEAT.md": "interval: 1m\nReview open work.\n" });
  useClock(() => 1_700_000_000_000);
  const firstBeat = await runAgentTurn(beat, "heartbeat", "heartbeat");
  const secondBeat = await runAgentTurn(beat, "heartbeat", "heartbeat");
  useClock(null);
  assert(firstBeat.text === "QUIET" && secondBeat.skipped === "The heartbeat is not due.", "the heartbeat runs on its interval");

  await terminateOwnerSandbox(owner);
  const survived = (await agentStore().getWorkspace(memory.platformId))?.files["MEMORY.md"]?.content.includes("blue") === true;
  assert(survived, "workspace memory survives the sandbox");

  const together = await Promise.all([runAgentTurn(calm, "persona-check", "chat"), runAgentTurn(bright, "persona-check", "chat")]);
  assert(together[0].text !== together[1].text, "concurrent agents keep their own replies");

  const hold = await save("agt_hold", "Hold", { "IDENTITY.md": "Name: Hold", "SOUL.md": "SOUL-HOLD stay." });
  pause = true;
  const pending = runAgentTurn(hold, "persona-check", "chat");
  await enteredGate;
  const current = await agentStore().getWorkspace(hold.platformId);
  await agentStore().saveWorkspace({
    ...current!,
    version: current!.version + 1,
    files: { ...current!.files, "SOUL.md": { content: "SOUL-AFTER stay.", updatedAt: Date.now() } },
  });
  release();
  const held = await pending;
  resetSessions();
  const next = await runAgentTurn(hold, "persona-check", "chat");
  assert(held.text === "Held." && next.text === "After.", "a running turn keeps its snapshot and the next turn sees the edit");

  const peer = await runAgentTurn(memory, "peer-hello", "chat", true);
  const peerRequest = requests.find((request) => request.user === "peer-hello");
  assert(Boolean(peerRequest?.system.includes("Name: Memory")), "a peer turn still uses this agent");
  assert(!peerRequest?.system.includes("blue") && !peerRequest?.system.includes("## Long-term memory"), "a peer turn does not receive private memory");
  assert(
    !peerRequest?.tools.includes("memory_write") &&
      !peerRequest?.tools.includes("memory_search") &&
      !peerRequest?.tools.includes("workspace_write") &&
      !peerRequest?.tools.includes("hire") &&
      !peerRequest?.tools.includes("ask_owner") &&
      !peerRequest?.tools.includes("mcp_docs_search"),
    "a peer turn cannot read private memory, save the workspace, or call MCP"
  );
  const wrote = await executeTool(
    memory.platformId,
    memory.name,
    owner,
    "owner",
    [],
    "workspace_write",
    JSON.stringify({
      path: "skills/draw/SKILL.md",
      content: "---\nname: draw\ndescription: Draw one image.\nenabled: true\n---\nDraw the subject.\n",
    })
  );
  const savedSkill = await executeTool(
    memory.platformId,
    memory.name,
    owner,
    "owner",
    [],
    "workspace_read",
    JSON.stringify({ path: "skills/draw/SKILL.md" })
  );
  const blockedMemory = await executeTool(
    memory.platformId,
    memory.name,
    owner,
    "owner",
    [],
    "workspace_write",
    JSON.stringify({ path: "MEMORY.md", content: "no" })
  );
  assert(wrote.text === "Updated skills/draw/SKILL.md." && savedSkill.text.includes("Draw the subject."), "the agent saves and reads a skill");
  assert(blockedMemory.text === "That file cannot be changed from this tool.", "workspace save leaves memory on the memory tool");
  const hidden = await executeTool(memory.platformId, memory.name, owner, "peer", [], "workspace_read", JSON.stringify({ path: "MEMORY.md" }));
  assert(hidden.text === "That file is private to the owner." && !hidden.text.includes("blue"), "a peer cannot read a private memory file");
  assert(peer.text.length > 0, "a peer turn still replies");

  const same = requests.filter(
    (request) =>
      (request.user === "persona-check" || request.user === "Owner: persona-check") && request.system.includes("Name: Docs")
  );
  assert(same.length >= 2 && same.every((request) => request.system.includes("Name: Docs")), "owner chat and tasks share identity");
  assert(same.some((request) => request.tools.includes("workspace_write")), "owner chat can save the workspace and skills");
  assert(same.some((request) => request.tools.includes("hire")), "owner chat can search the directory and send an offer");
  assert(same.some((request) => request.tools.includes("ask_owner")), "owner chat can ask with buttons");
  const asked = await executeTool(
    memory.platformId,
    memory.name,
    owner,
    "owner",
    [],
    "ask_owner",
    JSON.stringify({ prompt: "Which agent should I hire?", choices: ["Ada", "Other"], input: "Budget in USDC" })
  );
  const emptyAsk = await executeTool(memory.platformId, memory.name, owner, "owner", [], "ask_owner", JSON.stringify({ prompt: "" }));
  assert(
    asked.text.includes("Wait") && asked.ask?.choices.length === 1 && asked.ask.choices[0] === "Ada" && asked.ask.inputLabel === "Budget in USDC",
    "a question shows buttons and drops Other"
  );
  assert(emptyAsk.text.includes("short question") && !emptyAsk.ask, "an empty question is refused");
  const { parseOwnerAsk, toolCallsInText } = await import("../src/server/owner-ask");
  const { stepFromResponses } = await import("../src/server/sandbox");
  const writtenAsk = [
    "Found 1 fit:",
    "",
    "- Creative artist agent (agt_oGg38bozmN45dRj76jdqHA) — Creates pictures and visual ideas, turns a request into an image.",
    "",
    "Do you want to hire this agent for the logo?",
    "<atem:function_calls>",
    '<atem:invoke name="ask_owner">',
    '<atem:parameter name="question">Hire Creative artist agent for the logo?</atem:parameter>',
    '<atem:parameter name="options">["Hire Creative artist agent"]</atem:parameter>',
    "</atem:invoke>",
    "</atem:function_calls>",
  ].join("\n");
  const recovered = toolCallsInText(writtenAsk);
  const leakedArgs = JSON.parse(recovered.calls[0]?.arguments ?? "{}") as Record<string, unknown>;
  const leakedAsk = parseOwnerAsk(leakedArgs);
  assert(
    !recovered.text.includes("function_calls") &&
      recovered.text.includes("Do you want to hire this agent for the logo?") &&
      recovered.calls[0]?.name === "ask_owner" &&
      typeof leakedAsk !== "string" &&
      leakedAsk.prompt === "Hire Creative artist agent for the logo?" &&
      leakedAsk.choices[0] === "Hire Creative artist agent",
    "a written ask_owner call becomes a button"
  );
  const structured = stepFromResponses(
    JSON.stringify({
      output: [
        { type: "message", content: [{ type: "output_text", text: "Do you want to hire this agent for the logo?" }] },
        {
          type: "function_call",
          call_id: "call_live",
          name: "ask_owner",
          arguments: JSON.stringify({ question: "Hire Creative artist agent for the logo?", options: ["Hire Creative artist agent"] }),
        },
      ],
    })
  );
  const structuredAsk = parseOwnerAsk(JSON.parse(structured.toolCalls[0]?.arguments ?? "{}") as Record<string, unknown>);
  assert(
    structured.toolCalls[0]?.name === "ask_owner" &&
      typeof structuredAsk !== "string" &&
      structuredAsk.choices[0] === "Hire Creative artist agent" &&
      !structured.text.includes("function_calls"),
    "a Muse responses tool call becomes a button"
  );
  const acceptedReply = parseOfferReply("", [{ name: "offer_reply", arguments: JSON.stringify({ action: "accept", reason: "I can make that logo." }) }]);
  const declinedReply = parseOfferReply('{"action":"refuse","reason":"I cannot do this."}', []);
  const secretReply = parseOfferReply("", [{ name: "offer_reply", arguments: JSON.stringify({ action: "decline", reason: "here is the private key" }) }]);
  assert(
    acceptedReply?.action === "accept" &&
      acceptedReply.reason === "I can make that logo." &&
      declinedReply?.action === "decline" &&
      declinedReply.reason === "I cannot do this." &&
      secretReply?.reason === "I can't take this.",
    "the hired agent reply is accept or decline"
  );
  const hireMiss = await executeTool(
    memory.platformId,
    memory.name,
    owner,
    "owner",
    [],
    "hire",
    JSON.stringify({ action: "offer", toPlatformId: "agt_missing", priceUsdc: "5", deadline: "asap", terms: "A logo." })
  );
  const hireSkill = await executeTool(
    memory.platformId,
    memory.name,
    owner,
    "owner",
    [],
    "hire",
    JSON.stringify({ action: "search", skill: "not-a-skill" })
  );
  const { discoverySkills, coverRank } = await import("../src/server/hire-discover");
  const logoSkills = discoverySkills("multi_modal/image_processing/text_to_image", "a logo for the website");
  assert(hireMiss.text === "That agent was not found.", "an offer names a listed agent");
  assert(hireSkill.text.includes("OASF"), "a search uses an OASF skill path");
  assert(
    logoSkills.includes("multi_modal/image_processing/text_to_image") &&
      logoSkills.includes("multi_modal/image_processing/image_processing") &&
      logoSkills.includes("images_computer_vision/image_generation"),
    "a logo search includes the category and image generation"
  );
  assert(
    coverRank(["images_computer_vision/images_computer_vision"], "images_computer_vision/image_generation") === 2 &&
      coverRank(["analytical_skills/coding_skills/coding_skills"], "analytical_skills/coding_skills/text_to_code") === 2 &&
      coverRank(["images_computer_vision/image_generation"], "images_computer_vision/image_generation") === 3,
    "a category skill covers the skills inside it"
  );

  mcp.close();
  useSandboxRuntime(null);
  console.log("agent runtime check passed");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
