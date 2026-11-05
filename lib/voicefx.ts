// Her voice effects, ported from VoiceFx in capri-desktop app/Voice.cs (PolyForm Noncommercial, see LICENSE.md):
// pitch, speed, robot, glitch and voice layers. The app styles a stream; here a whole line is styled at once, which
// the app guarantees sounds the same. Samples stay on the app's 16-bit scale, so its thresholds carry over as they are.

export type VoiceStyle = {
  pitch: number; // semitones
  speed: number; // percent
  robot: number; // percent
  glitch: number; // percent
  layers: { on: boolean; pitch1: number; delay1: number; pitch2: number; delay2: number };
};

const LAYER_LEVEL = 0.4; // 8 dB under her
const LIMITER_CEILING = 31000;

// Rounds to a 16-bit sample, clamped to its range.
const clip = (value: number) => Math.max(-32768, Math.min(32767, Math.round(value)));

// Leaves samples alone up to 28000, then bends them toward full scale instead of clipping.
function soft(value: number) {
  const size = Math.abs(value);
  return clip(size > 28000 ? Math.sign(value) * (28000 + 4767 * Math.tanh((size - 28000) / 4767)) : value);
}

// shortcut: not .NET's Random, so a line glitches the same way every time here but not the same way as in the desktop app.
function randomFrom(seed: number) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The same line glitches and hisses the same way every time.
export function seedOf(text: string) {
  let hash = 2166136261 | 0;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash & 0x7fffffff;
}

// Plays the sound `factor` times faster: higher and shorter by that ratio. A windowed sinc, so a higher voice doesn't alias.
export function resample(pcm: Int16Array, factor: number) {
  const phases = 256;
  const cutoff = Math.min(1, 1 / factor);
  const reach = Math.ceil(16 / cutoff);
  const taps = 2 * reach;
  const kernel = new Float64Array((phases + 1) * taps);
  for (let phase = 0; phase <= phases; phase++) {
    const fraction = phase / phases;
    let total = 0;
    for (let k = 0; k < taps; k++) {
      const x = k - reach + 1 - fraction;
      const t = x * cutoff;
      const weight = (Math.abs(t) < 1e-9 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * (Math.abs(x) >= reach ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * x) / reach));
      kernel[phase * taps + k] = weight;
      total += weight;
    }
    for (let k = 0; k < taps; k++) kernel[phase * taps + k] /= total;
  }
  const out = new Int16Array(Math.round(pcm.length / factor));
  for (let made = 0; made < out.length; made++) {
    const center = made * factor;
    const whole = Math.floor(center);
    const row = Math.round((center - whole) * phases) * taps;
    const start = whole - reach + 1;
    let value = 0;
    for (let k = 0; k < taps; k++) {
      const j = start + k;
      if (j >= 0 && j < pcm.length) value += pcm[j] * kernel[row + k];
    }
    out[made] = clip(value);
  }
  return out;
}

