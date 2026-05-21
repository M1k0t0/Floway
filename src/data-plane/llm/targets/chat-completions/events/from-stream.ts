import { chatCompletionsErrorPayloadMessage } from '../../../../shared/protocol/chat-completions-errors.ts';
import type { ChatCompletionChunk } from '../../../../shared/protocol/chat-completions.ts';
import { doneFrame, eventFrame, type ProtocolFrame, type SseFrame } from '../../../shared/stream/types.ts';
import { parseTargetStreamFrames } from '../../events/from-stream.ts';

const chatCompletionsSseJsonToEvent = (parsed: unknown): ChatCompletionChunk => {
  const errorMessage = chatCompletionsErrorPayloadMessage(parsed);
  if (errorMessage) {
    throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`);
  }

  return parsed as ChatCompletionChunk;
};

export const chatCompletionsStreamFramesToEvents = (frames: AsyncIterable<SseFrame>): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames(frames, {
      protocol: 'Chat Completions',
    })) {
      if (frame.type === 'done') {
        yield doneFrame();
      } else {
        yield eventFrame(chatCompletionsSseJsonToEvent(frame.data));
      }
    }
  })();
