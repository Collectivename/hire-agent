import type { AgentWorkspace } from "../workspace";

export type SkillDoc = {
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  body: string;
  path: string;
};

const SKILL_PATH = /^skills\/([a-z0-9][a-z0-9-]{0,31})\/SKILL\.md$/;

export function parseSkill(path: string, content: string): SkillDoc {
  const folder = SKILL_PATH.exec(path)?.[1] ?? "skill";
  let name = folder;
  let description = "";
  let version = "0.0.0";
  let enabled = true;
  let body = content.trim();
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      const front = content.slice(4, end);
      body = content.slice(end + 4).trim();
      for (const line of front.split("\n")) {
        const match = /^([a-zA-Z]+):\s*(.*)$/.exec(line.trim());
        if (!match) continue;
        const key = match[1]!.toLowerCase();
        const value = match[2]!.trim().replace(/^["']|["']$/g, "");
        if (key === "name" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) name = value;
        if (key === "description") description = value.slice(0, 280);
        if (key === "version") version = value.slice(0, 32);
        if (key === "enabled") enabled = value !== "false";
      }
    }
  }
  if (!description) description = body.split("\n").find((line) => line.trim())?.slice(0, 160) || name;
  return { name, description, version, enabled, body, path };
}

export function skillCatalog(workspace: AgentWorkspace): SkillDoc[] {
  const seen = new Set<string>();
  const skills: SkillDoc[] = [];
  for (const path of Object.keys(workspace.files).sort()) {
    if (!SKILL_PATH.test(path)) continue;
    const skill = parseSkill(path, workspace.files[path]!.content);
    if (!skill.enabled || seen.has(skill.name)) continue;
    seen.add(skill.name);
    skills.push(skill);
  }
  return skills;
}

export function skillByName(workspace: AgentWorkspace, name: string): SkillDoc | null {
  return skillCatalog(workspace).find((skill) => skill.name === name) ?? null;
}

export function skillScript(workspace: AgentWorkspace, name: string, script: string): string | null {
  const skill = skillCatalog(workspace).find((item) => item.name === name);
  if (!skill) return null;
  const folder = skill.path.split("/")[1];
  const path = `skills/${folder}/scripts/${script}`;
  if (!/^skills\/[a-z0-9][a-z0-9-]{0,31}\/scripts\/[a-z0-9][a-z0-9._-]{0,64}\.py$/.test(path)) return null;
  return workspace.files[path]?.content ?? null;
}
