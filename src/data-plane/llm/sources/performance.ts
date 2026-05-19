import type { PerformanceFailureCapture } from "../../../middleware/usage-response-metadata.ts";
import type { ProtocolFrame } from "../shared/stream/types.ts";

export const trackPerformanceOutcome = async function* <TEvent>(
  frames: AsyncIterable<ProtocolFrame<TEvent>>,
  capture: PerformanceFailureCapture,
  isFailure: (event: TEvent) => boolean,
  isCompletion: (frame: ProtocolFrame<TEvent>) => boolean,
): AsyncGenerator<ProtocolFrame<TEvent>> {
  for await (const frame of frames) {
    if (frame.type === "event" && isFailure(frame.event)) {
      capture.failed = true;
    }
    if (isCompletion(frame)) {
      capture.completed = true;
    }
    yield frame;
  }
};
