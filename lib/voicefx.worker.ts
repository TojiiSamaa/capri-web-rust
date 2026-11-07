import { styled } from "./voicefx.ts";
import { type Fx, loadFx } from "./voicefxWasm.ts";

// The Rust build (public/voicefx.wasm) does the work; if it can't load, the TypeScript one gives the same sound, a bit slower.
let rust: Promise<Fx | null> | null = null;
const wasm = () =>
  (rust ??= fetch("/voicefx.wasm")
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`voicefx.wasm ${res.status}`))))
    .then(loadFx)
    .catch((error) => (console.error("[voice] Rust effects unavailable, using TypeScript", error), null)));

// Off the main thread: styling a long line takes long enough to freeze her animation.
self.onmessage = async ({ data }) => {
  const fx = await wasm();
  const out = fx ? fx.styled(data.pcm, data.rate, data.style, data.seed) : new Int16Array(styled(data.pcm, data.rate, data.style, data.seed)); // a copy, so the transfer never detaches the caller's samples
  self.postMessage({ id: data.id, out }, { transfer: [out.buffer] });
};
