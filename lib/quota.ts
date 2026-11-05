// Quotas as the providers report them: nothing here is estimated. No reading means no gauge.
export type Gauge = { label: string; remaining?: number; used?: number; limit?: number; resetAt?: number; unit?: "$" };
export type Reading = { gauges?: Gauge[]; error?: number };
export type Live = { gauges: Gauge[] | null; at: number; tokens: number; limited: { until?: number } | null };
export const NO_LIVE: Live = { gauges: null, at: 0, tokens: 0, limited: null };

const count = (value: string | null) => {
  const n = value === null || value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// Providers disagree: "6m0s" (OpenAI), RFC 3339 (Anthropic), seconds, or epoch seconds or milliseconds.
export function resetTime(value: string | null, now: number) {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n > 1e11 ? n : n > 1e9 ? n * 1000 : now + n * 1000;
  }
  if (/^(\d+(\.\d+)?(ms|s|m|h|d))+$/.test(text)) {
    let span = 0;
    for (const [, n, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) span += Number(n) * UNITS[unit];
    return now + span;
  }
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : date;
}

// The limits a provider states in its x-ratelimit-* response headers, when it does.
export function quotaFromHeaders(h: Headers, now = Date.now()): Gauge[] {
  const gauges: Gauge[] = [];
  for (const [label, kind] of [["Requêtes", "requests"], ["Tokens", "tokens"]]) {
    const remaining = count(h.get(`x-ratelimit-remaining-${kind}`) ?? h.get(`anthropic-ratelimit-${kind}-remaining`));
    if (remaining === undefined) continue;
    gauges.push({
      label,
      remaining,
      // Anthropic's OpenAI layer sends the limit as x-ratelimit-requests, not x-ratelimit-limit-requests.
      limit: count(h.get(`x-ratelimit-limit-${kind}`) ?? h.get(`x-ratelimit-${kind}`) ?? h.get(`anthropic-ratelimit-${kind}-limit`)),
      resetAt: resetTime(h.get(`x-ratelimit-reset-${kind}`) ?? h.get(`anthropic-ratelimit-${kind}-reset`), now),
    });
  }
  const remaining = count(h.get("x-ratelimit-remaining"));
  if (!gauges.length && remaining !== undefined) {
    gauges.push({ label: "Requêtes", remaining, limit: count(h.get("x-ratelimit-limit")), resetAt: resetTime(h.get("x-ratelimit-reset"), now) });
  }
  return gauges;
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

// GET openrouter.ai/api/v1/key. limit and limit_remaining are null on a key with no spending limit.
export function openRouterGauges(body: unknown): Gauge[] {
  const d = (body as { data?: Record<string, unknown> } | null)?.data ?? {};
  const gauges: Gauge[] = [];
  const limit = number(d.limit);
  const remaining = number(d.limit_remaining);
  const used = number(d.usage);
  if (limit !== undefined && remaining !== undefined) gauges.push({ label: "Crédits de la clé", remaining, limit, unit: "$" });
  else if (used !== undefined) gauges.push({ label: "Crédits utilisés (clé sans plafond)", used, unit: "$" });
  const free = d.free_model_daily_requests as Record<string, unknown> | null | undefined;
  const freeLeft = number(free?.remaining);
  if (freeLeft !== undefined) gauges.push({ label: "Modèles gratuits, par jour", remaining: freeLeft, limit: number(free?.limit) });
  return gauges;
}

// GET api.elevenlabs.io/v1/user/subscription.
export function elevenLabsGauges(body: unknown): Gauge[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const used = number(b.character_count);
  const limit = number(b.character_limit);
  if (used === undefined || limit === undefined) return [];
  const reset = number(b.next_character_count_reset_unix);
  return [{ label: "Caractères", remaining: Math.max(0, limit - used), limit, resetAt: reset === undefined ? undefined : reset * 1000 }];
}

// A failed answer with no headers says nothing about the quota, so the last reading stays.
export function liveAfter(prev: Live, ok: boolean, data: { quota?: Gauge[]; tokens?: unknown; status?: unknown; retryAt?: number }, now = Date.now()): Live {
  const read = ok || !!data.quota?.length;
  return {
    gauges: read ? data.quota ?? [] : prev.gauges,
    at: read ? now : prev.at,
    tokens: prev.tokens + (number(data.tokens) ?? 0),
    limited: data.status === 429 ? { until: data.retryAt } : ok ? null : prev.limited,
  };
}

const LIVE_KEY = "capri-quota-live";

// This tab only, so the readings survive a trip to the settings but not a change of provider.
export function loadLive(baseUrl: string): Live {
  try {
    const { baseUrl: from, ...saved } = JSON.parse(sessionStorage.getItem(LIVE_KEY) ?? "{}");
    return from === baseUrl ? { ...NO_LIVE, ...saved } : NO_LIVE;
  } catch {
    return NO_LIVE;
  }
}

export const saveLive = (live: Live, baseUrl: string) => sessionStorage.setItem(LIVE_KEY, JSON.stringify({ ...live, baseUrl }));

// A length of time in a few characters, for the panel.
export function span(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86_400)} j`;
}