// Makes the sound `stretch` times longer at the same pitch: 20 ms windows, each lined up with the one before it within 5 ms (WSOLA).
export function timeStretch(pcm: Int16Array, rate: number, stretch: number) {
  const frame = Math.max(32, Math.floor(rate / 50)) & ~1;
  const hop = frame / 2;
  const tolerance = Math.max(1, Math.floor(rate / 200));
  const length = pcm.length;
  const count = Math.round(length * stretch);
  const last = length - frame;
  if (last < 2 * tolerance || count < frame) return pcm;
  const at = (i: number) => (i >= 0 && i < length ? pcm[i] : 0);
  const window = new Float64Array(frame);
  for (let i = 0; i < frame; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
  const near = new Float64Array(Math.floor((frame + 3) / 4));
  const span = new Float64Array(2 * tolerance + frame);
  const sum = new Float64Array(count + 2 * frame);
  const weight = new Float64Array(count + 2 * frame);
  let previous = -1;
  for (let placed = 0; placed * hop < count; placed++) {
    const nominal = Math.min(last, Math.round((placed * hop) / stretch));
    let best = nominal;
    if (previous >= 0) {
      const natural = Math.min(last, previous + hop);
      let closest = -Infinity;
      for (let j = 0, k = 0; j < frame; j += 4, k++) near[k] = at(natural + j);
      for (let k = 0; k < span.length; k++) span[k] = at(nominal - tolerance + k);
      for (let shift = -tolerance; shift <= tolerance; shift++) {
        const candidate = nominal + shift;
        if (candidate < 0 || candidate > last) continue;
        let dot = 0;
        let energy = 1;
        for (let j = 0, k = 0, from = shift + tolerance; j < frame; j += 4, k++) {
          const ahead = span[from + j];
          dot += near[k] * ahead;
          energy += ahead * ahead;
        }
        const score = dot / Math.sqrt(energy);
        if (score > closest) {
          closest = score;
          best = candidate;
        }
      }
    }
    const to = placed * hop;
    for (let j = 0; j < frame; j++) {
      sum[to + j] += window[j] * at(best + j);
      weight[to + j] += window[j];
    }
    previous = best;
  }
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = weight[i] > 1e-3 ? clip(sum[i] / weight[i]) : 0;
  return out;
}

// Her glitch: short stutters, crushed bits and skips, landing on sounds rather than silences, more as the slider goes up.
export function glitched(pcm: Int16Array, rate: number, amount: number, seed: number) {
  const block = Math.max(1, Math.floor(rate / 100));
  const fade = Math.max(1, Math.floor(rate / 400));
  const length = pcm.length;
  const blocks = Math.floor(length / block);
  if (blocks < 20) return pcm;
  const random = randomFrom(seed);
  const perSecond = amount * (2 + amount); // about one every 10 s at 5%, three a second at 100%
  const sampleAt = (i: number) => (i >= 0 && i < length ? pcm[i] : 0);
  const levels = new Float64Array(blocks);
  const peaks = new Float64Array(blocks);
  for (let b = 0, loudest = 0; b < blocks; b++) {
    let power = 0;
    for (let i = b * block; i < (b + 1) * block; i++) power += pcm[i] * pcm[i];
    levels[b] = Math.sqrt(power / block);
    loudest = Math.max(loudest, levels[b]);
    peaks[b] = loudest;
  }
  const output: number[] = [];
  let at = 0;
  let next = Math.floor(rate * (0.1 + random() / perSecond));
  const end = length - Math.floor(rate / 10);
  const copy = (upTo: number) => {
    for (let i = at; i < upTo; i++) output.push(sampleAt(i));
    at = Math.max(at, upTo);
  };
  while (next < end) {
    const from = Math.floor(next / block);
    const to = Math.min(blocks, from + 12);
    let found = -1;
    if (to > from) {
      const floor = 0.15 * peaks[to - 1]; // loud means above 15% of the loudest block so far
      for (let b = from; b < to; b++) {
        if (levels[b] > floor) {
          found = b;
          break;
        }
      }
    }
    if (found < 0) {
      next += block * 12;
      continue;
    }
    const start = Math.max(at, found * block);
    if (start >= end) break;
    copy(start);
    const roll = random();
    if (roll < 0.55) {
      // A stutter: a 30 to 50 ms grain, up to 90 ms as the slider goes up, plays two to four times.
      const grain = Math.floor(rate * (0.03 + (0.02 + 0.04 * amount) * random()));
      const repeats = 1 + (random() < amount ? 1 : 0) + (random() < amount / 2 ? 1 : 0);
      for (let r = 0; r < repeats; r++) {
        for (let i = 0; i < grain; i++) output.push(Math.trunc(sampleAt(start + i) * Math.min(1, Math.min(r === 0 ? fade : i, grain - 1 - i) / fade)));
      }
      for (let i = 0; i < fade; i++) output.push(Math.trunc((sampleAt(start + i) * i) / fade));
      at = start + fade;
    } else if (roll < 0.85) {
      // Crushed: 40 to 80 ms, up to 160 ms as the slider goes up, held down to fewer, coarser samples.
      const span = Math.min(length - start, Math.floor(rate * (0.04 + (0.04 + 0.08 * amount) * random())));
      const hold = 3 + Math.floor(random() * (3 + 9 * amount));
      const coarse = 1 << (8 + Math.round(4 * amount));
      let kept = 0;
      for (let i = 0; i < span; i++) {
        if (i % hold === 0) kept = Math.trunc(sampleAt(start + i) / coarse) * coarse;
        const mix = Math.min(1, Math.min(i, span - 1 - i) / fade);
        output.push(Math.trunc(sampleAt(start + i) * (1 - mix) + kept * mix));
      }
      at = start + span;
    } else {
      // A skip: 20 to 30 ms, up to 50 ms as the slider goes up, drops out like a scratched disc.
      const gap = Math.floor(rate * (0.02 + (0.01 + 0.02 * amount) * random()));
      for (let i = 0; i < fade; i++) output.push(Math.trunc(sampleAt(start + i) * (1 - i / fade) + (sampleAt(start + gap + i) * i) / fade));
      at = start + gap + fade;
    }
    next = at + Math.floor((rate * (0.6 + 0.8 * random())) / perSecond);
  }
  copy(length);
  return Int16Array.from(output);
}

// Her robot voice, like a talk box: a sawtooth that follows her pitch, pulled toward the nearest note, takes on the shape
// of her voice and plays under her. Nothing is cut, repeated or crushed.
export function vocoded(pcm: Int16Array, rate: number, amount: number, seed: number) {
  const size = rate >= 32000 ? 2048 : rate >= 20000 ? 1024 : 512; // about 43 ms frames
  const half = size / 2;
  const hop = size / 4; // a quarter frame apart
  const lifter = Math.max(8, Math.round(rate * 0.002));
  const reach = Math.max(1, Math.round((150 * size) / rate));
  const least = Math.max(2, Math.floor(rate / 900));
  const most = Math.min(half - 1, Math.floor(rate / 60));
  const dry = Math.cos((amount * Math.PI) / 2); // equal power: 100% is all robot
  const wet = Math.sin((amount * Math.PI) / 2);
  const snap = Math.min(1, 0.5 + 0.5 * amount); // a light robot leans halfway to the nearest note; a strong one sings on it
  const glideStep = 1 - Math.exp(-1 / (0.015 * rate));
  const voiceStep = 1 - Math.exp(-1 / (0.01 * rate));
  const lead = Math.round(0.015 * rate);

  const window = new Float64Array(size);
  const tilt = new Float64Array(half + 1);
  const cosines = new Float64Array(half);
  const sines = new Float64Array(half);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  // A sawtooth's harmonics fall off; this evens them out, then softens everything above 5 kHz.
  for (let k = 0; k <= half; k++) {
    const hertz = (k * rate) / size;
    tilt[k] = k / Math.sqrt(1 + (hertz * hertz) / (5000 * 5000));
  }
  for (let k = 0; k < half; k++) {
    cosines[k] = Math.cos((2 * Math.PI * k) / size);
    sines[k] = Math.sin((2 * Math.PI * k) / size);
  }

  const transform = (real: Float64Array, imaginary: Float64Array, inverse: boolean) => {
    const n = size;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let swap = real[i];
        real[i] = real[j];
        real[j] = swap;
        swap = imaginary[i];
        imaginary[i] = imaginary[j];
        imaginary[j] = swap;
      }
    }
    for (let length = 2; length <= n; length <<= 1) {
      const h = length >> 1;
      const stride = n / length;
      for (let i = 0; i < n; i += length) {
        for (let k = 0; k < h; k++) {
          const c = cosines[k * stride];
          const s = inverse ? sines[k * stride] : -sines[k * stride];
          const a = i + k;
          const b = a + h;
          const tr = real[b] * c - imaginary[b] * s;
          const ti = real[b] * s + imaginary[b] * c;
          real[b] = real[a] - tr;
          imaginary[b] = imaginary[a] - ti;
          real[a] += tr;
          imaginary[a] += ti;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        real[i] /= n;
        imaginary[i] /= n;
      }
    }
  };

  const input = (i: number) => (i >= 0 && i < pcm.length ? pcm[i] : 0);
  const floorDiv = (value: number, by: number) => Math.floor(value / by);
  const noteFor = (sample: number) => floorDiv(sample + lead + hop / 2, hop);

  const first = -hop - half; // the first frame is centred one hop before the line, so every sample gets four frames
  const lastFrame = floorDiv(pcm.length - 1 + half, hop);
  const carrierEnd = lastFrame * hop + half;
  const targetEnd = noteFor(carrierEnd - 1) + 1;
  const analysisEnd = targetEnd + 2;

  // Her pitch in each frame, by YIN: the lag where the sound best repeats itself. 0 when it doesn't, or it's too quiet.
  const pitches = new Float64Array(analysisEnd);
  const clarities = new Float64Array(analysisEnd);
  const frame = new Float64Array(size);
  const smooth = new Float64Array(size);
  const difference = new Float64Array(most + 2);
  let loudest = 0;
  for (let u = 0; u < analysisEnd; u++) {
    const start = u * hop - half;
    for (let i = 0; i < size; i++) frame[i] = input(start + i);
    let energy = 0;
    for (let i = 0; i < size; i++) {
      const here = frame[i];
      smooth[i] = 0.5 * here + 0.25 * (i > 0 ? frame[i - 1] : here) + 0.25 * (i + 1 < size ? frame[i + 1] : here);
      if (i >= size / 4 && i < (size * 3) / 4) energy += here * here;
    }
    const level = Math.sqrt(energy / half);
    loudest = Math.max(loudest, level);
    if (level <= 20 || level <= 0.03 * loudest) continue;
    let running = 0;
    difference[0] = 1;
    for (let lag = 1; lag <= most + 1; lag++) {
      const from = Math.floor((size - half - lag) / 2); // measured around the frame's middle
      let total = 0;
      for (let i = from; i < from + half; i++) {
        const delta = smooth[i] - smooth[i + lag];
        total += delta * delta;
      }
      running += total;
      difference[lag] = running > 0 ? (total * lag) / running : 1;
    }
    let best = -1;
    for (let lag = least; lag <= most && best < 0; lag++) {
      if (difference[lag] < 0.15) {
        while (lag < most && difference[lag + 1] < difference[lag]) lag++;
        best = lag;
      }
    }
    if (best < 0) {
      best = least;
      for (let lag = least + 1; lag <= most; lag++) if (difference[lag] < difference[best]) best = lag;
    }
    const dip = difference[best];
    if (dip < 0.35) {
      const before = difference[best - 1];
      const after = difference[best + 1];
      const bend = before - 2 * dip + after;
      const shift = bend > 1e-12 ? (0.5 * (before - after)) / bend : 0;
      pitches[u] = rate / (best + Math.max(-1, Math.min(1, shift)));
      clarities[u] = Math.max(0, Math.min(1, (0.35 - dip) / 0.2));
    }
  }

  // The note she sings in each frame: the middle of the voiced frames around it, so one that slips an octave changes
  // nothing, then pulled toward the nearest semitone, which only changes once she's well past the halfway point.
  const targets = new Float64Array(targetEnd).fill(NaN);
  const voicings = new Float64Array(targetEnd);
  let note = NaN;
  for (let u = 0; u < targetEnd; u++) {
    let pitch = pitches[u];
    if (pitch <= 0) continue;
    const around: number[] = [];
    for (let v = u - 2; v <= u + 2; v++) if (v >= 0 && v < analysisEnd && pitches[v] > 0) around.push(pitches[v]);
    if (around.length >= 3) pitch = around.sort((a, b) => a - b)[around.length >> 1];
    const semitone = 69 + (12 * Math.log(pitch / 440)) / Math.LN2;
    if (Number.isNaN(note) || Math.abs(semitone - note) > 0.65) note = Math.round(semitone);
    targets[u] = semitone + snap * (note - semitone);
    voicings[u] = clarities[u];
  }

  // The synth: a band-limited sawtooth that glides to each new note over about 15 ms.
  const carrier = new Float64Array(carrierEnd - first);
  const centres: number[] = [];
  let glide = 0;
  let voiced = 0;
  let phase = 0;
  let sung = false;
  for (let j = first; j < carrierEnd; j++) {
    const u = noteFor(j);
    const known = u >= 0 && u < targetEnd;
    const target = known ? targets[u] : NaN;
    if (!Number.isNaN(target)) {
      if (!sung) {
        glide = target;
        sung = true;
      }
      glide += (target - glide) * glideStep;
    }
    voiced += ((known ? voicings[u] : 0) - voiced) * voiceStep;
    const step = Math.min(0.45, (sung ? 440 * 2 ** ((glide - 69) / 12) : 220) / rate);
    phase += step;
    if (phase >= 1) phase -= 1;
    let edge = 0;
    if (phase < step) {
      const t = phase / step;
      edge = t + t - t * t - 1;
    } else if (phase > 1 - step) {
      const t = (phase - 1) / step;
      edge = t * t + t + t + 1;
    }
    carrier[j - first] = 2 * phase - 1 - edge;
    if (j % hop === 0) centres.push(voiced);
  }

  // Each frame of the robot: the synth takes her voice's smoothed spectrum and loudness. Where she isn't voiced,
  // noise with her shape stands in, so her s and t sounds come through too.
  const sum = new Float64Array(carrierEnd - first);
  const weight = new Float64Array(carrierEnd - first);
  const voiceRe = new Float64Array(size);
  const voiceIm = new Float64Array(size);
  const shapeRe = new Float64Array(size);
  const shapeIm = new Float64Array(size);
  const envelope = new Float64Array(half + 1);
  const synthRe = new Float64Array(size);
  const synthIm = new Float64Array(size);
  for (let t = -1; t <= lastFrame; t++) {
    const start = t * hop - half;
    for (let i = 0; i < size; i++) {
      voiceRe[i] = input(start + i) * window[i];
      voiceIm[i] = 0;
    }
    transform(voiceRe, voiceIm, false);
    let energy = 0;
    for (let k = 0; k <= half; k++) {
      envelope[k] = voiceRe[k] * voiceRe[k] + voiceIm[k] * voiceIm[k];
      energy += k === 0 || k === half ? envelope[k] : 2 * envelope[k];
    }
    // Her power averaged over about 300 Hz around each point, so the shape rides on her harmonics.
    for (let k = 0; k <= half; k++) {
      const low = Math.max(0, k - reach);
      const high = Math.min(half, k + reach);
      let total = 0;
      for (let b = low; b <= high; b++) total += envelope[b];
      shapeRe[k] = 0.5 * Math.log(total / (high - low + 1) + 1e-2);
      shapeIm[k] = 0;
    }
    for (let k = half + 1; k < size; k++) {
      shapeRe[k] = shapeRe[size - k];
      shapeIm[k] = 0;
    }
    transform(shapeRe, shapeIm, true);
    for (let q = 0; q < size; q++) {
      const from = Math.min(q, size - q);
      shapeRe[q] *= from <= lifter ? 0.5 + 0.5 * Math.cos((Math.PI * from) / (lifter + 1)) : 0;
      shapeIm[q] = 0;
    }
    transform(shapeRe, shapeIm, false);
    const offset = start - first;
    for (let i = 0; i < size; i++) {
      synthRe[i] = carrier[offset + i] * window[i];
      synthIm[i] = 0;
    }
    transform(synthRe, synthIm, false);
    let sawEnergy = 0;
    let noiseEnergy = 0;
    for (let k = 1; k < half; k++) {
      envelope[k] = Math.exp(shapeRe[k]);
      const gain = envelope[k] * tilt[k];
      synthRe[k] *= gain;
      synthIm[k] *= gain;
      sawEnergy += 2 * (synthRe[k] * synthRe[k] + synthIm[k] * synthIm[k]);
      noiseEnergy += 2 * envelope[k] * envelope[k];
    }
    const voice = centres[t + 3]; // centres start at frame -3
    const sawGain = sawEnergy > 1e-9 ? Math.sin((voice * Math.PI) / 2) * Math.sqrt(energy / sawEnergy) : 0;
    const noiseGain = noiseEnergy > 1e-9 ? Math.cos((voice * Math.PI) / 2) * Math.sqrt(energy / noiseEnergy) : 0;
    const noise = randomFrom(seed + Math.imul(t, 7919));
    voiceRe[0] = voiceIm[0] = voiceRe[half] = voiceIm[half] = 0;
    for (let k = 1; k < half; k++) {
      const angle = 2 * Math.PI * noise();
      const hiss = envelope[k] * noiseGain;
      voiceRe[k] = sawGain * synthRe[k] + hiss * Math.cos(angle);
      voiceIm[k] = sawGain * synthIm[k] + hiss * Math.sin(angle);
      voiceRe[size - k] = voiceRe[k];
      voiceIm[size - k] = -voiceIm[k];
    }
    transform(voiceRe, voiceIm, true);
    for (let i = 0; i < size; i++) {
      sum[offset + i] += voiceRe[i] * window[i];
      weight[offset + i] += window[i] * window[i];
    }
  }

  const out = new Int16Array(pcm.length);
  for (let j = 0; j < pcm.length; j++) {
    const slot = j - first;
    const robot = weight[slot] > 1e-9 ? sum[slot] / weight[slot] : 0;
    out[j] = soft(pcm[j] * dry + robot * wet);
  }
  return out;
}

