import type { MessagesStreamEventData } from '../../../../shared/protocol/messages.ts';
import { doneFrame, eventFrame, type ProtocolFrame, type SseFrame } from '../../../shared/stream/types.ts';
import { parseTargetStreamFrames } from '../../events/from-stream.ts';

export const messagesStreamFramesToEvents = (frames: AsyncIterable<SseFrame>): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> =>
  (async function* () {
    for await (const frame of parseTargetStreamFrames<MessagesStreamEventData>(frames, {
      protocol: 'Messages',
      malformedJsonEventName: 'message',
    })) {
      if (frame.type === 'done') {
        yield doneFrame();
      } else {
        yield eventFrame(frame.data);
      }
    }
  })();
