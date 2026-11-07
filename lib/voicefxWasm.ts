// Loads the Rust build of the voice effects (voicefx-rs, compiled to public/voicefx.wasm) and runs a line through it.
// Same inputs and outputs as `styled` in voicefx.ts, which stays the fallback and the reference the tests compare against.
import type { VoiceStyle } from "./voicefx.ts";

type Exports = {
  memory: WebAssembly.Memory;
  alloc(samples: number): number;
  dealloc(ptr: number, samples: number): void;
  styled_into(ptr: number, len: number, rate: number, pitch: number, speed: number, robot: number, glitch: number, on: number, p1: number, d1: number, p2: number, d2: number, seed: number): number;
  out_ptr(): number;
};

export function loadFx(bytes: BufferSource) {
  const wasm = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports as unknown as Exports;
  return {
    styled(pcm: Int16Array, rate: number, s: VoiceStyle, seed: number) {
      const ptr = wasm.alloc(pcm.length);
      try {
        new Int16Array(wasm.memory.buffer, ptr, pcm.length).set(pcm);
        const { layers: l } = s;
        const length = wasm.styled_into(ptr, pcm.length, rate, s.pitch, s.speed, s.robot, s.glitch, l.on ? 1 : 0, l.pitch1, l.delay1, l.pitch2, l.delay2, seed);
        return new Int16Array(wasm.memory.buffer, wasm.out_ptr(), length).slice(); // after the call: memory may have grown
      } finally {
        wasm.dealloc(ptr, pcm.length);
      }
    },
  };
}

export type Fx = ReturnType<typeof loadFx>;
