import assert from "node:assert/strict";
import { test } from "node:test";
import { liveAfter, NO_LIVE, span } from "./quota.ts";

const NOW = 1_800_000_000_000;

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
