//! Capri's voice effects, ported line for line from `lib/voicefx.ts` (itself a port of VoiceFx in capri-desktop).
//! Same maths, same order of operations, so a line sounds the same here as in the TypeScript version.
//! The one deliberate difference is `jsround`: JS `Math.round` rounds halves up, Rust's `round` rounds them away from zero.
//!
//! Samples are 16-bit; every stage takes and returns `i16`, as the TypeScript does with `Int16Array`.

use std::f64::consts::PI;

const LAYER_LEVEL: f64 = 0.4; // 8 dB under her
const LIMITER_CEILING: f64 = 31000.0;

#[derive(Clone, Copy, Debug)]
pub struct Layers {
    pub on: bool,
    pub pitch1: f64,
    pub delay1: f64,
    pub pitch2: f64,
    pub delay2: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Style {
    pub pitch: f64, // semitones
    pub speed: f64, // percent
    pub robot: f64, // percent
    pub glitch: f64, // percent
    pub layers: Layers,
}

/// JS `Math.round`.
fn jsround(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Rounds to a 16-bit sample, clamped to its range (NaN becomes 0, as in an `Int16Array`).
fn clip(value: f64) -> i16 {
    jsround(value).clamp(-32768.0, 32767.0) as i16
}

/// Leaves samples alone up to 28000, then bends them toward full scale instead of clipping.
fn soft(value: f64) -> i16 {
    let size = value.abs();
    clip(if size > 28000.0 { value.signum() * (28000.0 + 4767.0 * ((size - 28000.0) / 4767.0).tanh()) } else { value })
}

struct Random(i32);

impl Random {
    fn new(seed: i32) -> Self {
        Random(seed)
    }
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let s = self.0;
        let mut t = (s ^ ((s as u32) >> 15) as i32).wrapping_mul(1 | s);
        t = t.wrapping_add((t ^ ((t as u32) >> 7) as i32).wrapping_mul(61 | t)) ^ t;
        ((t ^ ((t as u32) >> 14) as i32) as u32) as f64 / 4294967296.0
    }
}

pub fn seed_of(text: &str) -> i32 {
    let mut hash: i32 = 2166136261u32 as i32;
    for unit in text.encode_utf16() {
        hash = (hash ^ unit as i32).wrapping_mul(16777619);
    }
    hash & 0x7fffffff
}

/// Plays the sound `factor` times faster: higher and shorter by that ratio. A windowed sinc, so a higher voice doesn't alias.
pub fn resample(pcm: &[i16], factor: f64) -> Vec<i16> {
    let phases = 256usize;
    let cutoff = (1.0f64).min(1.0 / factor);
    let reach = (16.0 / cutoff).ceil() as i64;
    let taps = (2 * reach) as usize;
    let mut kernel = vec![0.0f64; (phases + 1) * taps];
    for phase in 0..=phases {
        let fraction = phase as f64 / phases as f64;
        let mut total = 0.0;
        for k in 0..taps {
            let x = k as f64 - reach as f64 + 1.0 - fraction;
            let t = x * cutoff;
            let sinc = if t.abs() < 1e-9 { 1.0 } else { (PI * t).sin() / (PI * t) };
            let weight = sinc * if x.abs() >= reach as f64 { 0.0 } else { 0.5 + 0.5 * (PI * x / reach as f64).cos() };
            kernel[phase * taps + k] = weight;
            total += weight;
        }
        for k in 0..taps {
            kernel[phase * taps + k] /= total;
        }
    }
    let len = jsround(pcm.len() as f64 / factor) as usize;
    let mut out = vec![0i16; len];
    let n = pcm.len() as i64;
    for (made, slot) in out.iter_mut().enumerate() {
        let center = made as f64 * factor;
        let whole = center.floor();
        let row = jsround((center - whole) * phases as f64) as usize * taps;
        let start = whole as i64 - reach + 1;
        let mut value = 0.0;
        // Only the taps that land on the line; the rest would multiply by zero.
        let from = (-start).max(0);
        let to = (taps as i64).min(n - start);
        for k in from..to {
            value += pcm[(start + k) as usize] as f64 * kernel[row + k as usize];
        }
        *slot = clip(value);
    }
    out
}

/// Makes the sound `stretch` times longer at the same pitch: 20 ms windows, each lined up with the one before it within 5 ms (WSOLA).
pub fn time_stretch(pcm: &[i16], rate: f64, stretch: f64) -> Vec<i16> {
    let frame = ((rate / 50.0).floor().max(32.0) as i64) & !1;
    let hop = frame / 2;
    let tolerance = (rate / 200.0).floor().max(1.0) as i64;
    let length = pcm.len() as i64;
    let count = jsround(length as f64 * stretch) as i64;
    let last = length - frame;
    if last < 2 * tolerance || count < frame {
        return pcm.to_vec();
    }
    let at = |i: i64| if i >= 0 && i < length { pcm[i as usize] as f64 } else { 0.0 };
    let window: Vec<f64> = (0..frame).map(|i| 0.5 - 0.5 * ((2.0 * PI * i as f64) / frame as f64).cos()).collect();
    let mut near = vec![0.0f64; ((frame + 3) / 4) as usize];
    let mut span = vec![0.0f64; (2 * tolerance + frame) as usize];
    let mut sum = vec![0.0f64; (count + 2 * frame) as usize];
    let mut weight = vec![0.0f64; (count + 2 * frame) as usize];
    let mut previous = -1i64;
    let mut placed = 0i64;
    while placed * hop < count {
        let nominal = last.min(jsround((placed * hop) as f64 / stretch) as i64);
        let mut best = nominal;
        if previous >= 0 {
            let natural = last.min(previous + hop);
            let mut closest = f64::NEG_INFINITY;
            for (k, j) in (0..frame).step_by(4).enumerate() {
                near[k] = at(natural + j);
            }
            for (k, slot) in span.iter_mut().enumerate() {
                *slot = at(nominal - tolerance + k as i64);
            }
            for shift in -tolerance..=tolerance {
                let candidate = nominal + shift;
                if candidate < 0 || candidate > last {
                    continue;
                }
                let mut dot = 0.0;
                let mut energy = 1.0;
                let from = (shift + tolerance) as usize;
                for (k, j) in (0..frame as usize).step_by(4).enumerate() {
                    let ahead = span[from + j];
                    dot += near[k] * ahead;
                    energy += ahead * ahead;
                }
                let score = dot / f64::sqrt(energy);
                if score > closest {
                    closest = score;
                    best = candidate;
                }
            }
        }
        let to = (placed * hop) as usize;
        for j in 0..frame as usize {
            sum[to + j] += window[j] * at(best + j as i64);
            weight[to + j] += window[j];
        }
        previous = best;
        placed += 1;
    }
    (0..count as usize).map(|i| if weight[i] > 1e-3 { clip(sum[i] / weight[i]) } else { 0 }).collect()
}

/// Her glitch: short stutters, crushed bits and skips, landing on sounds rather than silences, more as the slider goes up.
pub fn glitched(pcm: &[i16], rate: f64, amount: f64, seed: i32) -> Vec<i16> {
    let block = (rate / 100.0).floor().max(1.0) as i64;
    let fade = (rate / 400.0).floor().max(1.0) as i64;
    let length = pcm.len() as i64;
    let blocks = length / block;
    if blocks < 20 {
        return pcm.to_vec();
    }
    let mut random = Random::new(seed);
    let per_second = amount * (2.0 + amount);
    let sample = |i: i64| if i >= 0 && i < length { pcm[i as usize] as f64 } else { 0.0 };
    let mut levels = vec![0.0f64; blocks as usize];
    let mut peaks = vec![0.0f64; blocks as usize];
    let mut loudest = 0.0f64;
    for b in 0..blocks as usize {
        let mut power = 0.0;
        for i in b * block as usize..(b + 1) * block as usize {
            power += pcm[i] as f64 * pcm[i] as f64;
        }
        levels[b] = (power / block as f64).sqrt();
        loudest = loudest.max(levels[b]);
        peaks[b] = loudest;
    }
    let mut output: Vec<i16> = Vec::with_capacity(pcm.len() + pcm.len() / 4);
    let mut at = 0i64;
    let mut next = (rate * (0.1 + random.next() / per_second)).floor() as i64;
    let end = length - (rate / 10.0).floor() as i64;
    let copy = |output: &mut Vec<i16>, at: &mut i64, up_to: i64| {
        for i in *at..up_to {
            output.push(sample(i) as i16);
        }
        *at = (*at).max(up_to);
    };
    while next < end {
        let from = next / block;
        let to = blocks.min(from + 12);
        let mut found = -1i64;
        if to > from {
            let floor = 0.15 * peaks[(to - 1) as usize];
            for b in from..to {
                if levels[b as usize] > floor {
                    found = b;
                    break;
                }
            }
        }
        if found < 0 {
            next += block * 12;
            continue;
        }
        let start = at.max(found * block);
        if start >= end {
            break;
        }
        copy(&mut output, &mut at, start);
        let roll = random.next();
        if roll < 0.55 {
            // A stutter: a 30 to 50 ms grain, up to 90 ms as the slider goes up, plays two to four times.
            let grain = (rate * (0.03 + (0.02 + 0.04 * amount) * random.next())).floor() as i64;
            let repeats = 1 + i64::from(random.next() < amount) + i64::from(random.next() < amount / 2.0);
            for r in 0..repeats {
                for i in 0..grain {
                    let lead = if r == 0 { fade } else { i };
                    let ramp = (1.0f64).min(lead.min(grain - 1 - i) as f64 / fade as f64);
                    output.push((sample(start + i) * ramp).trunc() as i16);
                }
            }
            for i in 0..fade {
                output.push(((sample(start + i) * i as f64) / fade as f64).trunc() as i16);
            }
            at = start + fade;
        } else if roll < 0.85 {
            // Crushed: 40 to 80 ms, up to 160 ms as the slider goes up, held down to fewer, coarser samples.
            let span = (length - start).min((rate * (0.04 + (0.04 + 0.08 * amount) * random.next())).floor() as i64);
            let hold = 3 + (random.next() * (3.0 + 9.0 * amount)).floor() as i64;
            let coarse = (1i64 << (8 + jsround(4.0 * amount) as i64)) as f64;
            let mut kept = 0.0;
            for i in 0..span {
                if i % hold == 0 {
                    kept = (sample(start + i) / coarse).trunc() * coarse;
                }
                let mix = (1.0f64).min(i.min(span - 1 - i) as f64 / fade as f64);
                output.push((sample(start + i) * (1.0 - mix) + kept * mix).trunc() as i16);
            }
            at = start + span;
        } else {
            // A skip: 20 to 30 ms, up to 50 ms as the slider goes up, drops out like a scratched disc.
            let gap = (rate * (0.02 + (0.01 + 0.02 * amount) * random.next())).floor() as i64;
            for i in 0..fade {
                output.push((sample(start + i) * (1.0 - i as f64 / fade as f64) + (sample(start + gap + i) * i as f64) / fade as f64).trunc() as i16);
            }
            at = start + gap + fade;
        }
        next = at + ((rate * (0.6 + 0.8 * random.next())) / per_second).floor() as i64;
    }
    copy(&mut output, &mut at, length);
    output
}

struct Fft {
    n: usize,
    cosines: Vec<f64>,
    sines: Vec<f64>,
}

impl Fft {
    fn new(n: usize) -> Self {
        let half = n / 2;
        Fft {
            n,
            cosines: (0..half).map(|k| (2.0 * PI * k as f64 / n as f64).cos()).collect(),
            sines: (0..half).map(|k| (2.0 * PI * k as f64 / n as f64).sin()).collect(),
        }
    }

