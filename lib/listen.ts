// The browser's speech recognition (Chrome, Edge, Safari). It sends audio to the browser maker's speech service.
export type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export function recognitionClass() {
  const w = window as unknown as Record<string, (new () => Recognition) | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

// French speech engines also hear "Hey Capri" as "et Capri" or "é Capri". Only at the start of a
// phrase, so "Naples et Capri sont belles" doesn't wake her.
const WAKE = /^\s*(?:hey|hé|hè|he|eh|ey|é|hi|et|ok|okay|dis)[\s,-]+capri(?:e|y|s)?(?![\p{L}\p{N}])[\s,.!?:;-]*(.*)$/isu;

// null: not for her. "": she was called, the question comes next.
export function afterWakeWord(phrase: string) {
  const match = phrase.match(WAKE);
  return match ? match[1].trim() : null;
}
