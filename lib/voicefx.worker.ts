import { styled } from "./voicefx.ts";

// Off the main thread: styling a long line takes long enough to freeze her animation.
self.onmessage = ({ data }) => {
  const out = new Int16Array(styled(data.pcm, data.rate, data.style, data.seed)); // a copy, so the transfer never detaches the caller's samples
  self.postMessage({ id: data.id, out }, { transfer: [out.buffer] });
};
