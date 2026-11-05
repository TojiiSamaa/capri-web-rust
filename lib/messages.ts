// Validates what the browser sends before it reaches the provider. Nothing else in the chat route trusts the body.
import { LANGUAGES } from "./languages.ts";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export const MAX_MESSAGES = 120; // her longest memory, plus a job's tool calls and results
const MAX_TOOL_CHARS = 17_000;
export const MAX_CHARS = 500;
const MAX_REPLY_CHARS = 8000;

// Trust boundary: the browser's body decides what reaches the paid provider.
export function parseMessages(body: unknown): Message[] | null {
  const list = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MESSAGES) return null;
  const clean: Message[] = [];
  for (const m of list) {
    if (typeof m?.content !== "string") return null;
    const content = m.content.trim();
    // Rebuilt field by field, so no extra keys and no injected system role.
    if (m.role === "user") {
      if (!content || content.length > MAX_CHARS) return null;
      clean.push({ role: "user", content });
    } else if (m.role === "assistant") {
      const calls = m.tool_calls === undefined ? undefined : parseToolCalls(m.tool_calls);
      if (calls === null || (!content && !calls?.length) || content.length > MAX_REPLY_CHARS) return null;
      clean.push(calls?.length ? { role: "assistant", content, tool_calls: calls } : { role: "assistant", content });
    } else if (m.role === "tool") {
      if (typeof m.tool_call_id !== "string" || !content || content.length > MAX_TOOL_CHARS) return null;
      clean.push({ role: "tool", tool_call_id: m.tool_call_id, content });
    } else return null;
  }
  return clean.at(-1)!.role !== "assistant" ? clean : null;
}

// Same rule for tool calls: only the fields the provider needs, or null if anything is off.
function parseToolCalls(list: unknown): ToolCall[] | null {
  if (!Array.isArray(list)) return null;
  const clean: ToolCall[] = [];
  for (const c of list) {
    if (typeof c?.id !== "string" || typeof c?.function?.name !== "string" || typeof c.function.arguments !== "string") return null;
    clean.push({ id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments } });
  }
  return clean;
}

const text = (value: unknown, most: number) => (typeof value === "string" ? value.slice(0, most) : "");
const index = (value: unknown, most: number) => (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= most ? (value as number) : 0);

// Her settings for one reply, each bounded. Bad values fall back to safe ones.
export function parseCharacter(body: unknown) {
  const b = (body as Record<string, unknown> | null) ?? {};
  const language = text(b.language, 40);
  return {
    personality: text(b.personality, 20_000),
    nickname: text(b.nickname, 60).replace(/\s+/g, " ").trim(),
    notes: text(b.notes, 8_000),
    language: LANGUAGES.some((l) => l[1] === language) ? language : "",
    replies: index(b.replies, 2),
    maxReply: index(b.maxReply, 3),
  };
}

// Falls back to the server's .env.local. The URL must be http(s) and comes from the page,
// shortcut: the server fetches any address it is given, fine on localhost, restrict it before deploying.
export function parseBrain(body: unknown, env: Record<string, string | undefined> = {}) {
  const b = (body as Record<string, unknown> | null) ?? {};
  const url = text(b.baseUrl, 300).trim() || env.CAPRI_API_URL || "https://api.openai.com/v1";
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return null;
  return {
    url: url.replace(/\/+$/, ""),
    key: text(b.apiKey, 1000).trim() || env.CAPRI_API_KEY || "",
    model: text(b.model, 200).trim() || env.CAPRI_MODEL || "",
  };
}
