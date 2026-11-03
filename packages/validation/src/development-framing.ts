const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
export const REQUEST_FRAME_BYTES = 16_384;
export const RESPONSE_FRAME_BYTES = 65_536;
export function readFrames(previous: string, chunk: string, limit: number) {
  if (bytes(previous) + bytes(chunk) > limit * 4) throw new Error("Frame batch too large.");
  const value = previous + chunk, frames: string[] = [];
  let start = 0, end: number;
  while ((end = value.indexOf("\n", start)) !== -1) {
    const frame = value.slice(start, end);
    if (frames.length >= 4 || bytes(frame) > limit) throw new Error("Frame too large.");
    frames.push(frame); start = end + 1;
  }
  const remainder = value.slice(start);
  if (bytes(remainder) > limit) throw new Error("Frame too large.");
  return { frames, remainder };
}
