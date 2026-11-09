import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { AgentsError } from "./errors";

export type ModalSecretClient = {
  create(name: string, entries: Record<string, string>, requiredKeys: string[]): Promise<void>;
  update(name: string, entries: Record<string, string>, requiredKeys: string[]): Promise<void>;
  delete(name: string): Promise<void>;
  lookup(name: string, requiredKeys: string[]): Promise<boolean>;
};

let override: ModalSecretClient | null = null;

/** Tests install a fake. Production uses the Python Modal SDK over stdin. */
export function useModalSecretClient(client: ModalSecretClient | null): void {
  override = client;
}

function assertName(name: string): void {
  if (!/^byok-[a-f0-9]{24}-(openai|anthropic|gemini|muse)$/.test(name)) {
    throw new AgentsError("POLICY_DENIED", "That secret name is not an owner provider secret.", 403);
  }
}

async function pythonModal(
  op: "create" | "update" | "delete" | "lookup",
  name: string,
  entries?: Record<string, string>,
  requiredKeys: string[] = []
): Promise<boolean> {
  assertName(name);
  const nested = path.join(process.cwd(), "hire", "runtime", "modal_secrets.py");
  const script = existsSync(nested) ? nested : path.join(process.cwd(), "runtime", "modal_secrets.py");
  const payload = JSON.stringify({ op, name, entries: entries ?? {}, required_keys: requiredKeys });
  return new Promise((resolve, reject) => {
    const child = spawn("python", [script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new AgentsError("PROVIDER_UNAVAILABLE", "Modal did not answer.", 503));
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new AgentsError("PROVIDER_UNAVAILABLE", "The Modal helper is not installed.", 503));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed: { ok?: boolean } = {};
      try {
        parsed = JSON.parse(out) as { ok?: boolean };
      } catch {
        parsed = {};
      }
      if (code !== 0 || !parsed.ok) {
        reject(new AgentsError("PROVIDER_UNAVAILABLE", "Modal did not store the credential.", 503));
        return;
      }
      resolve(true);
    });
    child.stdin.end(payload);
  });
}

function client(): ModalSecretClient {
  if (override) return override;
  return {
    create: (name, entries, requiredKeys) => pythonModal("create", name, entries, requiredKeys).then(() => undefined),
    update: (name, entries, requiredKeys) => pythonModal("update", name, entries, requiredKeys).then(() => undefined),
    delete: (name) => pythonModal("delete", name).then(() => undefined),
    lookup: (name, requiredKeys) => pythonModal("lookup", name, {}, requiredKeys),
  };
}

export async function createNamedSecret(name: string, envName: string, value: string): Promise<void> {
  await client().create(name, { [envName]: value }, [envName]);
}

export async function updateNamedSecret(name: string, envName: string, value: string): Promise<void> {
  await client().update(name, { [envName]: value }, [envName]);
}

export async function deleteNamedSecret(name: string): Promise<void> {
  await client().delete(name);
}

export async function lookupNamedSecret(name: string, requiredKeys: string[]): Promise<boolean> {
  return client().lookup(name, requiredKeys);
}
