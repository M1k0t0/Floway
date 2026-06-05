import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { type ProtocolFrame, type SseFrame, sseFrame } from '@floway-dev/protocols/common';

interface ChatCompletionsSseFrameOptions {
  includeUsageChunk: boolean;
}

const isUsageOnlyChunk = (frame: ProtocolFrame<ChatCompletionsStreamEvent>): boolean =>
  frame.type === 'event' && Array.isArray(frame.event.choices) && frame.event.choices.length === 0 && frame.event.usage !== undefined;

export const chatCompletionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<ChatCompletionsStreamEvent>, options: ChatCompletionsSseFrameOptions): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  if (!options.includeUsageChunk && isUsageOnlyChunk(frame)) return null;
  return sseFrame(JSON.stringify(frame.event));
};
