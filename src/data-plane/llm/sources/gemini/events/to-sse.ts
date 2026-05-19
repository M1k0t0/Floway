import type { GeminiStreamEvent } from "../../../shared/protocol/gemini.ts";
import { protocolFramesUntilTerminal } from "../../../shared/stream/protocol-algebra.ts";
import {
  type ProtocolFrame,
  type SseFrame,
  sseFrame,
} from "../../../shared/stream/types.ts";
import { geminiSourceStreamAlgebra } from "./protocol.ts";

export const geminiProtocolFrameToSSEFrame = (
  frame: ProtocolFrame<GeminiStreamEvent>,
): SseFrame | null =>
  frame.type === "done" ? null : sseFrame(JSON.stringify(frame.event));

export const geminiProtocolEventsToSSEFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
): AsyncGenerator<SseFrame> {
  for await (
    const frame of protocolFramesUntilTerminal(
      frames,
      geminiSourceStreamAlgebra,
    )
  ) {
    const sse = geminiProtocolFrameToSSEFrame(frame);
    if (sse) yield sse;
  }
};
