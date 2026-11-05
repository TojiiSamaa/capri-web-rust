import assert from "node:assert/strict";
import { test } from "node:test";
import { elevenLabsGauges, liveAfter, NO_LIVE, openRouterGauges, quotaFromHeaders, resetTime, span } from "./quota.ts";

const NOW = 1_800_000_000_000;

test("reset times, in every format providers use", () => {
  assert.equal(resetTime("6m0s", NOW), NOW + 360_000);
  assert.equal(resetTime("1h2m3.5s", NOW), NOW + 3_723_500);
  assert.equal(resetTime("120ms", NOW), NOW + 120);
  assert.equal(resetTime("30", NOW), NOW + 30_000);
  assert.equal(resetTime("1800000100", NOW), 1_800_000_100_000);
  assert.equal(resetTime("1800000100000", NOW), 1_800_000_100_000);
  assert.equal(resetTime("2027-01-27T12:00:00Z", NOW), Date.parse("2027-01-27T12:00:00Z"));
  assert.equal(resetTime("nonsense", NOW), undefined);
  assert.equal(resetTime(null, NOW), undefined);
});

test("OpenAI headers", () => {
  const h = new Headers({ "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": "499", "x-ratelimit-reset-requests": "1s", "x-ratelimit-limit-tokens": "30000", "x-ratelimit-remaining-tokens": "29000", "x-ratelimit-reset-tokens": "2s" });
  assert.deepEqual(quotaFromHeaders(h, NOW), [
    { label: "Requêtes", remaining: 499, limit: 500, resetAt: NOW + 1000 },
    { label: "Tokens", remaining: 29000, limit: 30000, resetAt: NOW + 2000 },
  ]);
});

test("Anthropic headers, native and through its OpenAI layer", () => {
  const native = quotaFromHeaders(new Headers({ "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "49", "anthropic-ratelimit-requests-reset": "2027-01-27T12:00:00Z" }), NOW);
  assert.deepEqual(native, [{ label: "Requêtes", remaining: 49, limit: 50, resetAt: Date.parse("2027-01-27T12:00:00Z") }]);
  const layer = quotaFromHeaders(new Headers({ "x-ratelimit-requests": "50", "x-ratelimit-remaining-requests": "49" }), NOW);
  assert.equal(layer[0].limit, 50);
});

test("a provider that sends nothing gets no gauge, never a zero", () => {
  assert.deepEqual(quotaFromHeaders(new Headers({ "content-type": "application/json" }), NOW), []);
  assert.deepEqual(quotaFromHeaders(new Headers({ "x-ratelimit-remaining-requests": "many" }), NOW), []);
});

test("OpenRouter, with and without a spending limit", () => {
  assert.deepEqual(openRouterGauges({ data: { limit: 10, limit_remaining: 7.5, usage: 2.5 } }), [{ label: "Crédits de la clé", remaining: 7.5, limit: 10, unit: "$" }]);
  assert.deepEqual(openRouterGauges({ data: { limit: null, limit_remaining: null, usage: 2.5 } }), [{ label: "Crédits utilisés (clé sans plafond)", used: 2.5, unit: "$" }]);
  assert.equal(openRouterGauges({ data: { limit: null, usage: 0, free_model_daily_requests: { used: 1, limit: 50, remaining: 49 } } })[1].remaining, 49);
  assert.deepEqual(openRouterGauges(null), []);
});

test("ElevenLabs", () => {
  assert.deepEqual(elevenLabsGauges({ character_count: 1000, character_limit: 10000, next_character_count_reset_unix: 1_800_000_100 }), [{ label: "Caractères", remaining: 9000, limit: 10000, resetAt: 1_800_000_100_000 }]);
  assert.deepEqual(elevenLabsGauges({ detail: "missing" }), []);
});

test("a failure without headers keeps the last reading; a 429 is reported, then cleared", () => {
  const gauges = [{ label: "Requêtes", remaining: 1 }];
  const first = liveAfter(NO_LIVE, true, { quota: gauges, tokens: 10 }, NOW);
  assert.deepEqual(first, { gauges, at: NOW, tokens: 10, limited: null });
  const failed = liveAfter(first, false, { status: 429, retryAt: NOW + 5000 }, NOW + 1);
  assert.deepEqual(failed, { gauges, at: NOW, tokens: 10, limited: { until: NOW + 5000 } });
  assert.equal(liveAfter(failed, true, { quota: [] }, NOW + 2).limited, null);
  assert.deepEqual(liveAfter(failed, true, { quota: [] }, NOW + 2).gauges, []);
});

test("spans read like a person wrote them", () => {
  assert.equal(span(900), "1 s");
  assert.equal(span(252_000), "4 min 12 s");
  assert.equal(span(3_900_000), "1 h 5 min");
  assert.equal(span(-5), "0 s");
});
