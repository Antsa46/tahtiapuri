import type { Socket } from "node:net";
import { RESPONSE_FRAME_BYTES } from "@tahtiapuri/validation/development-framing";
export async function writeDevelopmentFrame(socket: Socket, value: unknown): Promise<void> {
  const frame = JSON.stringify(value) + "\n", size = Buffer.byteLength(frame);
  if (socket.destroyed || size > RESPONSE_FRAME_BYTES || socket.writableLength + size > RESPONSE_FRAME_BYTES * 2)
    throw new Error("Development output limit reached.");
  if (socket.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timer); socket.removeListener("drain", drained); socket.removeListener("close", closed);
      if (error) reject(error); else resolve();
    };
    const drained = () => done();
    const closed = () => done(new Error("Development socket closed."));
    const timer = setTimeout(() => done(new Error("Development output timed out.")), 2000);
    socket.once("drain", drained); socket.once("close", closed);
  });
}
