// Reads the quotas that have their own endpoint, with the saved keys. Reading them costs nothing.
import { isLocalRequest, refused } from "@/lib/guard";
import { elevenLabsGauges, type Gauge, openRouterGauges, type Reading } from "@/lib/quota";
import { savedBrain, store } from "@/lib/store";

async function reading(url: string, headers: Record<string, string>, gauges: (body: unknown) => Gauge[]): Promise<Reading> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: res.status };
    return { gauges: gauges(await res.json()) };
  } catch (error) {
    console.error("[quota]", error);
    return { error: 0 };
  }
}

const isOpenRouter = (url: string) => {
  try {
    return new URL(url).hostname === "openrouter.ai"; // this key is only ever sent to its own provider
  } catch {
    return false;
  }
};

// The two providers with a free endpoint to read. Everyone else reports through the headers of a chat reply.
export async function POST(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  const brain = savedBrain();
  const voiceKey = store().settings().voiceMode === "cloud" ? store().secrets().elevenKey : "";
  const [credits, voice] = await Promise.all([
    brain?.key && isOpenRouter(brain.url) ? reading("https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${brain.key}` }, openRouterGauges) : undefined,
    voiceKey ? reading("https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": voiceKey }, elevenLabsGauges) : undefined,
  ]);
  return Response.json({ credits, voice });
}
