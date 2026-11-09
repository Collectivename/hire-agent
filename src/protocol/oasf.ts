import type { OasfRecord } from "./types";

const SLIM_NAME = /^[a-z0-9][a-z0-9._-]{0,62}(?:\/[a-z0-9][a-z0-9._-]{0,62}){2,}$/;

export function slimNameFor(platformId: string): string {
  const id = platformId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `collective/agents/service/${id}`;
}

export function buildOasfRecord(input: {
  nameUrl: string;
  description: string;
  skillIds: number[];
  platformId: string;
  solanaAddress: string;
  slimName: string;
}): OasfRecord {
  return {
    name: input.nameUrl.trim(),
    version: "0.1.0",
    schemaVersion: "v1",
    description: input.description.trim(),
    skills: input.skillIds.map((id) => ({ id })),
    locators: [{ type: "slim", url: input.slimName }],
    extensions: [
      {
        name: "collective.platform",
        data: {
          platformId: input.platformId,
          solanaAddress: input.solanaAddress,
        },
      },
    ],
  };
}

/** Skills are taxonomy ids. Free text is rejected. Name verification is not claimed. */
export function validateOasf(record: OasfRecord): string | null {
  if (typeof record.name !== "string" || !record.name.startsWith("https://")) {
    return "OASF name must be an https URL. Name verification also needs a JWKS document, which this publish does not claim.";
  }
  if (!record.description.trim() || record.description.length > 280) {
    return "Description must be 1–280 characters.";
  }
  if (!Array.isArray(record.skills) || record.skills.length === 0) {
    return "At least one OASF taxonomy skill id is required.";
  }
  for (const skill of record.skills) {
    if (!skill || typeof skill !== "object") return "Each skill must be an id.";
    if ("name" in skill || "text" in skill) return "Skills are taxonomy ids, not free text.";
    if (!Number.isInteger(skill.id) || skill.id <= 0 || skill.id > 1_000_000_000) {
      return "Skill id must be a positive integer from the OASF taxonomy.";
    }
  }
  const locator = record.locators?.find((item) => item.type === "slim");
  if (!locator || !SLIM_NAME.test(locator.url)) {
    return "A SLIM locator of the form organization/namespace/service/id is required.";
  }
  const ext = record.extensions?.find((item) => item.name === "collective.platform");
  if (!ext?.data.platformId || !ext?.data.solanaAddress) {
    return "The record must include the platform id and the provisioned Solana address.";
  }
  return null;
}
