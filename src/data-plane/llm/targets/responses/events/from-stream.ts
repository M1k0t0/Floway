import { responsesResultToEvents } from './from-result.ts';
import type { ResponsesResult, ResponseStreamEvent } from '../../../../shared/protocol/responses.ts';
import { isResponsesTerminalEvent, type SequencedResponsesStreamEvent } from '../../../shared/protocol/responses.ts';
import { doneFrame, type EventFrame, eventFrame, type ProtocolFrame, type SseFrame } from '../../../shared/stream/types.ts';
import { parseTargetStreamFrames } from '../../events/from-stream.ts';

// Deny-list: anything that is not a wrapper (`response.created` /
// `response.in_progress` / `ping`) and not terminal is treated as content-
// bearing. `ping` is a transport-level keep-alive with no content semantics, so
// its presence must not commit us out of the fast-path. Future Responses event
// types fall through as structured by default, which is safer than missing an
// allow-list entry and incorrectly triggering the fast-path expansion below.
const isStructuredResponsesEvent = (event: { type: string }): boolean =>
  event.type !== 'response.created'
  && event.type !== 'response.in_progress'
  && event.type !== 'ping'
  && !isResponsesTerminalEvent(event as ResponseStreamEvent);

// Some Responses upstreams emit the event type only via the SSE `event:`
// header and leave it off the JSON body; re-attach it so downstream sees a
// consistent shape.
const projectSseJsonEvent = (event: ResponseStreamEvent, eventName: string | undefined): SequencedResponsesStreamEvent =>
  eventName && !(event as { type?: string }).type ? ({ ...event, type: eventName } as SequencedResponsesStreamEvent) : (event as SequencedResponsesStreamEvent);

// Some Responses upstreams (notably Copilot for short prompts) take a
// "fast-path": they only emit `response.created` / `response.in_progress` and a
// terminal `response.completed` / `response.incomplete` / `response.failed`,
// skipping every content-bearing structured event. Translate / source layers
// upstream-of-here used to special-case that with cross-frame buffering. Now
// the target boundary expands the terminal in place via responsesResultToEvents
// so downstream consumers always observe one canonical full event sequence.
// `error` terminals carry no `response` payload, so we cannot expand them;
// they continue to surface as their original frame for downstream handlers.
export const responsesStreamFramesToEvents = (frames: AsyncIterable<SseFrame>): AsyncGenerator<ProtocolFrame<SequencedResponsesStreamEvent>> =>
  (async function* () {
    let sawStructured = false;
    const pending: EventFrame<SequencedResponsesStreamEvent>[] = [];

    for await (const frame of parseTargetStreamFrames<ResponseStreamEvent>(frames, {
      protocol: 'Responses',
      malformedJsonEventName: 'response',
    })) {
      if (frame.type === 'done') {
        for (const buffered of pending) yield buffered;
        pending.length = 0;
        yield doneFrame();
        return;
      }

      const event = projectSseJsonEvent(frame.data, frame.frame.event);
      const structured = isStructuredResponsesEvent(event);
      const terminal = isResponsesTerminalEvent(event);

      if (!sawStructured && terminal && !structured && 'response' in event) {
        // Fast-path: terminal arrived before any structured event. Discard the
        // pending created/in_progress frames — responsesResultToEvents will
        // re-synthesize them with consistent sequence numbers — and replace
        // the terminal with the full expanded sequence.
        pending.length = 0;
        for (const expanded of responsesResultToEvents((event as { response: ResponsesResult }).response)) yield expanded;
        sawStructured = true;
        continue;
      }

      if (!sawStructured && structured) {
        sawStructured = true;
        for (const buffered of pending) yield buffered;
        pending.length = 0;
      }

      const projected = eventFrame(event);
      if (sawStructured) {
        yield projected;
      } else {
        pending.push(projected);
      }
    }

    // Upstream ended without [DONE] or a terminal: pass through whatever we
    // buffered so downstream gets the partial sequence. Translate layer
    // detects the missing terminal and raises.
    for (const buffered of pending) yield buffered;
  })();
