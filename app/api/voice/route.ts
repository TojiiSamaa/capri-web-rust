// Turns a line into speech with ElevenLabs. This is the one route that spends voice credits.
import { isLocalRequest, refused } from "@/lib/guard";
import { store } from "@/lib/store";

const MAX_TEXT = 4000;

// Proxy for her ElevenLabs voice, with the key saved on this machine.
export async function POST(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  const b = await req.json().catch(() => null);
  const key = store().secrets().elevenKey;
  const ok =
    !!key &&
    typeof b?.voiceId === "string" && /^[\w-]{1,64}$/.test(b.voiceId) &&
    typeof b.model === "string" && /^[\w.-]{1,64}$/.test(b.model) &&
    typeof b.text === "string" && b.text.trim().length > 0 && b.text.length <= MAX_TEXT;
  if (!ok) return Response.json({ error: "bad_request" }, { status: 400 });

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${b.voiceId}?output_format=wav_24000`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": key },
      body: JSON.stringify({ text: b.text, model_id: b.model }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok || !res.body) {
      console.error("[voice] ElevenLabs answered", res.status, (await res.text()).slice(0, 300));
      return Response.json({ error: "provider_failed", status: res.status }, { status: 502 });
    }
    return new Response(res.body, { headers: { "Content-Type": "audio/wav" } });
  } catch (error) {
    console.error("[voice]", error);
    return Response.json({ error: "provider_failed" }, { status: 502 });
  }
}
