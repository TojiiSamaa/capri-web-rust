// Quotas as the providers report them: nothing here is estimated. No reading means no gauge.
export type Gauge = { label: string; remaining?: number; used?: number; limit?: number; resetAt?: number; unit?: "$" };
export type Reading = { gauges?: Gauge[]; error?: number };
export type Live = { gauges: Gauge[] | null; at: number; tokens: number; limited: { until?: number } | null };
export const NO_LIVE: Live = { gauges: null, at: 0, tokens: 0, limited: null };

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

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
