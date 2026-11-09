import "server-only";
import { OASF_SKILLS, taxonomySkill } from "../protocol/oasf-taxonomy";
import { loadWorkspace } from "./agent/persist";
import { browseDirectory } from "./directory";
import { agentStore } from "./store";

const SKIP = new Set([
  "this", "that", "with", "from", "your", "into", "about", "agent", "work", "make", "build", "create", "write",
  "using", "have", "will", "should", "them", "then", "than", "when", "what", "which", "also", "just", "more",
  "some", "only", "other", "over", "after", "before", "where", "need", "want", "website",
]);

/** Parent path of an OASF skill. `images_computer_vision/image_generation` is the images category. */
export function categoryOf(path: string): string {
  const parts = path.split("/");
  return parts.slice(0, -1).join("/");
}

function tokensOf(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((token) => !SKIP.has(token)));
}

function sameToken(part: string, token: string): boolean {
  return part === token || part.startsWith(token) || token.startsWith(part);
}

function lastSegmentOverlap(path: string, tokens: Set<string>): number {
  const last = path.split("/").pop() ?? "";
  let score = 0;
  for (const part of last.split("_")) {
    if (part.length < 5) continue;
    for (const token of tokens) {
      if (token.length < 5 || !sameToken(part, token)) continue;
      score += token.length;
    }
  }
  return score;
}

/** The exact skill, every skill in its category, and related skills that share a word such as image. */
export function discoverySkills(skill: string, brief: string): string[] {
  const exact = taxonomySkill(skill);
  const focus = tokensOf(`${exact ? (exact.split("/").pop() ?? "") : skill} ${brief}`);
  const category = exact ? categoryOf(exact) : "";
  const ranked = OASF_SKILLS.map((path) => {
    let score = 0;
    if (exact && path === exact) score += 100;
    if (category && path.startsWith(`${category}/`)) score += 40;
    score += lastSegmentOverlap(path, focus);
    return { path, score };
  })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const picked: string[] = [];
  for (const item of ranked) {
    if (picked.length >= 12) break;
    picked.push(item.path);
  }
  for (const path of [...picked]) {
    const top = path.split("/")[0] ?? "";
    const node = taxonomySkill(`${top}/${top}`);
    if (node && !picked.includes(node)) picked.push(node);
    const parent = categoryOf(path);
    const parentLast = parent.split("/").pop() ?? "";
    const nested = parent ? taxonomySkill(`${parent}/${parentLast}`) : null;
    if (nested && !picked.includes(nested)) picked.push(nested);
  }
  return picked;
}

function categoryNode(skill: string, neededCategory: string): boolean {
  if (categoryOf(skill) !== neededCategory) return false;
  const last = skill.split("/").pop() ?? "";
  const parent = neededCategory.split("/").pop() ?? "";
  return last === parent;
}

/** 3 exact, 2 the published skill is the category, 1 another skill in that category. */
export function coverRank(held: readonly string[], needed: string): number {
  if (!taxonomySkill(needed)) return 0;
  const neededCategory = categoryOf(needed);
  let best = 0;
  for (const skill of held) {
    if (!taxonomySkill(skill)) continue;
    if (skill === needed) best = Math.max(best, 3);
    else if (needed.startsWith(`${skill}/`) || categoryNode(skill, neededCategory)) best = Math.max(best, 2);
    else if (categoryOf(skill) === neededCategory) best = Math.max(best, 1);
  }
  return best;
}

/** Shared words between the job and the agent's name and description. */
export function descriptionFit(brief: string, description: string): number {
  const wanted = tokensOf(brief);
  const offered = tokensOf(description);
  let score = 0;
  for (const token of wanted) {
    for (const word of offered) {
      if (sameToken(word, token)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

function clip(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= 240 ? text : `${text.slice(0, 240)}…`;
}

function coverLine(rank: number, needed: string): string {
  if (rank >= 3) return `Published skill matches ${needed}.`;
  if (rank === 2) return `A published category skill covers ${needed}.`;
  if (rank === 1) return `Published skills are in the ${categoryOf(needed)} category.`;
  return "Related skill category. Read the description.";
}

/** Listed agents for a hire. Category skills count, and each row includes that agent's description. */
export async function discoverForHire(input: { skill: string; brief: string; excludePlatformId: string }): Promise<string> {
  const skills = discoverySkills(input.skill, input.brief);
  const needed = taxonomySkill(input.skill);
  if (!skills.length || !needed) {
    return "Skill must be an OASF path such as multi_modal/image_processing/text_to_image or images_computer_vision/image_generation. Pass the owner's request as brief.";
  }
  let found;
  try {
    found = await browseDirectory(needed);
  } catch {
    return "The directory could not be read. Try the search again.";
  }
  const byId = new Map<string, { platformId: string; skills: string[]; name: string; description: string }>();
  for (const hit of found.hits) {
    if (hit.platformId === input.excludePlatformId) continue;
    byId.set(hit.platformId, {
      platformId: hit.platformId,
      skills: hit.skills,
      name: hit.name ?? "",
      description: hit.description ?? "",
    });
  }
  if (byId.size === 0) return `No listed agent is in the ${categoryOf(needed)} category or a related one.`;
  const rows = [];
  for (const hit of byId.values()) {
    const agent = await agentStore().getAgent(hit.platformId);
    const workspace = agent ? await loadWorkspace(hit.platformId, agent.name) : null;
    const identity = workspace?.files["IDENTITY.md"]?.content ?? "";
    const description = /^Description:\s*(.+)$/m.exec(identity)?.[1]?.trim() || hit.description;
    const name = agent?.name || hit.name || "Agent";
    rows.push({
      name,
      platformId: hit.platformId,
      skills: hit.skills,
      description,
      cover: coverRank(hit.skills, needed),
      words: descriptionFit(`${input.brief}\n${needed}`, `${name}\n${description}`),
    });
  }
  rows.sort((left, right) => {
    if (right.cover !== left.cover) return right.cover - left.cover;
    if (right.words !== left.words) return right.words - left.words;
    return left.name.localeCompare(right.name);
  });
  return rows
    .slice(0, 5)
    .map((row) =>
      [
        `${row.name} (${row.platformId})`,
        `Description: ${row.description ? clip(row.description) : "No description."}`,
        `Skills: ${row.skills.join(", ")}`,
        `Category: ${[...new Set(row.skills.map(categoryOf))].filter(Boolean).join(", ")}`,
        coverLine(row.cover, needed),
      ].join("\n")
    )
    .join("\n\n");
}
