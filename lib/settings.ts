// Every setting with its default, the choices the page offers, and how the page reads and saves them.
import { FIRST_INFOS_TOOLS, INFOS_TOOLS } from "./mcpConfig.ts";

const AMOUNT_VALUES = [0, 5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const SPEED_VALUES = [70, 80, 90, 100, 110, 120, 130, 140, 150];
const LAYER_PITCHES = [-12, -9, -7, -5, -4, -3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 7, 9, 12];
const LAYER_DELAYS = [0, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250];
const LAYER_DEFAULTS = { layer1Pitch: LAYER_PITCHES.indexOf(2), layer1Delay: LAYER_DELAYS.indexOf(25), layer2Pitch: LAYER_PITCHES.indexOf(-2.5), layer2Delay: LAYER_DELAYS.indexOf(25) };

// Her settings, kept in SQLite on this machine (see store.ts). Lists and defaults follow the Mainframe in capri-desktop.
export const OPTIONS = {
  volume: ["Muet", "10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%", "100%", "125%", "150%"],
  amount: AMOUNT_VALUES.map((v) => (v ? `${v}%` : "Off")),
  layerPitch: LAYER_PITCHES.map((v) => (v === 0 ? "Même" : `${v > 0 ? "+" : ""}${v}`)),
  layerDelay: LAYER_DELAYS.map((v) => `${v} ms`),
  pitch: ["-6", "-5", "-4", "-3", "-2", "-1", "Normal", "+1", "+2", "+3", "+4", "+5", "+6"],
  speed: ["0.7x", "0.8x", "0.9x", "Normal", "1.1x", "1.2x", "1.3x", "1.4x", "1.5x"],
  wander: ["Off", "Rarement", "Parfois", "Souvent", "Agitée"],
  sleep: ["Jamais", "1 min", "2 min", "5 min", "10 min", "30 min"],
  popIns: ["Rarement", "Parfois", "Souvent"],
  size: ["Minuscule", "Petite", "Moyenne", "Grande", "Immense", "Géante"],
  look: ["Night City", "Noir", "Blanc", "Gris"],
  lengths: ["Court", "Moyen", "Long"],
  maxReply: ["Auto", "256", "2K", "8K"],
  bubble: ["Rapide", "Normal", "Long"],
};

export const SIZE_PX = [140, 170, 240, 320, 440, 560];
export const SLEEP_SECONDS = [0, 60, 120, 300, 600, 1800];
export const WANDER_PACE = [0, 3, 1, 0.45, 0.18]; // gaps between walks, as in Pet.WanderPaces
export const POP_MINUTES = [[20, 40], [8, 20], [3, 8]];
export const RECALL = [8, 16, 32];
export const BUBBLE_SECONDS = [4, 8, 16];

export const PROVIDERS: { name: string; url: string; keys?: string }[] = [
  { name: "OpenAI", url: "https://api.openai.com/v1", keys: "https://platform.openai.com/api-keys" },
  { name: "OpenRouter", url: "https://openrouter.ai/api/v1", keys: "https://openrouter.ai/keys" },
  { name: "NVIDIA", url: "https://integrate.api.nvidia.com/v1", keys: "https://build.nvidia.com/settings/api-keys" },
  { name: "Google AI Studio (Gemini)", url: "https://generativelanguage.googleapis.com/v1beta/openai", keys: "https://aistudio.google.com/apikey" },
  { name: "Anthropic (Claude)", url: "https://api.anthropic.com/v1", keys: "https://console.anthropic.com/settings/keys" },
  { name: "Ollama (local)", url: "http://127.0.0.1:11434/v1" },
  { name: "Autre / serveur local", url: "" },
];

export const SPEECH_MODELS = ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"];

export const DEFAULTS = {
  // BRAIN
  provider: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKeySet: false, // the key itself stays on the server
  model: "",
  replies: 0,
  memory: 0,
  maxReply: 0,
  bubble: 1,
  followUps: true,
  // YOU
  personality: "",
  notes: "",
  nickname: "",
  language: "",
  // VOICE
  voiceMode: "off" as "off" | "browser" | "cloud",
  elevenKeySet: false,
  voiceId: "",
  speechModel: SPEECH_MODELS[0],
  volume: 8,
  pitch: 9,
  speed: 5,
  typingSound: false,
  robot: 0,
  glitch: 0,
  layers: true,
  ...LAYER_DEFAULTS,
  wakeWord: false,
  // MOVES
  wander: 0,
  sleep: 2,
  popIns: 1,
  intro: true,
  // CAPRI
  size: 2,
  checkIns: true,
  look: 0,
  headPats: true,
  // HABITS
  remember: true,
  // MCP
  mcpEnabled: true,
  mcpConfirm: true,
  mcpVoiceNews: true,
  mcpAllowed: INFOS_TOOLS,
  infosAllowed: INFOS_TOOLS,
  // KEYS
  keyTalk: "Ctrl+Alt+KeyV",
  keyType: "Ctrl+Alt+KeyT",
  keyHide: "Ctrl+Alt+KeyH",
  keyQuiet: "Ctrl+Alt+KeyP",
};
export type Settings = typeof DEFAULTS;

export { LAYER_DEFAULTS };

export const volumePercent = (at: number) => (at <= 10 ? at * 10 : at === 11 ? 125 : 150);

export const voiceStyle = (s: Settings) => ({
  pitch: s.pitch - 6,
  speed: SPEED_VALUES[s.speed],
  robot: AMOUNT_VALUES[s.robot],
  glitch: AMOUNT_VALUES[s.glitch],
  layers: { on: s.layers, pitch1: LAYER_PITCHES[s.layer1Pitch], delay1: LAYER_DELAYS[s.layer1Delay], pitch2: LAYER_PITCHES[s.layer2Pitch], delay2: LAYER_DELAYS[s.layer2Delay] },
});

export function settingsFrom(saved: Record<string, any>): Settings {
  // Each built-in tool is allowed once, when first seen: taking one off the list has to stick.
  const seen: string[] = saved.infosAllowed === true ? FIRST_INFOS_TOOLS : Array.isArray(saved.infosAllowed) ? saved.infosAllowed : [];
  const unseen = INFOS_TOOLS.filter((tool) => !seen.includes(tool));
  return { ...DEFAULTS, ...saved, mcpAllowed: [...unseen, ...(saved.mcpAllowed ?? [])], infosAllowed: INFOS_TOOLS };
}

// Where these lived before SQLite. Whatever a browser still holds moves over the first time it opens the app.
const OLD_SETTINGS = "capri-settings";
const OLD_HISTORY = "capri-history";

async function moveOldData() {
  const settings = localStorage.getItem(OLD_SETTINGS);
  const history = localStorage.getItem(OLD_HISTORY);
  if (settings === null && history === null) return;
  const res = await fetch("/api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings, history }) });
  if (!res.ok) throw new Error(`store ${res.status}`);
  localStorage.removeItem(OLD_SETTINGS);
  localStorage.removeItem(OLD_HISTORY);
}

// Throws when the server can't answer: saving then would write defaults over the real settings.
export async function loadStore(): Promise<{ settings: Settings; history: unknown[]; historyCount: number }> {
  await moveOldData().catch((error) => console.error("[store] nothing moved, the browser keeps its copy", error));
  const res = await fetch("/api/store");
  if (!res.ok) throw new Error(`store ${res.status}`);
  const { settings, history, historyCount } = await res.json();
  return { settings: settingsFrom(settings), history, historyCount };
}

// One at a time, so a slow save can't land after a newer one.
let queue: Promise<unknown> = Promise.resolve();
const put = (body: unknown) => {
  const text = JSON.stringify(body);
  queue = queue
    .then(() => fetch("/api/store", { method: "PUT", headers: { "Content-Type": "application/json" }, body: text, keepalive: text.length < 60_000 })) // keepalive caps at 64 KB
    .then((res) => {
      if (!res.ok) throw new Error(`store ${res.status}`);
    })
    .catch((error) => console.error("[store]", error));
  return queue;
};

// Wait for this before asking the server to use what was just changed.
export const saved = () => queue;

let channel: BroadcastChannel | null = null;
const tabs = () => (channel ??= new BroadcastChannel("capri-settings"));

export function saveSettings(settings: Settings) {
  put({ settings }).then(() => tabs().postMessage(settings));
}

export const appendHistory = (append: unknown[]) => put({ append });
export const clearHistory = () => put({ clearHistory: true });
export const saveSecrets = (secrets: { apiKey?: string; elevenKey?: string }) => put({ secrets });

export const onSettingsChange = (run: (s: Settings) => void) => {
  const listener = (e: MessageEvent<Settings>) => run(e.data);
  tabs().addEventListener("message", listener);
  return () => tabs().removeEventListener("message", listener);
};

// What the chat route needs from the settings. The brain and its key are read on the server.
export const chatBody = (s: Settings) => ({
  character: { personality: s.personality, nickname: s.nickname, notes: s.notes, language: s.language, replies: s.replies, maxReply: s.maxReply },
});

export function keyFrom(e: KeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Cmd", e.code].filter(Boolean).join("+");
}

export const keyLabel = (key: string) => key.replace(/\bKey/, "").replace(/\bDigit/, "").split("+").join(" + ");
