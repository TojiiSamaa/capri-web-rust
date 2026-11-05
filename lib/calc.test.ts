import assert from "node:assert/strict";
import { test } from "node:test";
import { calculate, convert } from "./calc.ts";

test("sums follow the usual order and read French numbers", () => {
  for (const [text, want] of [["2+3*4", 14], ["(2+3)*4", 20], ["-2^2", -4], ["2^3^2", 512], ["2^-1", 0.5], ["0.1+0.2", 0.3], ["1,5 × 2", 3], ["1 000 ÷ 8", 125], ["sqrt(16)+abs(-1)", 5], ["round(pi*100)", 314], ["10-3-2", 5]] as const) {
    assert.equal(calculate(text), want, text);
  }
});

test("anything that isn't a sum is refused, and nothing runs", () => {
  for (const bad of ["", "2+", "(2", "2)", "2 3x", "process.exit(1)", "constructor", "sqrt", "1/0", "x".repeat(201), 3]) assert.throws(() => calculate(bad));
});

test("units convert inside their kind only", () => {
  assert.equal(convert(10, "km", "m"), 10000);
  assert.equal(convert(1, "mi", "km"), 1.609344);
  assert.equal(convert(100, "km/h", "m/s"), 27.7777777778);
  assert.equal(convert(1, "Go", "Mo"), 1000);
  assert.equal(convert(100, "°C", "F"), 212);
  assert.equal(convert(32, "f", "c"), 0);
  assert.throws(() => convert(1, "km", "kg"), /impossible/);
  assert.throws(() => convert(1, "constructor", "toString"), /impossible/);
  assert.throws(() => convert(-300, "c", "k"), /zéro absolu/);
  assert.throws(() => convert("1", "km", "m"), /nombre/);
});
