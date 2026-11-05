// Talks to the model provider with the key saved on this machine; the page never sees it.
import { isLocalRequest, refused } from "@/lib/guard";
import { chatTools } from "@/lib/mcp";
import { parseCharacter, parseMessages } from "@/lib/messages";
import { buildPrompt, replyLimit, withLanguageRule } from "@/lib/persona";
import { quotaFromHeaders, resetTime } from "@/lib/quota";
import { savedBrain } from "@/lib/store";

const MAX_BODY = 2_000_000;

// One step of the conversation: sends the messages to the provider and returns her reply or the tools she wants to run.
export async function POST(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  const raw = await req.text();
  if (raw.length > MAX_BODY) return Response.json({ error: "too_large" }, { status: 413 });

  let body: { character?: unknown; useTools?: unknown } | null = null;
  try {
    body = JSON.parse(raw);
  } catch {}
  const messages = parseMessages(body);
  const brain = savedBrain();
  if (!messages || !brain) return Response.json({ error: "bad_request" }, { status: 400 });
  if (!brain.model) return Response.json({ error: "not_configured" }, { status: 503 });

  const character = parseCharacter(body?.character);
  const tools = body?.useTools === true ? await chatTools().catch(() => []) : [];

  const send = (withTools: boolean) =>
    fetch(`${brain.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(brain.key && { Authorization: `Bearer ${brain.key}` }) },
      body: JSON.stringify({
        model: brain.model,
        messages: [{ role: "system", content: buildPrompt(character, withTools) }, ...withLanguageRule(messages, character.language)],
        max_tokens: replyLimit(character, withTools),
        ...(withTools && { tools }),
      }),
      signal: AbortSignal.timeout(120_000),
    });

  try {
    let res = await send(tools.length > 0);
    // Some models can't take tools at all; talking still has to work. Not mid-job, where tool messages need them.
    if (res.status === 400 && tools.length && !messages.some((m) => m.role === "tool")) res = await send(false);
    const quota = quotaFromHeaders(res.headers);
    if (!res.ok) {
      console.error("[chat] provider answered", res.status, (await res.text()).slice(0, 300));
      return Response.json({ error: "provider_failed", status: res.status, quota, retryAt: resetTime(res.headers.get("retry-after"), Date.now()) }, { status: 502 });
    }
    const answer = await res.json();
    const message = answer?.choices?.[0]?.message;
    const reply = typeof message?.content === "string" ? message.content.trim() : "";
    const toolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length ? message.tool_calls : undefined;
    if (!reply && !toolCalls) throw new Error("provider sent nothing");
    return Response.json({ reply, toolCalls, quota, tokens: answer?.usage?.total_tokens });
  } catch (error) {
    console.error("[chat]", error);
    return Response.json({ error: "provider_failed" }, { status: 502 });
  }
}
