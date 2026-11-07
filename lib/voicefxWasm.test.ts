// The Rust build must sound exactly like the TypeScript one: same line in, same samples out. Needs `npm run build:wasm`.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { isPlain, seedOf, styled, type VoiceStyle } from "./voicefx.ts";
import { loadFx } from "./voicefxWasm.ts";

const WASM = new URL("../public/voicefx.wasm", import.meta.url);
const RATE = 24000;
const OFF = { on: false, pitch1: 2, delay1: 25, pitch2: -2.5, delay2: 25 };
const plain: VoiceStyle = { pitch: 0, speed: 100, robot: 0, glitch: 0, layers: OFF };

// Tone bursts with hiss between, like speech.
const line = (seconds: number) => {
  let hiss = 11;
  return Int16Array.from({ length: RATE * seconds }, (_, i) => {
    hiss = (hiss * 1103515245 + 12345) & 0x7fffffff;
    return i % (RATE / 4) < RATE / 6 ? 5000 * Math.sin((2 * Math.PI * 170 * i) / RATE) + 1500 * Math.sin((2 * Math.PI * 510 * i) / RATE) : (hiss % 200) - 100;
  });
};

const CASES: Record<string, VoiceStyle> = {
  "pitch up": { ...plain, pitch: 3 },
  "pitch down": { ...plain, pitch: -5 },
  "faster": { ...plain, speed: 130 },
  "slower": { ...plain, speed: 70 },
  "robot": { ...plain, robot: 60 },
  "light robot": { ...plain, robot: 10 },
  "glitch": { ...plain, glitch: 50 },
  "layers": { ...plain, layers: { ...OFF, on: true } },
  "layers at half steps": { ...plain, layers: { on: true, pitch1: 1.5, delay1: 100, pitch2: -7, delay2: 200 } },
  "everything": { pitch: 3, speed: 120, robot: 40, glitch: 40, layers: { ...OFF, on: true } },
};

const missing = !existsSync(WASM);
const fx = () => loadFx(readFileSync(WASM));

test("public/voicefx.wasm exists (run npm run build:wasm)", () => assert.ok(!missing, "build it first: npm run build:wasm"));

for (const [name, style] of Object.entries(CASES)) {
  test(`rust = typescript, sample for sample: ${name}`, { skip: missing }, () => {
    const said = line(3);
    const seed = seedOf(name);
    const want = styled(said, RATE, style, seed);
    const got = fx().styled(said, RATE, style, seed);
    assert.equal(got.length, want.length);
    const off = got.findIndex((v, i) => v !== want[i]);
    assert.equal(off, -1, `first difference at sample ${off}: ${got[off]} instead of ${want[off]}`);
  });
}

test("rust: a plain style hands the line back as it was", { skip: missing }, () => {
  const said = line(1);
  assert.ok(isPlain(plain));
  assert.deepEqual(fx().styled(said, RATE, plain, 1), said);
});

test("rust: the seed matters (the match above is not two copies of the input)", { skip: missing }, () => {
  const said = line(3);
  const style = CASES.glitch;
  assert.notDeepEqual(fx().styled(said, RATE, style, 1), fx().styled(said, RATE, style, 2));
  assert.notDeepEqual(fx().styled(said, RATE, style, 1), said);
});

test("rust: the same instance can style many lines, short ones and silence included", { skip: missing }, () => {
  const rust = fx();
  for (const seconds of [1, 2, 1]) {
    const said = line(seconds);
    assert.deepEqual(rust.styled(said, RATE, CASES.everything, 9), styled(said, RATE, CASES.everything, 9));
  }
  const tiny = Int16Array.from({ length: 300 }, (_, i) => (i * 37) % 1000);
  assert.deepEqual(rust.styled(tiny, RATE, CASES.everything, 9), styled(tiny, RATE, CASES.everything, 9));
  const silence = new Int16Array(RATE * 2);
  assert.deepEqual(rust.styled(silence, RATE, CASES.everything, 9), styled(silence, RATE, CASES.everything, 9));
});

test("rust: other sample rates take the same path as TypeScript", { skip: missing }, () => {
  for (const rate of [16000, 44100]) {
    const said = Int16Array.from({ length: rate * 2 }, (_, i) => 6000 * Math.sin((2 * Math.PI * 190 * i) / rate));
    assert.deepEqual(fx().styled(said, rate, CASES.everything, 3), styled(said, rate, CASES.everything, 3), `${rate} Hz`);
  }
});