// Keeps her layered voice under full scale. A sample's gain is the least any sample up to 2.5 ms ahead needs, eased in over
// those 2.5 ms and let back up over about 60 ms. Below full scale every sample goes through as it is.
function limited(mix: Float64Array, rate: number) {
  const ahead = Math.max(1, Math.floor(rate / 400));
  const letUp = Math.exp(-1 / (0.06 * rate));
  const recent = new Float64Array(ahead + 1).fill(1);
  // Silence on both sides, so the first peak is eased into and the last one eases out.
  const total = mix.length + 2 * ahead;
  const value = (i: number) => (i >= ahead && i < ahead + mix.length ? mix[i - ahead] : 0);
  const lows = new Float64Array(total);
  const lowAt = new Int32Array(total);
  let head = 0;
  let tail = 0;
  let gain = 1;
  let under = 0;
  const out = new Int16Array(mix.length);
  for (let taken = 0; taken < total; taken++) {
    const size = Math.abs(value(taken));
    const need = size > LIMITER_CEILING ? LIMITER_CEILING / size : 1;
    while (tail > head && lows[tail - 1] >= need) tail--;
    lows[tail] = need;
    lowAt[tail++] = taken;
    const at = taken - ahead;
    if (at < 0) continue;
    while (lowAt[head] < at) head++;
    gain = Math.min(lows[head], 1 - (1 - gain) * letUp);
    if (gain > 0.99999 && lows[head] >= 1) gain = 1;
    const slot = at % recent.length;
    if (recent[slot] < 1) under--;
    recent[slot] = gain;
    if (gain < 1) under++;
    let eased = 1;
    if (under > 0) {
      eased = 0;
      for (let k = 0; k < recent.length; k++) eased += recent[k];
      eased /= recent.length;
    }
    if (at >= ahead && at < ahead + mix.length) out[at - ahead] = clip(value(at) * eased);
  }
  return out;
}

