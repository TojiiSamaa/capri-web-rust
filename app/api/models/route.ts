// Asks the saved provider which models it offers, for the picker in the settings.
import { isLocalRequest, refused } from "@/lib/guard";
import { savedBrain } from "@/lib/store";

export async function POST(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  const brain = savedBrain();
  if (!brain) return Response.json({ error: "bad_address" }, { status: 400 });
  try {
    const res = await fetch(`${brain.url}/models`, {
      headers: brain.key ? { Authorization: `Bearer ${brain.key}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return Response.json({ error: "provider_failed", status: res.status }, { status: 502 });
    const list: unknown = (await res.json())?.data;
    if (!Array.isArray(list)) throw new Error("no model list");
    const models = list.map((m) => m?.id).filter((id): id is string => typeof id === "string").sort();
    return Response.json({ models });
  } catch (error) {
    console.error("[models]", error);
    return Response.json({ error: "provider_failed" }, { status: 502 });
  }
}
