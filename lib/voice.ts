// Her voice in the browser: speaks through ElevenLabs with her effects, or through the browser's own voice.
import { LANGUAGES } from "./languages.ts";
import { voiceStyle, volumePercent, type Settings } from "./settings.ts";
import { isPlain, seedOf, styled, type VoiceStyle } from "./voicefx.ts";

const RATE = 24000; // what the app asks ElevenLabs for, and what the effects are tuned on

let source: AudioBufferSourceNode | null = null;
let audio: AudioContext | null = null;
let worker: Worker | null = null;
let line = 0; // the newest line; an older one still being made is dropped
let making = false;
let lastRaw: { key: string; pcm: Int16Array } | null = null;

const context = () => (audio ??= new AudioContext());
const loudness = (s: Settings) => volumePercent(s.volume) / 100;

// For the marker on the page: an API call in progress, then a line from ElevenLabs playing.
export type CloudVoice = "off" | "calling" | "playing";
const cloudWatchers = new Set<(state: CloudVoice) => void>();
const setCloudVoice = (state: CloudVoice) => cloudWatchers.forEach((watch) => watch(state));
export const onCloudVoice = (watch: (state: CloudVoice) => void) => {
  cloudWatchers.add(watch);
  return () => void cloudWatchers.delete(watch);
};

export function stopSpeaking() {
  line++;
  making = false;
  setCloudVoice("off");
  speechSynthesis.cancel();
  source?.stop();
  source = null;
}

export const isSpeaking = () => speechSynthesis.speaking || making || !!source;

// Her ElevenLabs line, once: trying other effects on the same line restyles it here and spends no more credits.
async function rawLine(text: string, s: Settings) {
  const key = [s.voiceId, s.speechModel, text].join("|");
  if (lastRaw?.key === key) return lastRaw.pcm;
  const mine = line;
  setCloudVoice("calling"); // only here: a line kept in lastRaw spends nothing
  let wav: ArrayBuffer;
  try {
    const res = await fetch("/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceId: s.voiceId, model: s.speechModel, text: text.slice(0, 4000) }),
    });
    if (!res.ok) throw new Error(`voice ${res.status}`);
    wav = await res.arrayBuffer();
  } finally {
    if (mine === line) setCloudVoice("off");
  }
  const decoded = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(wav);
  const pcm = new Int16Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const samples = decoded.getChannelData(c);
    for (let i = 0; i < pcm.length; i++) pcm[i] += (samples[i] * 32767) / decoded.numberOfChannels;
  }
  lastRaw = { key, pcm };
  return pcm;
}

function inWorker(pcm: Int16Array, style: VoiceStyle, seed: number) {
  return new Promise<Int16Array>((resolve, reject) => {
    worker ??= new Worker(new URL("./voicefx.worker.ts", import.meta.url));
    const id = Math.random();
    const mine = worker;
    const done = () => {
      mine.removeEventListener("message", onMessage);
      mine.removeEventListener("error", onError);
    };
    const onMessage = ({ data }: MessageEvent) => {
      if (data.id !== id) return;
      done();
      resolve(data.out);
    };
    const onError = (e: ErrorEvent) => {
      done();
      worker = null;
      reject(new Error(e.message));
    };
    mine.addEventListener("message", onMessage);
    mine.addEventListener("error", onError);
    mine.postMessage({ id, pcm, rate: RATE, style, seed });
  });
}

// Her voice with its effects, for anything that hands us real audio.
async function makeLine(text: string, s: Settings) {
  const raw = await rawLine(text, s);
  const style = voiceStyle(s);
  if (isPlain(style)) return raw;
  try {
    return await inWorker(raw, style, seedOf(text));
  } catch (error) {
    console.error("[voice] worker failed, styling here", error);
    return styled(raw, RATE, style, seedOf(text));
  }
}

// Throws when her cloud voice fails, so callers can say why.
export async function speak(text: string, s: Settings) {
  stopSpeaking();
  if (s.voiceMode === "off" || s.volume === 0) return;
  if (s.voiceMode === "browser") {
    // shortcut: the browser's voice can't be routed through Web Audio, so robot, glitch and layers need real audio.
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = Math.min(1, loudness(s));
    utterance.rate = voiceStyle(s).speed / 100;
    utterance.pitch = Math.min(2, 2 ** (voiceStyle(s).pitch / 12));
    const code = LANGUAGES.find((l) => l[1] === s.language)?.[2];
    if (code) utterance.lang = code;
    speechSynthesis.speak(utterance);
    return;
  }
  const mine = line;
  making = true;
  let pcm: Int16Array;
  try {
    pcm = await makeLine(text, s);
  } finally {
    if (mine === line) making = false;
  }
  if (mine !== line || !pcm.length) return;
  const ctx = context();
  await ctx.resume();
  const buffer = ctx.createBuffer(1, pcm.length, RATE);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
  const node = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = loudness(s);
  node.buffer = buffer;
  node.connect(gain).connect(ctx.destination);
  node.onended = () => {
    if (source !== node) return;
    source = null;
    setCloudVoice("off");
  };
  source = node;
  node.start();
  setCloudVoice("playing");
}

export function typingTick(s: Settings) {
  const ctx = context();
  const beep = ctx.createOscillator();
  const gain = ctx.createGain();
  beep.frequency.value = 1400 + Math.random() * 500;
  gain.gain.setValueAtTime(Math.max(0.0002, 0.03 * loudness(s)), ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.03);
  beep.connect(gain).connect(ctx.destination);
  beep.start();
  beep.stop(ctx.currentTime + 0.03);
}
