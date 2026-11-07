// The main screen. Most state lives in refs, because the timers and the animation loop read it long after a render.
"use client";

import Link from "next/link";
import { type FormEvent, type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { CHECK_INS, idleEvent, MURMURS, pick } from "@/lib/events";
import { LANGUAGES } from "@/lib/languages";
import { fixedLine, MAX_STEPS, needsApproval, reminderLine, startingTool, toolFailed, TOO_MANY_STEPS } from "@/lib/lines";
import { afterWakeWord, type Recognition, recognitionClass } from "@/lib/listen";
import { MAX_CHARS, type Message, type ToolCall } from "@/lib/messages";
import { type Live, liveAfter, loadLive, NO_LIVE, saveLive } from "@/lib/quota";
import {
  BUBBLE_SECONDS, chatBody, DEFAULTS, keyFrom, loadStore, onSettingsChange, POP_MINUTES, RECALL, appendHistory, saveSettings,
  type Settings, SIZE_PX, SLEEP_SECONDS, WANDER_PACE,
} from "@/lib/settings";
import { type CloudVoice, isSpeaking, onCloudVoice, speak, stopSpeaking, typingTick } from "@/lib/voice";
import Quotas from "./Quotas";

// Frames and frames per second of each strip, from capri-desktop site/app.js and clips.json.
const CLIPS = {
  idle: [16, 8], blink: [4, 8], blink_glitch: [4, 8], grin: [16, 8], glitch: [10, 15],
  dangle: [24, 10], sleep: [16, 6], wake: [13, 15], mouth: [5, 12], walk: [12, 12],
} as const;
type Clip = keyof typeof CLIPS;
const EAGER: Clip[] = ["idle", "blink", "mouth", "walk"];
const FILE: Partial<Record<Clip, string>> = { walk: "walk.png" };

const ASPECT = 5 / 8;
const FEET = 0.0547; // empty strip under her feet, as a share of her height
const GRIP = 1 - 0.8958; // where the dangle clip is held, from the top
const GRAVITY = 2600; // px/s²
const WALK_SPEED = 90; // px/s
const TYPE_SPEED = 40; // characters a second
const STAYS_UP_FROM = 200; // characters: past this a reply is for reading, so it stays until closed
const FOLLOW_UP_CHANCE = 0.25;
const FOLLOW_UP_DELAY = 5000;
const HOP = 850; // px/s, about 140 px high
const CALLED_WINDOW = 8000; // how long she waits for the question after "Hey Capri"
const FOLLOW_UP = "(Nobody said anything. Add one short second thought to what you just said.)";

const FAILED = "Ma ligne vient de griller. Réessaie dans un instant.";
const BAD_KEY = "Le fournisseur refuse ma clé. Regarde dans les paramètres.";
const STORE_DOWN = "Je n'arrive pas à relire ma mémoire. Recharge la page, je ne sauvegarde rien d'ici là.";
const NOT_SET_UP = "Je n'ai pas encore de cerveau : choisis un modèle dans les paramètres.";

const NO_RECOGNITION = "Ce navigateur ne sait pas m'écouter. Essaie Chrome, Edge ou Safari.";
const MIC_BLOCKED = "Le micro est bloqué. Autorise-le pour cette page dans le navigateur.";
const NO_MIC = "Je ne trouve aucun micro sur cette machine.";
const MIC_OFFLINE = "Le service vocal du navigateur ne répond pas.";

// A job: how far she goes on her own, and how often she says she's still on it.
const STILL_ON_IT_AFTER = 20_000;
const STILL_ON_IT = ["Toujours dessus.", "Ça avance, encore un instant.", "Je n'ai pas oublié, ça mouline."];
const STOPPED = "J'arrête là. Ce qui était déjà en cours peut quand même aller au bout.";
const JOB_FAILED = "Ma ligne a grillé en plein travail, je n'ai pas pu finir.";
const toolLabel = (name: string) => {
  const [server, ...tool] = name.split("__");
  return tool.length ? `${tool.join("__")} (${server})` : name;
};

const between = (low: number, high: number) => low + Math.random() * (high - low);

function mouthFor(letter: string, step: number) {
  const lower = letter.toLowerCase();
  if ("aeo".includes(lower)) return letter !== lower ? 4 : 3;
  if ("iuy".includes(lower)) return 2;
  if ("mbp".includes(lower) || !/\p{L}/u.test(letter)) return 0;
  return step % 2 ? 1 : 2;
}

// The whole companion: conversation, tools, microphone, timers and the sprite on its canvas.
export default function Capri() {
  const body = useRef<HTMLButtonElement>(null);
  const sprite = useRef<HTMLCanvasElement>(null);
  const talk = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cfg = useRef<Settings>(DEFAULTS);
  const history = useRef<Message[]>([]);
  const stored = useRef(false); // nothing may be saved over her memory before it has been read
  const opened = useRef<Promise<unknown>>(Promise.resolve());
  const started = useRef(false);
  const speech = useRef({ text: "", start: 0 }); // what the animation loop mouths
  const quiet = useRef(false);
  const busyNow = useRef(false);
  const typingNow = useRef(false);
  const followUp = useRef(0);
  const recognition = useRef<Recognition | null>(null);
  const wakeWanted = useRef(false);
  const calledUntil = useRef(0);
  const restart = useRef(0);
  // Set by the animation effect, called by the event handlers below.
  const api = useRef<{
    grab: (e: PointerEvent) => void;
    drag: (e: PointerEvent) => boolean;
    drop: () => void;
    nudge: (dx: number) => void;
    bring: () => void;
    rub: (e: PointerEvent) => void;
  } | null>(null);
  const moved = useRef(false);

  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState("");
  const [hidden, setHidden] = useState(false);
  const [listening, setListening] = useState<"" | "push" | "wake">("");
  const [heard, setHeard] = useState("");
  const [lines, setLines] = useState(0);
  const [pinned, setPinned] = useState(false);
  const pinnedNow = useRef(false); // a summary she was asked for; nothing unprompted may replace it
  const bubble = useRef<HTMLParagraphElement>(null);
  const [working, setWorking] = useState(false);
  const [cloudVoice, setCloudVoice] = useState<CloudVoice>("off");
  useEffect(() => onCloudVoice(setCloudVoice), []);
  const [approval, setApproval] = useState<{ label: string; args: string; answer: (a: "yes" | "always" | "no") => void } | null>(null);
  const stopJob = useRef(false);
  const lastNews = useRef(0);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [live, setLive] = useState<Live>(NO_LIVE);
  typingNow.current = typing;

  const say = (said: string) => {
    const text = fixedLine(said, cfg.current.language);
    speech.current = { text, start: performance.now() };
    setShown("");
    setLines((n) => n + 1); // a new line must start revealing even when the bubble was already empty
    pinnedNow.current = false;
    setPinned(false);
  };

  const voice = (said: string) => speak(fixedLine(said, cfg.current.language), cfg.current).catch((error) => console.error("[voice]", error));

  const remember = (added: Message[]) => {
    history.current = [...history.current, ...added];
    if (cfg.current.remember && stored.current) appendHistory(added);
  };

  // Keeps her memory length; most providers need the window to start on a user turn.
  const recent = (list: Message[]) => {
    const kept = list.slice(-RECALL[cfg.current.memory]);
    while (kept[0]?.role === "assistant") kept.shift();
    return kept;
  };

  const ask = async (messages: Message[], useTools = false) => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, useTools, ...chatBody(cfg.current) }),
    });
    const data = await res.json();
    setLive((prev) => liveAfter(prev, res.ok, data));
    if (res.ok && typeof data.reply === "string") return { reply: data.reply as string, toolCalls: data.toolCalls as ToolCall[] | undefined };
    if (data.error === "not_configured") return { problem: NOT_SET_UP };
    return { problem: data.status === 401 || data.status === 403 ? BAD_KEY : FAILED };
  };

  // She speaks unprompted: check-ins and follow-ups. The nudge itself stays out of her memory.
  const unprompted = async (nudge: string) => {
    try {
      const answer = await ask(recent([...history.current, { role: "user", content: nudge }]));
      if (!answer.reply || busyNow.current || pinnedNow.current || input.current?.value || recognition.current?.continuous === false) return;
      remember([{ role: "assistant", content: answer.reply.slice(0, 8000) }]);
      say(answer.reply);
      voice(answer.reply);
    } catch (error) {
      console.error("[unprompted]", error);
    }
  };

  // News while she works: in the bubble, and out loud unless she was told to keep quiet.
  const news = (line: string, aloud = true) => {
    lastNews.current = performance.now();
    say(line);
    if (aloud && cfg.current.mcpVoiceNews && !quiet.current) voice(line);
  };

  const mayRun = async (name: string, args: unknown) => {
    const s = cfg.current;
    if (!s.mcpConfirm || s.mcpAllowed.includes(name)) return true;
    setHidden(false);
    news(needsApproval(toolLabel(name), s.language));
    const answer = await new Promise<"yes" | "always" | "no">((resolve) =>
      setApproval({ label: toolLabel(name), args: JSON.stringify(args, null, 1).slice(0, 600), answer: resolve }),
    );
    setApproval(null);
    lastNews.current = performance.now();
    if (answer === "always") {
      cfg.current = { ...cfg.current, mcpAllowed: [...cfg.current.mcpAllowed, name] };
      saveSettings(cfg.current);
    }
    return answer !== "no";
  };

  const runTool = async (call: ToolCall) => {
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return "The arguments were not valid JSON. Nothing was run.";
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) return "The arguments must be an object. Nothing was run.";
    if (!(await mayRun(call.function.name, args))) return "The user refused this. Nothing was run. Don't try again unless they ask.";
    if (stopJob.current) return "The user stopped the job. Nothing was run.";
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: call.function.name, arguments: args }),
      });
      const data = await res.json();
      if (!res.ok) return `The tool could not run: ${data.error}.`;
      if (data.isError) news(toolFailed(toolLabel(call.function.name), cfg.current.language));
      return (data.isError ? `The tool failed: ${data.text}` : data.text) as string;
    } catch {
      return "The tool could not be reached. Nothing is known about whether it ran.";
    }
  };

  // Her job loop: ask the brain, run what it calls for, give news, repeat until it has an answer.
  const runJob = async (start: Message[]) => {
    const convo = [...start];
    for (let step = 0; step < MAX_STEPS; step++) {
      const answer = await ask(convo, cfg.current.mcpEnabled);
      if (stopJob.current) return { line: STOPPED };
      if (answer.problem) return { line: step ? JOB_FAILED : answer.problem };
      if (!answer.toolCalls) return { line: answer.reply ?? FAILED, reply: answer.reply, usedTools: step > 0 };
      setWorking(true);
      if (answer.reply) news(answer.reply);
      else news(startingTool(toolLabel(answer.toolCalls[0].function.name), cfg.current.language));
      convo.push({ role: "assistant", content: answer.reply ?? "", tool_calls: answer.toolCalls });
      for (const call of answer.toolCalls) {
        convo.push({ role: "tool", tool_call_id: call.id, content: await runTool(call) });
        if (stopJob.current) return { line: STOPPED };
      }
    }
    return { line: TOO_MANY_STEPS };
  };

  const sendText = async (text: string) => {
    if (!text || busyNow.current) return;
    busyNow.current = true;
    await opened.current; // a message this early must not start a new memory over the saved one
    clearTimeout(followUp.current);
    const messages = recent([...history.current, { role: "user", content: text.slice(0, MAX_CHARS) }]);
    stopJob.current = false;
    setBusy(true);
    say("");
    lastNews.current = performance.now();
    let said = 0;
    const heartbeat = window.setInterval(() => {
      if (performance.now() - lastNews.current < STILL_ON_IT_AFTER || !busyNow.current) return;
      news(STILL_ON_IT[said++ % STILL_ON_IT.length], false);
    }, 2000);
    let line = FAILED;
    let answered = false;
    let stays = false;
    try {
      const result = await runJob(messages);
      line = result.line;
      answered = !!result.reply;
      stays = !!result.usedTools || line.length >= STAYS_UP_FROM;
      // Only the outcome goes in her memory: tool output is long, and she wrote the summary herself.
      if (answered || line === STOPPED || line === TOO_MANY_STEPS || line === JOB_FAILED) {
        remember([messages.at(-1)!, { role: "assistant", content: fixedLine(line, cfg.current.language).slice(0, 8000) }]);
      }
    } catch (error) {
      console.error("[job]", error);
    }
    clearInterval(heartbeat);
    busyNow.current = false;
    setBusy(false);
    setWorking(false);
    setHeard("");
    say(line);
    if (stays) {
      pinnedNow.current = true;
      setPinned(true);
    }
    if (!answered) return;
    voice(line);
    if (!stays && cfg.current.followUps && !quiet.current && Math.random() < FOLLOW_UP_CHANCE) {
      const wait = (line.length / TYPE_SPEED) * 1000 + FOLLOW_UP_DELAY;
      followUp.current = window.setTimeout(() => {
        if (!input.current?.value) unprompted(FOLLOW_UP);
      }, wait);
    }
  };

  const heardInWakeMode = (phrase: string) => {
    if (isSpeaking() || busyNow.current) return; // her own voice coming back through the mic
    if (performance.now() < calledUntil.current) {
      calledUntil.current = 0;
      setHeard(phrase);
      sendText(phrase);
      return;
    }
    const question = afterWakeWord(phrase);
    if (question === null) return;
    if (question) {
      setHeard(question);
      sendText(question);
    } else {
      calledUntil.current = performance.now() + CALLED_WINDOW;
      say("Oui ?");
      voice("Oui ?");
    }
  };

  const startMic = (mode: "push" | "wake") => {
    const Engine = recognitionClass();
    if (!Engine) {
      wakeWanted.current = false;
      say(NO_RECOGNITION);
      return;
    }
    clearTimeout(restart.current);
    if (recognition.current) {
      recognition.current.onend = null;
      recognition.current.abort();
    }
    const mic = new Engine();
    mic.lang = LANGUAGES.find((l) => l[1] === cfg.current.language)?.[2] ?? navigator.language;
    mic.continuous = mode === "wake";
    mic.interimResults = mode === "push";
    mic.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const phrase = e.results[i][0].transcript.trim();
        if (!e.results[i].isFinal) setHeard(phrase);
        else if (mode === "push") {
          setHeard(phrase);
          sendText(phrase);
        } else if (phrase) heardInWakeMode(phrase);
      }
    };
    mic.onerror = (e) => {
      const problem = { "not-allowed": MIC_BLOCKED, "service-not-allowed": MIC_BLOCKED, "audio-capture": NO_MIC, network: MIC_OFFLINE }[e.error];
      if (!problem) return; // no-speech and aborted are normal
      wakeWanted.current = false;
      say(problem);
    };
    mic.onend = () => {
      if (recognition.current !== mic) return;
      recognition.current = null;
      setListening("");
      if (!busyNow.current) setHeard(""); // nothing was said in the end
      // Browsers end recognition after a silence, so "Hey Capri" has to start it again.
      if (wakeWanted.current) restart.current = window.setTimeout(() => startMic("wake"), 400);
    };
    recognition.current = mic;
    try {
      mic.start();
      setListening(mode);
    } catch (error) {
      console.error("[mic]", error);
      recognition.current = null;
    }
  };

  const toggleTalk = () => {
    if (recognition.current?.continuous === false) {
      recognition.current.stop(); // keeps what was already said
      return;
    }
    stopSpeaking();
    setHidden(false);
    setHeard("");
    startMic("push");
  };

  const syncWake = (on: boolean) => {
    wakeWanted.current = on;
    if (on && !recognition.current) startMic("wake");
    if (!on && recognition.current?.continuous) {
      clearTimeout(restart.current);
      recognition.current.onend = null;
      recognition.current.abort();
      recognition.current = null;
      setListening("");
    }
  };

  // Settings, chats and everything that runs on a timer.
  useEffect(() => {
    let gone = false;
    opened.current = loadStore()
      .then(({ settings: s, history: saved }) => {
        if (gone) return;
        cfg.current = s;
        setSettings(s);
        setLive(loadLive(s.baseUrl));
        if (s.remember) history.current = saved as Message[];
        stored.current = true;
        syncWake(s.wakeWord);
      })
      .catch((error) => {
        console.error("[store]", error);
        if (!gone) say(STORE_DOWN);
      })
      .finally(() => {
        started.current = true;
      });
    const off = onSettingsChange((s) => {
      if (s.baseUrl !== cfg.current.baseUrl) setLive(NO_LIVE);
      cfg.current = s;
      setSettings(s);
      syncWake(s.wakeWord);
    });

    let timer = 0;
    const plan = () => {
      const [low, high] = POP_MINUTES[cfg.current.popIns];
      timer = window.setTimeout(checkIn, between(low, high) * 60_000);
    };
    // Costs one small request each time, only while the page is open and in front.
    const checkIn = async () => {
      const s = cfg.current;
      if (s.checkIns && s.model && !quiet.current && !pinnedNow.current && !document.hidden && !typingNow.current && !busyNow.current) await unprompted(pick(CHECK_INS));
      plan();
    };
    plan();

    // Free lines between the paid pop-ins: bubble only, no request and no voice.
    let murmurTimer = 0;
    const planMurmur = () => {
      const [low, high] = POP_MINUTES[cfg.current.popIns];
      murmurTimer = window.setTimeout(murmur, between(low, high) * 30_000);
    };
    const murmur = () => {
      const s = cfg.current;
      const french = !s.language || s.language === "French";
      if (s.checkIns && french && !speech.current.text && !quiet.current && !pinnedNow.current && !document.hidden && !typingNow.current && !busyNow.current) say(pick(MURMURS));
      planMurmur();
    };
    planMurmur();

    // Reminders stay on the server, so one set while the page was closed still comes up when it opens. They speak even in the background.
    const remind = async () => {
      if (busyNow.current || recognition.current?.continuous === false) return;
      try {
        const res = await fetch(`/api/reminders${document.hidden ? "?hidden" : ""}`, { method: "POST" });
        const due: { text: string; at: number }[] = res.ok ? (await res.json()).due : [];
        if (!due.length) return;
        const { language } = cfg.current;
        const locale = LANGUAGES.find((l) => l[1] === language)?.[2] ?? "fr-FR";
        const line = due.map((r) => reminderLine(r.text, Date.now() - r.at > 120_000 ? new Date(r.at).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : null, language)).join(" ");
        say(line);
        if (!quiet.current) voice(line);
        remember([{ role: "assistant", content: line }]);
      } catch (error) {
        console.error("[reminders]", error);
      }
    };
    const reminderTimer = window.setInterval(remind, 15_000);
    return () => {
      gone = true;
      off();
      clearInterval(reminderTimer);
      clearTimeout(timer);
      clearTimeout(murmurTimer);
      clearTimeout(followUp.current);
      clearTimeout(restart.current);
      wakeWanted.current = false;
      if (recognition.current) {
        recognition.current.onend = null;
        recognition.current.abort();
        recognition.current = null;
      }
      stopSpeaking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once; the helpers only read refs
  }, []);

  useEffect(() => {
    if (settings) saveLive(live, settings.baseUrl);
  }, [live, settings]);

  useEffect(() => {
    if (settings) document.documentElement.dataset.look = String(settings.look);
  }, [settings]);

  // Animation and movement.
  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    const loaded = new Set<Clip>();
    const strips = {} as Record<Clip, HTMLImageElement>;
    const load = (name: Clip) => {
      strips[name] = new Image();
      strips[name].src = `/sprites/${FILE[name] ?? `${name}.webp`}`;
      strips[name].decode().then(() => loaded.add(name)).catch(() => {});
    };
    // She can already idle, blink, talk and walk; the longer clips follow once the first paint is done (play() falls back to idle until then).
    const names = Object.keys(CLIPS) as Clip[];
    const urgent = names.filter((name) => EAGER.includes(name));
    urgent.forEach(load);
    const later = setTimeout(() => names.filter((name) => !urgent.includes(name)).forEach(load), 1500);

    const height = () => SIZE_PX[cfg.current.size];
    const width = () => height() * ASPECT;
    const floorY = () => innerHeight - height() + FEET * height() - (document.querySelector("footer")?.offsetHeight ?? 0) - 14; // feet above the credit line

    const born = performance.now();
    let clip: Clip = "idle";
    let clipStart = born;
    let cycle = 0;
    let blinkWith: Clip | null = null;
    let nextEvent = born + between(8_000, 18_000);
    let napUntil = 0;
    let lastInput = born;
    let drawn = "";
    let introDone = false;

    let x = -1; // placed on the first frame, once her saved size is known
    let y = 0;
    let vx = 0;
    let vy = 0;
    let held = false;
    let falling = false;
    let pointer = { x: 0, y: 0, t: 0 };
    let walkTo: number | null = null;
    let nextWalk = 0;
    let rubbed = 0;
    let rubStart = 0;

    // Switches to a clip, starting from its first frame.
    const play = (name: Clip) => {
      clip = loaded.has(name) ? name : "idle";
      clipStart = performance.now();
      cycle = 0;
      blinkWith = null;
      napUntil = 0;
    };

    // Canvas, not CSS backgrounds: Chrome left her blank while it repainted these very wide strips.
    const draw = (name: Clip, cell: number, mouth: number) => {
      const canvas = sprite.current;
      const paper = canvas?.getContext("2d");
      const frame = `${name}:${cell}:${mouth}`;
      if (!canvas || !paper || frame === drawn) return;
      drawn = frame;
      paper.clearRect(0, 0, canvas.width, canvas.height);
      const stamp = (strip: Clip, at: number) => {
        const image = strips[strip];
        const w = image.naturalWidth / CLIPS[strip][0];
        paper.drawImage(image, at * w, 0, w, image.naturalHeight, 0, 0, canvas.width, canvas.height);
      };
      stamp(name, cell);
      if (mouth >= 0) stamp("mouth", mouth);
    };

    let last = born;
    let raf = 0;
    // Runs on every animation frame: decides what she's doing, moves her and draws her.
    const frame = (now: number) => {
      if (!started.current) {
        last = now;
        raf = requestAnimationFrame(frame); // her saved size and intro aren't known yet
        return;
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const motion = !still.matches;
      const s = cfg.current;
      const said = speech.current;
      const talking = now - said.start < (said.text.length / TYPE_SPEED) * 1000;
      const w = width();
      const h = height();
      if (x < 0) x = Math.max(0, innerWidth / 2 - w / 2);

      if (!introDone && loaded.has("glitch")) {
        introDone = true;
        if (s.intro && motion) play("glitch");
      }

      if (falling) {
        vy += GRAVITY * dt;
        x += vx * dt;
        y += vy * dt;
        if (x < 0 || x > innerWidth - w) vx *= -0.6;
        if (y >= floorY()) {
          falling = false;
          y = floorY();
          vx = vy = 0;
          play("grin");
        }
      }

      // Wander: walks along the floor now and then, never over a chat.
      const pace = WANDER_PACE[s.wander];
      const free = pace > 0 && motion && !held && !falling && !talking && !typingNow.current && !busyNow.current;
      if (walkTo === null && free && clip === "idle") {
        if (!nextWalk) nextWalk = now + between(10_000, 30_000) * pace;
        else if (now >= nextWalk) {
          nextWalk = 0;
          walkTo = between(0, Math.max(0, innerWidth - w));
          play("walk");
        }
      }
      if (walkTo !== null) {
        const step = Math.sign(walkTo - x) * WALK_SPEED * dt;
        if (!free || Math.abs(walkTo - x) <= Math.abs(step)) {
          walkTo = null;
          if (clip === "walk") play("idle");
        } else {
          x += step;
          if (sprite.current) sprite.current.style.transform = step < 0 ? "scaleX(-1)" : "";
        }
      } else if (sprite.current?.style.transform) sprite.current.style.transform = "";

      x = Math.max(0, Math.min(x, innerWidth - w));
      if (!held && !falling) y = floorY(); // follows window resizes and size changes
      if (body.current) {
        body.current.style.width = `${w}px`;
        body.current.style.height = `${h}px`;
        body.current.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      }
      if (talk.current) {
        const tw = talk.current.offsetWidth;
        const th = talk.current.offsetHeight;
        const left = Math.max(8, Math.min(x + w / 2 - tw / 2, innerWidth - tw - 8));
        const top = Math.max((document.querySelector(".band")?.getBoundingClientRect().bottom ?? 48) + 8, Math.min(y - th, innerHeight - th - 8));
        talk.current.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      }

      if (talking) lastInput = now;
      if (talking && clip === "sleep") play("wake"); // a voice can wake her with no mouse or key

      let index = Math.max(0, Math.floor(((now - clipStart) / 1000) * CLIPS[clip][1]));
      const ended = ((clip === "glitch" || clip === "wake") && index >= CLIPS[clip][0]) || (clip === "grin" && index >= CLIPS.grin[0] * 2);
      if (ended || (clip === "dangle" && !held && !falling)) {
        play("idle");
        index = 0;
      }
      if (clip === "idle" && motion) {
        const current = Math.floor(index / CLIPS.idle[0]);
        if (current !== cycle) {
          cycle = current;
          const roll = Math.random();
          blinkWith = roll < 0.1 ? "blink_glitch" : roll < 0.55 ? "blink" : null;
          if (now >= nextEvent && !talking) {
            nextEvent = now + between(8_000, 18_000);
            const calm = !typingNow.current && !busyNow.current; // a jump would take the open chat with it
            const event = idleEvent({ hop: calm, nap: calm && s.sleep > 0, teleport: calm && s.wander > 0 }, Math.random());
            if (event === "hop") {
              play("dangle");
              falling = true;
              vy = -HOP;
              vx = s.wander > 0 ? between(-120, 120) : 0; // Balade off: she lands where she took off
            } else if (event === "nap") {
              play("sleep");
              napUntil = now + between(4_000, 9_000);
            } else if (event === "teleport") {
              play("glitch");
              x = between(0, Math.max(0, innerWidth - w));
            } else play(event);
            index = 0;
          }
        }
      }
      if (clip === "sleep" && napUntil && now >= napUntil) play("wake");
      const sleepAfter = SLEEP_SECONDS[s.sleep] * 1000;
      if (clip === "idle" && sleepAfter && now - lastInput > sleepAfter && !talking && !busyNow.current && !typingNow.current) play("sleep");

      let name = clip;
      let cell = motion ? index % CLIPS[clip][0] : 0;
      // Her artist's blink swaps in at cells 9 to 12 of the idle loop.
      if (name === "idle" && blinkWith && loaded.has(blinkWith) && cell >= 9 && cell < 9 + CLIPS[blinkWith][0]) {
        name = blinkWith;
        cell -= 9;
      }
      let mouth = -1;
      if (talking && motion && clip === "idle" && name !== "blink_glitch" && loaded.has("mouth")) {
        const step = Math.floor(((now - said.start) / 1000) * CLIPS.mouth[1]);
        const letter = Math.floor(((now - said.start) / 1000) * TYPE_SPEED);
        mouth = mouthFor(said.text[letter] ?? " ", step);
      }
      if (loaded.has(name)) draw(name, cell, mouth);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // Any sign of life from the person wakes her up.
    const wake = () => {
      lastInput = performance.now();
      if (clip === "sleep") play("wake");
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel"];
    events.forEach((type) => document.addEventListener(type, wake, { passive: true }));

    let start = { x: 0, y: 0 };
    api.current = {
      grab: (e) => {
        start = { x: e.clientX, y: e.clientY };
        pointer = { x: e.clientX, y: e.clientY, t: performance.now() };
      },
      drag: (e) => {
        if (!held) {
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (dx * dx + dy * dy < 25) return false;
          held = true;
          falling = false;
          walkTo = null;
          play("dangle");
        }
        const t = performance.now();
        const span = Math.max(1, t - pointer.t) / 1000;
        vx = (e.clientX - pointer.x) / span;
        vy = (e.clientY - pointer.y) / span;
        pointer = { x: e.clientX, y: e.clientY, t };
        x = e.clientX - width() / 2;
        y = Math.min(e.clientY - GRIP * height(), floorY());
        return true;
      },
      drop: () => {
        if (!held) return;
        held = false;
        if (performance.now() - pointer.t > 100) vx = vy = 0; // she was held still, not thrown
        vx = Math.max(-1800, Math.min(1800, vx));
        vy = Math.max(-1800, Math.min(1800, vy));
        falling = true;
      },
      nudge: (dx) => {
        x += dx;
      },
      bring: () => {
        x = innerWidth / 2 - width() / 2;
        y = floorY();
        falling = false;
        play("glitch");
      },
      rub: (e) => {
        if (!cfg.current.headPats || clip !== "idle") return;
        const t = performance.now();
        if (t - rubStart > 1500) {
          rubStart = t;
          rubbed = 0;
        }
        rubbed += Math.abs(e.movementX) + Math.abs(e.movementY);
        if (rubbed > 500) {
          rubbed = 0;
          play("grin");
        }
      },
    };

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(later);
      events.forEach((type) => document.removeEventListener(type, wake));
      api.current = null;
    };
  }, []);

  // Her keys only work while this tab has focus: a web page can't listen from elsewhere.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const key = keyFrom(e);
      const s = cfg.current;
      if (key === s.keyTalk) toggleTalk();
      else if (key === s.keyType) setTyping((open) => !open);
      else if (key === s.keyHide) setHidden((gone) => !gone);
      else if (key === s.keyQuiet) {
        quiet.current = !quiet.current;
        if (quiet.current) {
          stopSpeaking();
          clearTimeout(followUp.current);
        }
        say(quiet.current ? "Je me fais discrète." : "Je suis de retour.");
      } else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // Reveals the reply letter by letter, in step with her mouth, then lets the bubble go.
  useEffect(() => {
    const { text, start } = speech.current;
    if (!text) return;
    if (shown.length < text.length) {
      const id = setTimeout(() => {
        const count = matchMedia("(prefers-reduced-motion: reduce)").matches
          ? text.length
          : Math.max(shown.length + 1, Math.floor(((performance.now() - start) / 1000) * TYPE_SPEED));
        if (cfg.current.typingSound) typingTick(cfg.current);
        setShown(text.slice(0, count));
      }, 25);
      return () => clearTimeout(id);
    }
    if (busy || pinned) return; // news stays up until the next one, a summary until it's closed
    const id = setTimeout(() => say(""), BUBBLE_SECONDS[cfg.current.bubble] * 1000);
    return () => clearTimeout(id);
  }, [busy, shown, lines, pinned]);

  // Follows a long reply as it types out.
  useEffect(() => {
    if (bubble.current && shown.length < speech.current.text.length) bubble.current.scrollTop = bubble.current.scrollHeight;
  }, [shown]);

  useEffect(() => {
    if (typing) input.current?.focus();
  }, [typing]);

  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = input.current?.value.trim();
    if (!text || busyNow.current) return;
    input.current!.value = "";
    setHeard("");
    sendText(text);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (moved.current) api.current?.drop();
    else if (e.type === "pointerup") setTyping((open) => !open);
    moved.current = false;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -24, ArrowRight: 24 }[e.key];
    if (step) {
      e.preventDefault();
      api.current?.nudge(step);
    }
  };

  return (
    <>
      <nav className="band">
        <b className="brand">Capri</b>
        {settings && (settings.model ? <span className="brain">{settings.provider} · {settings.model}</span> : <Link className="brain warn" href="/settings">Choisir un modèle</Link>)}
        <div className="band-keys">
          {listening === "wake" && <span className="mic-on" role="status">Micro ouvert, dis « Hey Capri »</span>}
          {cloudVoice !== "off" && <span className="eleven-on" role="status">ElevenLabs : {cloudVoice === "calling" ? "appel en cours" : "lecture"}</span>}
          <button type="button" className={`key ${listening === "push" ? "cyan" : ""}`} aria-pressed={listening === "push"} onClick={toggleTalk}>
            {listening === "push" ? "J'écoute… (arrêter)" : "Parler"}
          </button>
          <button type="button" className="key" onClick={() => { setHidden(false); setTyping(true); }}>
            Écrire
          </button>
          <button type="button" className="key" onClick={() => { setHidden(false); api.current?.bring(); }}>
            Ramener ici
          </button>
          <button type="button" className="key" onClick={() => setHidden((gone) => !gone)}>
            {hidden ? "Montrer Capri" : "Cacher Capri"}
          </button>
          <Link className="key cyan" href="/settings">
            Paramètres
          </Link>
        </div>
      </nav>
      {settings && <Quotas settings={settings} live={live} />}
      <div ref={talk} className={`talk ${pinned ? "wide" : ""}`} hidden={hidden}>
        {heard && <p className="heard">Toi : {heard}</p>}
        {(busy || shown) && (
          <p ref={bubble} className="bubble" aria-live="polite">
            {shown || "…"}
          </p>
        )}
        {pinned && (
          <button type="button" className="key close-bubble" onClick={() => { stopSpeaking(); say(""); }}>Fermer</button>
        )}
        {approval && (
          <div className="approval" role="alertdialog" aria-label={`Autoriser ${approval.label} ?`}>
            <p>
              Lancer <b>{approval.label}</b> ?
            </p>
            <pre>{approval.args}</pre>
            <div>
              <button type="button" className="key cyan" onClick={() => approval.answer("yes")}>Autoriser</button>
              <button type="button" className="key" onClick={() => approval.answer("always")}>Toujours</button>
              <button type="button" className="key" onClick={() => approval.answer("no")}>Refuser</button>
            </div>
          </div>
        )}
        {working && !approval && (
          <button type="button" className="key" onClick={() => { stopJob.current = true; news(STOPPED, false); }}>Arrêter</button>
        )}
        {typing && (
          <form onSubmit={send}>
            <input
              ref={input}
              maxLength={MAX_CHARS}
              autoComplete="off"
              placeholder="Dis quelque chose à Capri"
              aria-label="Message pour Capri"
              onKeyDown={(e) => e.key === "Escape" && setTyping(false)}
            />
          </form>
        )}
      </div>
      <button
        ref={body}
        type="button"
        className="capri"
        hidden={hidden}
        aria-label={typing ? "Capri, fermer la discussion" : "Capri, ouvrir la discussion"}
        aria-expanded={typing}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          moved.current = false;
          api.current?.grab(e);
        }}
        onPointerMove={(e) => {
          if (!e.buttons) api.current?.rub(e);
          else if (api.current?.drag(e)) moved.current = true;
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          // Enter and Space send a click with no pointer behind it.
          if (e.detail === 0) setTyping((open) => !open);
        }}
      >
        <canvas ref={sprite} className="sprite" width={400} height={640} />
      </button>
    </>
  );
}