    fn transform(&self, real: &mut [f64], imaginary: &mut [f64], inverse: bool) {
        let n = self.n;
        let mut j = 0usize;
        for i in 1..n {
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
            if i < j {
                real.swap(i, j);
                imaginary.swap(i, j);
            }
        }
        let mut length = 2;
        while length <= n {
            let h = length >> 1;
            let stride = n / length;
            let mut i = 0;
            while i < n {
                for k in 0..h {
                    let c = self.cosines[k * stride];
                    let s = if inverse { self.sines[k * stride] } else { -self.sines[k * stride] };
                    let a = i + k;
                    let b = a + h;
                    let tr = real[b] * c - imaginary[b] * s;
                    let ti = real[b] * s + imaginary[b] * c;
                    real[b] = real[a] - tr;
                    imaginary[b] = imaginary[a] - ti;
                    real[a] += tr;
                    imaginary[a] += ti;
                }
                i += length;
            }
            length <<= 1;
        }
        if inverse {
            for i in 0..n {
                real[i] /= n as f64;
                imaginary[i] /= n as f64;
            }
        }
    }
}

/// Her robot voice, like a talk box: a sawtooth that follows her pitch, pulled toward the nearest note, takes on the shape
/// of her voice and plays under her. Nothing is cut, repeated or crushed.
pub fn vocoded(pcm: &[i16], rate: f64, amount: f64, seed: i32) -> Vec<i16> {
    let size: usize = if rate >= 32000.0 { 2048 } else if rate >= 20000.0 { 1024 } else { 512 };
    let half = size / 2;
    let hop = (size / 4) as i64;
    let (isize, ihalf) = (size as i64, half as i64);
    let lifter = (jsround(rate * 0.002) as i64).max(8);
    let reach = (jsround(150.0 * size as f64 / rate) as i64).max(1);
    let least = ((rate / 900.0).floor() as i64).max(2);
    let most = (ihalf - 1).min((rate / 60.0).floor() as i64);
    let dry = (amount * PI / 2.0).cos();
    let wet = (amount * PI / 2.0).sin();
    let snap = (1.0f64).min(0.5 + 0.5 * amount);
    let glide_step = 1.0 - (-1.0 / (0.015 * rate)).exp();
    let voice_step = 1.0 - (-1.0 / (0.01 * rate)).exp();
    let lead = jsround(0.015 * rate) as i64;

    let fft = Fft::new(size);
    let window: Vec<f64> = (0..size).map(|i| 0.5 - 0.5 * ((2.0 * PI * i as f64) / size as f64).cos()).collect();
    // A sawtooth's harmonics fall off; this evens them out, then softens everything above 5 kHz.
    let tilt: Vec<f64> = (0..=half)
        .map(|k| {
            let hertz = (k as f64 * rate) / size as f64;
            k as f64 / (1.0 + (hertz * hertz) / (5000.0 * 5000.0)).sqrt()
        })
        .collect();

    let len = pcm.len() as i64;
    let input = |i: i64| if i >= 0 && i < len { pcm[i as usize] as f64 } else { 0.0 };
    let note_for = |sample: i64| (sample + lead + hop / 2).div_euclid(hop);

    let first = -hop - ihalf;
    let last_frame = (len - 1 + ihalf).div_euclid(hop);
    let carrier_end = last_frame * hop + ihalf;
    let target_end = note_for(carrier_end - 1) + 1;
    let analysis_end = target_end + 2;

    // Her pitch in each frame, by YIN: the lag where the sound best repeats itself. 0 when it doesn't, or it's too quiet.
    let mut pitches = vec![0.0f64; analysis_end as usize];
    let mut clarities = vec![0.0f64; analysis_end as usize];
    let mut frame = vec![0.0f64; size];
    let mut smooth = vec![0.0f64; size];
    let mut difference = vec![0.0f64; (most + 2) as usize];
    let mut loudest = 0.0f64;
    for u in 0..analysis_end {
        let start = u * hop - ihalf;
        for i in 0..size {
            frame[i] = input(start + i as i64);
        }
        let mut energy = 0.0;
        for i in 0..size {
            let here = frame[i];
            smooth[i] = 0.5 * here + 0.25 * if i > 0 { frame[i - 1] } else { here } + 0.25 * if i + 1 < size { frame[i + 1] } else { here };
            if i >= size / 4 && i < (size * 3) / 4 {
                energy += here * here;
            }
        }
        let level = (energy / half as f64).sqrt();
        loudest = loudest.max(level);
        if level <= 20.0 || level <= 0.03 * loudest {
            continue;
        }
        let mut running = 0.0;
        difference[0] = 1.0;
        for lag in 1..=(most + 1) {
            let from = ((isize - ihalf - lag) / 2) as usize; // measured around the frame's middle
            let mut total = 0.0;
            for i in from..from + half {
                let delta = smooth[i] - smooth[i + lag as usize];
                total += delta * delta;
            }
            running += total;
            difference[lag as usize] = if running > 0.0 { (total * lag as f64) / running } else { 1.0 };
        }
        let mut best = -1i64;
        let mut lag = least;
        while lag <= most && best < 0 {
            if difference[lag as usize] < 0.15 {
                while lag < most && difference[(lag + 1) as usize] < difference[lag as usize] {
                    lag += 1;
                }
                best = lag;
            }
            lag += 1;
        }
        if best < 0 {
            best = least;
            for lag in least + 1..=most {
                if difference[lag as usize] < difference[best as usize] {
                    best = lag;
                }
            }
        }
        let dip = difference[best as usize];
        if dip < 0.35 {
            let before = difference[(best - 1) as usize];
            let after = difference[(best + 1) as usize];
            let bend = before - 2.0 * dip + after;
            let shift = if bend > 1e-12 { (0.5 * (before - after)) / bend } else { 0.0 };
            pitches[u as usize] = rate / (best as f64 + shift.min(1.0).max(-1.0));
            clarities[u as usize] = ((0.35 - dip) / 0.2).min(1.0).max(0.0);
        }
    }

    // The note she sings in each frame: the middle of the voiced frames around it, so one that slips an octave changes
    // nothing, then pulled toward the nearest semitone, which only changes once she's well past the halfway point.
    let mut targets = vec![f64::NAN; target_end as usize];
    let mut voicings = vec![0.0f64; target_end as usize];
    let mut note = f64::NAN;
    for u in 0..target_end {
        let mut pitch = pitches[u as usize];
        if pitch <= 0.0 {
            continue;
        }
        let mut around: Vec<f64> = Vec::with_capacity(5);
        for v in u - 2..=u + 2 {
            if v >= 0 && v < analysis_end && pitches[v as usize] > 0.0 {
                around.push(pitches[v as usize]);
            }
        }
        if around.len() >= 3 {
            around.sort_by(|a, b| a.partial_cmp(b).unwrap());
            pitch = around[around.len() >> 1];
        }
        let semitone = 69.0 + (12.0 * (pitch / 440.0).ln()) / std::f64::consts::LN_2;
        if note.is_nan() || (semitone - note).abs() > 0.65 {
            note = jsround(semitone);
        }
        targets[u as usize] = semitone + snap * (note - semitone);
        voicings[u as usize] = clarities[u as usize];
    }

    // The synth: a band-limited sawtooth that glides to each new note over about 15 ms.
    let mut carrier = vec![0.0f64; (carrier_end - first) as usize];
    let mut centres: Vec<f64> = Vec::new();
    let mut glide = 0.0f64;
    let mut voiced = 0.0f64;
    let mut phase = 0.0f64;
    let mut sung = false;
    for j in first..carrier_end {
        let u = note_for(j);
        let known = u >= 0 && u < target_end;
        let target = if known { targets[u as usize] } else { f64::NAN };
        if !target.is_nan() {
            if !sung {
                glide = target;
                sung = true;
            }
            glide += (target - glide) * glide_step;
        }
        voiced += ((if known { voicings[u as usize] } else { 0.0 }) - voiced) * voice_step;
        let step = (0.45f64).min((if sung { 440.0 * (2.0f64).powf((glide - 69.0) / 12.0) } else { 220.0 }) / rate);
        phase += step;
        if phase >= 1.0 {
            phase -= 1.0;
        }
        let mut edge = 0.0;
        if phase < step {
            let t = phase / step;
            edge = t + t - t * t - 1.0;
        } else if phase > 1.0 - step {
            let t = (phase - 1.0) / step;
            edge = t * t + t + t + 1.0;
        }
        carrier[(j - first) as usize] = 2.0 * phase - 1.0 - edge;
        if j % hop == 0 {
            centres.push(voiced);
        }
    }

    // Each frame of the robot: the synth takes her voice's smoothed spectrum and loudness. Where she isn't voiced,
    // noise with her shape stands in, so her s and t sounds come through too.
    let total_len = (carrier_end - first) as usize;
    let mut sum = vec![0.0f64; total_len];
    let mut weight = vec![0.0f64; total_len];
    let mut voice_re = vec![0.0f64; size];
    let mut voice_im = vec![0.0f64; size];
    let mut shape_re = vec![0.0f64; size];
    let mut shape_im = vec![0.0f64; size];
    let mut envelope = vec![0.0f64; half + 1];
    let mut synth_re = vec![0.0f64; size];
    let mut synth_im = vec![0.0f64; size];
    for t in -1..=last_frame {
        let start = t * hop - ihalf;
        for i in 0..size {
            voice_re[i] = input(start + i as i64) * window[i];
            voice_im[i] = 0.0;
        }
        fft.transform(&mut voice_re, &mut voice_im, false);
        let mut energy = 0.0;
        for k in 0..=half {
            envelope[k] = voice_re[k] * voice_re[k] + voice_im[k] * voice_im[k];
            energy += if k == 0 || k == half { envelope[k] } else { 2.0 * envelope[k] };
        }
        // Her power averaged over about 300 Hz around each point, so the shape rides on her harmonics.
        for k in 0..=half {
            let low = (k as i64 - reach).max(0) as usize;
            let high = (k as i64 + reach).min(ihalf) as usize;
            let mut total = 0.0;
            for b in low..=high {
                total += envelope[b];
            }
            shape_re[k] = 0.5 * (total / (high - low + 1) as f64 + 1e-2).ln();
            shape_im[k] = 0.0;
        }
        for k in half + 1..size {
            shape_re[k] = shape_re[size - k];
            shape_im[k] = 0.0;
        }
        fft.transform(&mut shape_re, &mut shape_im, true);
        for q in 0..size {
            let from = q.min(size - q) as i64;
            shape_re[q] *= if from <= lifter { 0.5 + 0.5 * (PI * from as f64 / (lifter + 1) as f64).cos() } else { 0.0 };
            shape_im[q] = 0.0;
        }
        fft.transform(&mut shape_re, &mut shape_im, false);
        let offset = (start - first) as usize;
        for i in 0..size {
            synth_re[i] = carrier[offset + i] * window[i];
            synth_im[i] = 0.0;
        }
        fft.transform(&mut synth_re, &mut synth_im, false);
        let mut saw_energy = 0.0;
        let mut noise_energy = 0.0;
        for k in 1..half {
            envelope[k] = shape_re[k].exp();
            let gain = envelope[k] * tilt[k];
            synth_re[k] *= gain;
            synth_im[k] *= gain;
            saw_energy += 2.0 * (synth_re[k] * synth_re[k] + synth_im[k] * synth_im[k]);
            noise_energy += 2.0 * envelope[k] * envelope[k];
        }
        let voice = centres[(t + 3) as usize]; // centres start at frame -3
        let saw_gain = if saw_energy > 1e-9 { (voice * PI / 2.0).sin() * (energy / saw_energy).sqrt() } else { 0.0 };
        let noise_gain = if noise_energy > 1e-9 { (voice * PI / 2.0).cos() * (energy / noise_energy).sqrt() } else { 0.0 };
        let mut noise = Random::new(seed.wrapping_add((t as i32).wrapping_mul(7919)));
        voice_re[0] = 0.0;
        voice_im[0] = 0.0;
        voice_re[half] = 0.0;
        voice_im[half] = 0.0;
        for k in 1..half {
            let angle = 2.0 * PI * noise.next();
            let hiss = envelope[k] * noise_gain;
            voice_re[k] = saw_gain * synth_re[k] + hiss * angle.cos();
            voice_im[k] = saw_gain * synth_im[k] + hiss * angle.sin();
            voice_re[size - k] = voice_re[k];
            voice_im[size - k] = -voice_im[k];
        }
        fft.transform(&mut voice_re, &mut voice_im, true);
        for i in 0..size {
            sum[offset + i] += voice_re[i] * window[i];
            weight[offset + i] += window[i] * window[i];
        }
    }

    (0..pcm.len())
        .map(|j| {
            let slot = (j as i64 - first) as usize;
            let robot = if weight[slot] > 1e-9 { sum[slot] / weight[slot] } else { 0.0 };
            soft(pcm[j] as f64 * dry + robot * wet)
        })
        .collect()
}

/// Keeps her layered voice under full scale. A sample's gain is the least any sample up to 2.5 ms ahead needs, eased in over
/// those 2.5 ms and let back up over about 60 ms. Below full scale every sample goes through as it is.
fn limited(mix: &[f64], rate: f64) -> Vec<i16> {
    let ahead = ((rate / 400.0).floor() as usize).max(1);
    let let_up = (-1.0 / (0.06 * rate)).exp();
    let mut recent = vec![1.0f64; ahead + 1];
    // Silence on both sides, so the first peak is eased into and the last one eases out.
    let total = mix.len() + 2 * ahead;
    let value = |i: usize| if i >= ahead && i < ahead + mix.len() { mix[i - ahead] } else { 0.0 };
    let mut lows = vec![0.0f64; total];
    let mut low_at = vec![0usize; total];
    let (mut head, mut tail) = (0usize, 0usize);
    let mut gain = 1.0f64;
    let mut under = 0i64;
    let mut out = vec![0i16; mix.len()];
    for taken in 0..total {
        let size = value(taken).abs();
        let need = if size > LIMITER_CEILING { LIMITER_CEILING / size } else { 1.0 };
        while tail > head && lows[tail - 1] >= need {
            tail -= 1;
        }
        lows[tail] = need;
        low_at[tail] = taken;
        tail += 1;
        if taken < ahead {
            continue;
        }
        let at = taken - ahead;
        while low_at[head] < at {
            head += 1;
        }
        gain = lows[head].min(1.0 - (1.0 - gain) * let_up);
        if gain > 0.99999 && lows[head] >= 1.0 {
            gain = 1.0;
        }
        let slot = at % recent.len();
        if recent[slot] < 1.0 {
            under -= 1;
        }
        recent[slot] = gain;
        if gain < 1.0 {
            under += 1;
        }
        let mut eased = 1.0;
        if under > 0 {
            eased = recent.iter().sum::<f64>() / recent.len() as f64;
        }
        if at >= ahead && at < ahead + mix.len() {
            out[at - ahead] = clip(value(at) * eased);
        }
    }
    out
}

/// Her two layers under her: copies of her finished voice, pitched without changing length, delayed and mixed in under her.
pub fn layered(pcm: &[i16], rate: f64, layers: &Layers) -> Vec<i16> {
    let copies: Vec<(usize, Vec<i16>)> = [(layers.pitch1, layers.delay1), (layers.pitch2, layers.delay2)]
        .iter()
        .map(|&(semitones, ms)| {
            let lift = (2.0f64).powf(semitones / 12.0);
            (jsround((ms * rate) / 1000.0) as usize, if semitones == 0.0 { pcm.to_vec() } else { resample(&time_stretch(pcm, rate, lift), lift) })
        })
        .collect();
    let mut mix = vec![0.0f64; pcm.len() + copies[0].0.max(copies[1].0)];
    for (i, slot) in mix.iter_mut().enumerate() {
        let mut value = if i < pcm.len() { pcm[i] as f64 } else { 0.0 };
        for (delay, made) in &copies {
            if i >= *delay && i - delay < made.len() {
                value += LAYER_LEVEL * made[i - delay] as f64;
            }
        }
        *slot = value;
    }
    limited(&mix, rate)
}

/// True when no effect is on, so the line can skip all of this.
pub fn is_plain(s: &Style) -> bool {
    s.pitch == 0.0 && s.speed == 100.0 && s.robot <= 0.0 && s.glitch <= 0.0 && !s.layers.on
}

/// A finished line in her pitch, speed, robot, glitch and layers, in the app's order. Her layers go on last.
pub fn styled(pcm: &[i16], rate: f64, s: &Style, seed: i32) -> Vec<i16> {
    if is_plain(s) {
        return pcm.to_vec();
    }
    let mut line = pcm.to_vec();
    let lift = (2.0f64).powf(s.pitch / 12.0);
    let stretch = (lift * 100.0) / s.speed.max(1.0);
    if (stretch - 1.0).abs() > 0.001 {
        line = time_stretch(&line, rate, stretch);
    }
    if s.pitch != 0.0 {
        line = resample(&line, lift);
    }
    if s.robot > 0.0 {
        line = vocoded(&line, rate, s.robot / 100.0, seed);
    }
    if s.glitch > 0.0 {
        line = glitched(&line, rate, s.glitch / 100.0, seed);
    }
    if s.layers.on {
        line = layered(&line, rate, &s.layers);
    }
    line
}

// ---- The door the browser uses (no wasm-bindgen: a handful of plain exports, nothing to generate) ----
//
// The worker copies the samples into memory from `alloc`, calls `styled_into`, which returns the length of the result and
// keeps it for `out_ptr`, copies it out, then gives everything back with `dealloc`.

#[cfg(target_arch = "wasm32")]
mod door {
    use super::*;
    use std::cell::RefCell;

