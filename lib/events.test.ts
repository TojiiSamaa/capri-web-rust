import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_INS, idleEvent, MURMURS, pick } from "./events.ts";

const rolls = Array.from({ length: 100 }, (_, i) => i / 100);

test("every event can happen when nothing bars it", () => {
  const seen = new Set(rolls.map((r) => idleEvent({ hop: true, nap: true, teleport: true }, r)));
  assert.deepEqual([...seen].sort(), ["glitch", "grin", "hop", "nap", "teleport"]);
});

test("a barred event never happens: no walking with Balade off, no nap with Sommeil on Jamais", () => {
  const seen = new Set(rolls.map((r) => idleEvent({ hop: false, nap: false, teleport: false }, r)));
  assert.deepEqual([...seen].sort(), ["glitch", "grin"]);
});

test("pick stays in the list at both ends of the roll", () => {
  assert.equal(pick(MURMURS, 0), MURMURS[0]);
  assert.equal(pick(CHECK_INS, 0.999999), CHECK_INS.at(-1));
});
