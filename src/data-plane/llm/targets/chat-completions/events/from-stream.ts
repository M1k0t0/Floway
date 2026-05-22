import { chatCompletionsErrorPayloadMessage } from '../../../../shared/protocol/chat-completions-errors.ts';
import type { ChatCompletionChunk } from '../../../../shared/protocol/chat-completions.ts';
import { doneFrame, eventFrame, type ProtocolFrame, type SseFrame } from '../../../shared/stream/types.ts';
import { parseTargetStreamFrames } from '../../events/from-stream.ts';

// Probes for OpenAI-style streamed error payloads before the unknown body is
// committed to the ChatCompletionChunk shape. Receives unknown (not the
// generic `ChatCompletionChunk`) because the inspection runs on the raw
// upstream JSON.
const guardChatCompletionsError = (parsed: unknown): void => {
  const errorMessage = chatCompletionsErrorPayloadMessage(parsed);
  if (errorMessage) {
    throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`);
  }
};

export const chatCompletionsStreamFramesToEvents = (frames: AsyncIterable<SseFrame>): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames<ChatCompletionChunk>(frames, {
      protocol: 'Chat Completions',
    })) {
      if (frame.type === 'done') {
        yield doneFrame();
      } else {
        guardChatCompletionsError(frame.data);
        yield eventFrame(frame.data);
      }
    }
  })();
