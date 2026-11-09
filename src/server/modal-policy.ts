import { sha256Hex } from "./crypto";
import { AgentsError } from "./errors";

export const MODEL_PROVIDERS = ["openai", "anthropic", "gemini", "muse"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

const MODELS: Record<ModelProvider, readonly string[]> = {
  openai: ["gpt-4o", "gpt-4.1", "gpt-4o-mini"],
  anthropic: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  muse: ["muse-spark-1.3", "muse-wonder-1.0", "muse-image-1.0", "muse-voice-transcribe-1.0", "sam-3.1"],
};

type ProviderSpec = {
  domain: string;
  env: string;
  header: string;
  value: string;
};

const SPECS: Record<ModelProvider, ProviderSpec> = {
  openai: {
    domain: "api.openai.com",
    env: "OPENAI_API_KEY",
    header: "Authorization",
    value: "Bearer $OPENAI_API_KEY",
  },
  anthropic: {
    domain: "api.anthropic.com",
    env: "ANTHROPIC_API_KEY",
    header: "x-api-key",
    value: "$ANTHROPIC_API_KEY",
  },
  gemini: {
    domain: "generativelanguage.googleapis.com",
    env: "GOOGLE_API_KEY",
    header: "x-goog-api-key",
    value: "$GOOGLE_API_KEY",
  },
  muse: {
    domain: "api.meta.ai",
    env: "MODEL_API_KEY",
    header: "Authorization",
    value: "Bearer $MODEL_API_KEY",
  },
};

export function modelProvider(value: string): ModelProvider {
  if ((MODEL_PROVIDERS as readonly string[]).includes(value)) return value as ModelProvider;
  throw new AgentsError("INVALID_PARAMS", "provider must be openai, anthropic, gemini, or muse.", 400);
}

export function providerSpec(provider: ModelProvider): ProviderSpec {
  return SPECS[provider];
}

export function allowedModel(provider: ModelProvider, modelId: string): string {
  const choice = modelId.trim();
  if (!MODELS[provider].includes(choice)) {
    throw new AgentsError("INVALID_PARAMS", "That model is not on the allow list.", 400);
  }
  return choice;
}

export function defaultModel(provider: ModelProvider): string {
  return MODELS[provider][0]!;
}

/** Opaque owner id. The secret name has no email, username, or wallet text. */
export function byokSecretName(owner: string, provider: ModelProvider): string {
  return `byok-${sha256Hex(owner).slice(0, 24)}-${provider}`;
}

/**
 * Modal's current sandbox secret-injection guide says an outbound policy
 * cannot be combined with outboundDomainAllowlist or blockNetwork.
 * Unmatched HTTPS is passed through and does not receive the key.
 * A running sandbox reads secret values at create time and when
 * experimentalUpdateOutboundPolicy is called, not when the secret changes.
 */
export const OUTBOUND_POLICY_LIMIT =
  "An outbound policy cannot be combined with a domain allowlist. The key is injected only for the exact provider host. A running sandbox does not reload a secret until its outbound policy is replaced.";

export type SandboxSpec = {
  name: string;
  secrets: [];
  experimentalOutboundPolicy: {
    replacements: { domain: string; secretName: string; requiredKeys: string[]; headers: Record<string, string> }[];
  };
};

/** Skill scripts run here, with the network blocked and no provider secret. */
export function scriptSandboxName(owner: string): string {
  return `skill-${sha256Hex(owner).slice(0, 16)}`;
}

export function sandboxSpec(owner: string, provider: ModelProvider): SandboxSpec {
  const spec = providerSpec(provider);
  const secretName = byokSecretName(owner, provider);
  return {
    name: `agent-${sha256Hex(owner).slice(0, 16)}`,
    secrets: [],
    experimentalOutboundPolicy: {
      replacements: [
        {
          domain: spec.domain,
          secretName,
          requiredKeys: [spec.env],
          headers: { [spec.header]: spec.value },
        },
      ],
    },
  };
}

export function assertSpecHidesKey(spec: SandboxSpec, rawKey: string): void {
  const encoded = JSON.stringify(spec);
  if (spec.secrets.length > 0) {
    throw new AgentsError("POLICY_DENIED", "Customer keys are not sandbox secrets.", 500);
  }
  if (encoded.includes("*")) {
    throw new AgentsError("POLICY_DENIED", "Injection domains are exact hosts.", 500);
  }
  if (rawKey && encoded.includes(rawKey)) {
    throw new AgentsError("POLICY_DENIED", "The sandbox spec contains the provider key.", 500);
  }
}