// Her two layers under her: copies of her finished voice, pitched without changing length, delayed and mixed in under her.
export function layered(pcm: Int16Array, rate: number, layers: VoiceStyle["layers"]) {
  const copies = ([[layers.pitch1, layers.delay1], [layers.pitch2, layers.delay2]] as const).map(([semitones, ms]) => {
    const lift = 2 ** (semitones / 12);
    return {
      delay: Math.round((ms * rate) / 1000),
      made: semitones === 0 ? pcm : resample(timeStretch(pcm, rate, lift), lift),
    };
  });
  const mix = new Float64Array(pcm.length + Math.max(copies[0].delay, copies[1].delay));
  for (let i = 0; i < mix.length; i++) {
    let value = i < pcm.length ? pcm[i] : 0;
    for (const { delay, made } of copies) {
      const j = i - delay;
      if (j >= 0 && j < made.length) value += LAYER_LEVEL * made[j];
    }
    mix[i] = value;
  }
  return limited(mix, rate);
}

// True when no effect is on, so the line can skip all of this.
export const isPlain = (s: VoiceStyle) => s.pitch === 0 && s.speed === 100 && s.robot <= 0 && s.glitch <= 0 && !s.layers.on;

// A finished line in her pitch, speed, robot, glitch and layers, in the app's order. Her layers go on last.
export function styled(pcm: Int16Array, rate: number, s: VoiceStyle, seed: number) {
  if (isPlain(s)) return pcm;
  let line = pcm;
  const lift = 2 ** (s.pitch / 12);
  const stretch = (lift * 100) / Math.max(1, s.speed);
  if (Math.abs(stretch - 1) > 0.001) line = timeStretch(line, rate, stretch);
  if (s.pitch !== 0) line = resample(line, lift);
  if (s.robot > 0) line = vocoded(line, rate, s.robot / 100, seed);
  if (s.glitch > 0) line = glitched(line, rate, s.glitch / 100, seed);
  if (s.layers.on) line = layered(line, rate, s.layers);
  return line;
}
