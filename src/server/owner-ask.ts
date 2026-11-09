import { secretMaterial } from "./messages";

/** Buttons or a text field the owner uses before the agent continues. */
export type OwnerAsk = {
  prompt: string;
  choices: string[];
  multiple: boolean;
  inputLabel: string;
};

function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function choiceList(value: unknown): unknown[] | string {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return "Each choice is a short label.";
    }
  }
  return [trimmed];
}

/** A question with buttons, a multiple choice, a text field, or both. */
export function parseOwnerAsk(args: Record<string, unknown>): OwnerAsk | string {
  const prompt = oneLine(args.prompt) || oneLine(args.question);
  if (!prompt || prompt.length > 240) return "Ask in one short question.";
  const listed = choiceList(args.choices ?? args.options ?? args.buttons);
  if (typeof listed === "string") return listed;
  const rawChoices = listed;
  const choices: string[] = [];
  for (const item of rawChoices) {
    if (typeof item !== "string") return "Each choice is a short label.";
    const label = item.replace(/\s+/g, " ").trim();
    if (!label || label.length > 80) return "Each choice is a short label.";
    if (label.toLowerCase() === "other") continue;
    if (choices.includes(label)) return "Each choice is different.";
    choices.push(label);
  }
  if (choices.length > 6) return "Ask for at most six choices.";
  const multiple = args.multiple === true;
  if (multiple && choices.length < 2) return "More than one choice needs at least two buttons.";
  const inputLabel = oneLine(args.input) || oneLine(args.field);
  if (inputLabel.length > 80) return "The text field label is too long.";
  if (choices.length === 0 && !inputLabel) return "Add a button or a text field.";
  if (secretMaterial([prompt, inputLabel, ...choices].join("\n"))) return "That question looks like a credential.";
  return { prompt, choices, multiple: multiple && choices.length > 1, inputLabel };
}

/** The owner's answer. Other is the text they typed, not the word Other. */
export function ownerAnswer(input: { picked: string[]; other: string; typed: string }): string {
  const custom = input.other.replace(/\s+/g, " ").trim();
  const notes = input.typed.replace(/\s+/g, " ").trim();
  const choices = input.picked.map((item) => item.trim()).filter(Boolean);
  if (custom) choices.push(custom);
  return [choices.join(", "), notes].filter(Boolean).join(". ");
}

const CALL_BLOCK = /<(?:[a-z0-9]+:)?function_calls\b[^>]*>[\s\S]*?<\/(?:[a-z0-9]+:)?function_calls>/gi;
const INVOKE = /<(?:[a-z0-9]+:)?invoke\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?invoke>/gi;
const PARAM = /<(?:[a-z0-9]+:)?parameter\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?parameter>/gi;

/** A tool call written into the reply instead of the tool channel. */
export function toolCallsInText(text: string): { text: string; calls: { id: string; name: string; arguments: string }[] } {
  const calls: { id: string; name: string; arguments: string }[] = [];
  const cleaned = text.replace(CALL_BLOCK, (block) => {
    INVOKE.lastIndex = 0;
    let invoke: RegExpExecArray | null;
    while ((invoke = INVOKE.exec(block))) {
      const name = invoke[1]?.trim() ?? "";
      if (!name) continue;
      const args: Record<string, string> = {};
      PARAM.lastIndex = 0;
      let param: RegExpExecArray | null;
      const body = invoke[2] ?? "";
      while ((param = PARAM.exec(body))) {
        const key = param[1]?.trim() ?? "";
        if (key) args[key] = (param[2] ?? "").trim();
      }
      calls.push({ id: `call_${calls.length}`, name, arguments: JSON.stringify(args) });
    }
    return "";
  });
  return { text: cleaned.replace(/\n{3,}/g, "\n\n").trim(), calls };
}
