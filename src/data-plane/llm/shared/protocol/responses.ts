import type { ResponseInputReasoning, ResponseOutputReasoning, ResponseStreamEvent } from '../../../shared/protocol/responses.ts';

export type ResponsesStreamEvent = ResponseStreamEvent & {
  sequence_number?: number;
};

// Sibling of ResponsesStreamEvent for sequences synthesized inside the
// gateway (from-result expansion, from-stream projection), where the
// sequence number is always present.
export type SequencedResponsesStreamEvent = ResponseStreamEvent & {
  sequence_number: number;
};

// Either side of the Responses reasoning round trip: input echoes a prior
// turn's reasoning back in, output emits the current turn's reasoning. Shape
// is identical aside from the type tag's role.
export type ResponsesReasoningItem = ResponseInputReasoning | ResponseOutputReasoning;

export const RESPONSES_MISSING_TERMINAL_MESSAGE = 'Responses stream ended without a terminal event.';

export const isResponsesTerminalEvent = (event: Pick<ResponseStreamEvent, 'type'>): boolean =>
  event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed' || event.type === 'error';