    thread_local! { static OUT: RefCell<Vec<i16>> = const { RefCell::new(Vec::new()) }; }

    #[no_mangle]
    pub extern "C" fn alloc(samples: usize) -> *mut i16 {
        let mut v = Vec::<i16>::with_capacity(samples);
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    /// # Safety
    /// `ptr` and `samples` must come from one `alloc` call.
    #[no_mangle]
    pub unsafe extern "C" fn dealloc(ptr: *mut i16, samples: usize) {
        drop(Vec::from_raw_parts(ptr, 0, samples));
    }

    /// # Safety
    /// `ptr` must point to `len` samples written by the caller.
    #[no_mangle]
    #[allow(clippy::too_many_arguments)]
    pub unsafe extern "C" fn styled_into(ptr: *const i16, len: usize, rate: f64, pitch: f64, speed: f64, robot: f64, glitch: f64, layers_on: i32, pitch1: f64, delay1: f64, pitch2: f64, delay2: f64, seed: i32) -> usize {
        let pcm = std::slice::from_raw_parts(ptr, len);
        let style = Style { pitch, speed, robot, glitch, layers: Layers { on: layers_on != 0, pitch1, delay1, pitch2, delay2 } };
        let out = styled(pcm, rate, &style, seed);
        let n = out.len();
        OUT.with(|o| *o.borrow_mut() = out);
        n
    }

    #[no_mangle]
    pub extern "C" fn out_ptr() -> *const i16 {
        OUT.with(|o| o.borrow().as_ptr())
    }
}
