//! The same behaviours lib/voicefx.test.ts checks, run on the Rust code directly.
use std::f64::consts::PI;
use voicefx::*;

const RATE: f64 = 24000.0;
const OFF: Layers = Layers { on: false, pitch1: 2.0, delay1: 25.0, pitch2: -2.5, delay2: 25.0 };
const PLAIN: Style = Style { pitch: 0.0, speed: 100.0, robot: 0.0, glitch: 0.0, layers: OFF };

fn tone(hertz: f64, size: f64, seconds: usize) -> Vec<i16> {
    (0..RATE as usize * seconds).map(|i| (size * (2.0 * PI * hertz * i as f64 / RATE).sin()) as i16).collect()
}

/// Tone bursts with hiss between, like speech.
fn speech(seconds: usize) -> Vec<i16> {
    let mut hiss: i64 = 11;
    (0..RATE as usize * seconds)
        .map(|i| {
            hiss = (hiss * 1103515245 + 12345) & 0x7fffffff;
            let t = i as f64;
            if i % (RATE as usize / 4) < RATE as usize / 6 {
                (5000.0 * (2.0 * PI * 170.0 * t / RATE).sin() + 1500.0 * (2.0 * PI * 510.0 * t / RATE).sin()) as i16
            } else {
                ((hiss % 200) - 100) as i16
            }
        })
        .collect()
}

/// The strongest frequency within 4% of `near`, over 0.3 to 0.9 s, by Goertzel with a Hann window.
fn peak(sound: &[i16], near: f64) -> (f64, f64) {
    let from = (RATE * 0.3) as usize;
    let count = (RATE * 0.6) as usize;
    let (mut best, mut strength) = (near, 0.0);
    let mut hertz = near * 0.96;
    while hertz <= near * 1.04 {
        let turn = 2.0 * (2.0 * PI * hertz / RATE).cos();
        let (mut one, mut two) = (0.0, 0.0);
        for i in 0..count {
            let s = *sound.get(from + i).unwrap_or(&0) as f64;
            let next = s * (0.5 - 0.5 * (2.0 * PI * i as f64 / (count - 1) as f64).cos()) + turn * one - two;
            two = one;
            one = next;
        }
        let size = (one * one + two * two - turn * one * two).max(0.0).sqrt();
        if size > strength {
            strength = size;
            best = hertz;
        }
        hertz += 0.25;
    }
    (best, strength)
}

#[test]
fn all_off_leaves_her_voice_untouched() {
    let said = speech(1);
    assert_eq!(styled(&said, RATE, &PLAIN, 1), said);
}

#[test]
fn pitch_moves_the_tone_and_keeps_the_length() {
    let out = styled(&tone(220.0, 8000.0, 1), RATE, &Style { pitch: 3.0, ..PLAIN }, 1);
    assert!((out.len() as i64 - RATE as i64).abs() <= 2);
    let want = 220.0 * 2f64.powf(3.0 / 12.0);
    assert!((peak(&out, want).0 - want).abs() <= 1.0);
}

#[test]
fn speed_changes_the_length_and_keeps_the_pitch() {
    let out = styled(&tone(220.0, 8000.0, 2), RATE, &Style { speed: 150.0, ..PLAIN }, 1);
    assert!((out.len() as f64 - RATE * 2.0 / 1.5).abs() <= 2.0);
    assert!((peak(&out, 220.0).0 - 220.0).abs() <= 1.0);
}

#[test]
fn resample_and_time_stretch_do_what_they_say() {
    assert!((resample(&tone(220.0, 8000.0, 1), 2.0).len() as i64 - RATE as i64 / 2).abs() <= 1);
    assert_eq!(time_stretch(&tone(220.0, 8000.0, 1), RATE, 1.5).len(), (RATE * 1.5) as usize);
}

#[test]
fn layers_each_copy_at_its_pitch_about_8_db_under_her() {
    let mixed = layered(&tone(220.0, 8000.0, 1), RATE, &Layers { on: true, pitch1: 5.0, delay1: 25.0, pitch2: -7.0, delay2: 25.0 });
    let main = peak(&mixed, 220.0);
    let high = peak(&mixed, 220.0 * 2f64.powf(5.0 / 12.0));
    assert!((main.0 - 220.0).abs() <= 1.0);
    assert!((high.1 / main.1 - 0.4).abs() <= 0.16);
}

#[test]
fn layers_too_loud_is_held_under_full_scale() {
    let loud = tone(200.0, 31100.0, 1);
    let spread = layered(&loud, RATE, &Layers { on: true, pitch1: 3.0, delay1: 10.0, pitch2: -5.0, delay2: 30.0 });
    assert!(spread.iter().all(|v| (*v as i32).abs() <= 31000));
    assert_eq!(layered(&loud, RATE, &Layers { on: true, pitch1: 0.0, delay1: 0.0, pitch2: 0.0, delay2: 0.0 }).len(), loud.len());
}

#[test]
fn glitch_same_line_same_glitches_and_none_in_silence() {
    let said = speech(6);
    let some = glitched(&said, RATE, 0.5, 7);
    assert_ne!(some, said);
    assert_eq!(some, glitched(&said, RATE, 0.5, 7));
    assert_ne!(some, glitched(&said, RATE, 0.5, 8));
    let silence = vec![0i16; RATE as usize * 3];
    assert_eq!(glitched(&silence, RATE, 1.0, 7), silence);
}

#[test]
fn robot_sings_on_the_nearest_note() {
    // 200 Hz sits between G3 (196) and G#3 (207.65); a full robot pulls it onto G3.
    let out = vocoded(&tone(200.0, 8000.0, 1), RATE, 1.0, 3);
    assert_eq!(out.len(), RATE as usize);
    assert!((peak(&out, 196.0).0 - 196.0).abs() <= 1.5);
    assert_eq!(out, vocoded(&tone(200.0, 8000.0, 1), RATE, 1.0, 3));
}

#[test]
fn seed_is_the_fnv_hash_the_typescript_uses() {
    assert_eq!(seed_of(""), 2166136261u32 as i32 & 0x7fffffff);
    assert_eq!(seed_of("a"), ((2166136261u32 ^ 97).wrapping_mul(16777619) & 0x7fffffff) as i32);
}
