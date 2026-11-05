// Follows the app's own LayersCheck smoke test in app/Voice.cs, on the same test sounds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { glitched, layered, resample, seedOf, styled, timeStretch, vocoded, type VoiceStyle } from "./voicefx.ts";

const RATE = 24000;
const OFF = { on: false, pitch1: 2, delay1: 25, pitch2: -2.5, delay2: 25 };
const plain: VoiceStyle = { pitch: 0, speed: 100, robot: 0, glitch: 0, layers: OFF };

const tone = (hertz: number, size = 8000, seconds = 1) => Int16Array.from({ length: RATE * seconds }, (_, i) => size * Math.sin((2 * Math.PI * hertz * i) / RATE));

// Tone bursts with hiss between, like speech.
const line = (seconds = 2) => {
  let hiss = 11;
  return Int16Array.from({ length: RATE * seconds }, (_, i) => {
    hiss = (hiss * 1103515245 + 12345) & 0x7fffffff;
    return i % (RATE / 4) < RATE / 6 ? 5000 * Math.sin((2 * Math.PI * 170 * i) / RATE) + 1500 * Math.sin((2 * Math.PI * 510 * i) / RATE) : (hiss % 200) - 100;
  });
};

// The strongest frequency within 4% of `near`, over 0.3 to 0.9 s, by Goertzel with a Hann window.
function peak(sound: Int16Array, near: number) {
  const from = Math.floor(RATE * 0.3);
  const count = Math.floor(RATE * 0.6);
  let best = near;
  let strength = 0;
  for (let hertz = near * 0.96; hertz <= near * 1.04; hertz += 0.25) {
    const turn = 2 * Math.cos((2 * Math.PI * hertz) / RATE);
    let one = 0;
    let two = 0;
    for (let i = 0; i < count; i++) {
      const next = (sound[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1))) + turn * one - two;
      two = one;
      one = next;
    }
    const size = Math.sqrt(Math.max(0, one * one + two * two - turn * one * two));
    if (size > strength) {
      strength = size;
      best = hertz;
    }
  }
  return { hertz: best, strength };
}

const near = (value: number, expected: number, within: number) => assert.ok(Math.abs(value - expected) <= within, `${value} is not within ${within} of ${expected}`);

test("all off leaves her voice untouched", () => {
  const sound = line(1);
  assert.equal(styled(sound, RATE, plain, 1), sound);
});

test("pitch moves the tone and keeps the length", () => {
  const out = styled(tone(220), RATE, { ...plain, pitch: 3 }, 1);
  near(out.length, RATE, 2);
  near(peak(out, 220 * 2 ** (3 / 12)).hertz, 220 * 2 ** (3 / 12), 1);
});

test("speed changes the length and keeps the pitch", () => {
  const out = styled(tone(220, 8000, 2), RATE, { ...plain, speed: 150 }, 1);
  near(out.length, (RATE * 2) / 1.5, 2);
  near(peak(out, 220).hertz, 220, 1);
});

test("resample and time-stretch do what they say", () => {
  near(resample(tone(220), 2).length, RATE / 2, 1);
  assert.equal(timeStretch(tone(220), RATE, 1.5).length, RATE * 1.5);
});

test("layers: her voice plus each copy at its delay, sample for sample", () => {
  const said = line();
  const on = { on: true, pitch1: 5, delay1: 100, pitch2: -7, delay2: 200 };
  const mixed = layered(said, RATE, on);
  const up = styled(said, RATE, { ...plain, pitch: 5 }, 5);
  const down = styled(said, RATE, { ...plain, pitch: -7 }, 5);
  assert.equal(mixed.length, said.length + RATE / 5);
  let far = 0;
  for (let i = 0; i < mixed.length; i++) {
    far = Math.max(far, Math.abs(mixed[i] - Math.round((said[i] ?? 0) + 0.4 * ((up[i - RATE / 10] ?? 0) + (down[i - RATE / 5] ?? 0)))));
  }
  assert.ok(far <= 1, `${far} off`);
});

test("layers: each copy at its pitch, half steps too, about 8 dB under her", () => {
  for (const [p1, p2] of [[5, -7], [1.5, -2.5]]) {
    const mixed = layered(tone(220), RATE, { on: true, pitch1: p1, delay1: 25, pitch2: p2, delay2: 25 });
    const main = peak(mixed, 220);
    const high = peak(mixed, 220 * 2 ** (p1 / 12));
    const low = peak(mixed, 220 * 2 ** (p2 / 12));
    near(main.hertz, 220, 1);
    near(high.hertz / main.hertz / 2 ** (p1 / 12), 1, 0.005);
    near(low.hertz / main.hertz / 2 ** (p2 / 12), 1, 0.005);
    near(high.strength / main.strength, 0.4, 0.16);
    near(low.strength / main.strength, 0.4, 0.16);
  }
});

test("layers: too loud is held under full scale", () => {
  const loud = tone(200, 31100);
  const stacked = layered(loud, RATE, { on: true, pitch1: 0, delay1: 0, pitch2: 0, delay2: 0 });
  const spread = layered(loud, RATE, { on: true, pitch1: 3, delay1: 10, pitch2: -5, delay2: 30 });
  assert.equal(stacked.length, loud.length);
  const top = (s: Int16Array) => s.reduce((most, v) => Math.max(most, Math.abs(v)), 0);
  assert.ok(top(stacked) <= 31000 && top(spread) <= 31000);
  const level = Math.sqrt(stacked.reduce((sum, v) => sum + v * v, 0) / stacked.length);
  assert.ok(level > 20000, `level ${level}`);
});

test("glitch: same line, same glitches; more as the slider goes up; none in silence", () => {
  const said = line(6);
  const changes = (s: Int16Array) => s.length !== said.length || s.some((v, i) => v !== said[i]);
  const some = glitched(said, RATE, 0.5, 7);
  assert.ok(changes(some));
  assert.deepEqual(some, glitched(said, RATE, 0.5, 7));
  assert.notDeepEqual(some, glitched(said, RATE, 0.5, 8));
  const silence = new Int16Array(RATE * 3);
  assert.deepEqual(glitched(silence, RATE, 1, 7), silence);
});

test("robot: same length, sings on the nearest note, and 100% replaces her", () => {
  // 200 Hz sits between G3 (196) and G#3 (207.65); a full robot pulls it onto G3.
  const out = vocoded(tone(200), RATE, 1, 3);
  assert.equal(out.length, RATE);
  near(peak(out, 196).hertz, 196, 1.5);
  assert.deepEqual(out, vocoded(tone(200), RATE, 1, 3));
  const light = vocoded(tone(200), RATE, 0.1, 3);
  assert.ok(peak(light, 200).strength > peak(out, 200).strength);
  assert.ok(out.every((v) => Number.isFinite(v)));
});

test("everything together stays in range and is repeatable", () => {
  const style: VoiceStyle = { pitch: 3, speed: 120, robot: 40, glitch: 40, layers: { ...OFF, on: true } };
  const seed = seedOf("How do I sound now, choom?");
  const a = styled(line(), RATE, style, seed);
  assert.deepEqual(a, styled(line(), RATE, style, seed));
  assert.ok(a.length > RATE);
});
