import type {
  MessagesStreamEventData,
  MessagesTextCitation,
} from "../../../../shared/protocol/messages.ts";
import {
  type ProtocolFrame,
  type SseFrame,
  sseFrame,
} from "../../../shared/stream/types.ts";
import { protocolEventsUntilTerminal } from "../../../shared/stream/protocol-algebra.ts";
import { messagesSourceStreamAlgebra } from "./protocol.ts";
import type { TokenUsage } from "../../../../../repo/types.ts";
import { hasTokenUsage } from "../../../../shared/telemetry/usage.ts";

export const messagesProtocolEventToSSEFrame = (
  event: MessagesStreamEventData,
): SseFrame =>
  sseFrame(JSON.stringify(messagesEventToSsePayload(event)), event.type);

const citationToSsePayload = (citation: MessagesTextCitation): unknown =>
  citation.type === "search_result_location"
    ? {
      type: citation.type,
      source: citation.url,
      title: citation.title,
      search_result_index: citation.search_result_index,
      start_block_index: citation.start_block_index,
      end_block_index: citation.end_block_index,
      ...(citation.cited_text ? { cited_text: citation.cited_text } : {}),
    }
    : citation;

const citationsToSsePayload = (
  citations?: MessagesTextCitation[],
): unknown[] | undefined => citations?.map(citationToSsePayload);

const messagesEventToSsePayload = (event: MessagesStreamEventData): unknown => {
  if (event.type === "content_block_start") {
    const { content_block } = event;
    return content_block.type === "text" && content_block.citations
      ? {
        ...event,
        content_block: {
          ...content_block,
          citations: citationsToSsePayload(content_block.citations),
        },
      }
      : event;
  }

  if (event.type !== "content_block_delta") return event;

  const { delta } = event;
  if (delta.type === "citations_delta") {
    return {
      ...event,
      delta: {
        ...delta,
        citation: citationToSsePayload(delta.citation),
      },
    };
  }

  if (delta.type === "text_delta" && delta.citations) {
    return {
      ...event,
      delta: {
        ...delta,
        citations: citationsToSsePayload(delta.citations),
      },
    };
  }

  return event;
};

interface MessagesProtocolEventsToSSEFramesOptions {
  onUsage: (usage: TokenUsage) => Promise<void> | void;
}

const mergeMessageStartUsage = (
  usage: TokenUsage,
  event: MessagesStreamEventData,
): boolean => {
  if (event.type !== "message_start") return false;

  const eventUsage = event.message.usage;
  const cacheReadTokens = eventUsage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = eventUsage.cache_creation_input_tokens ?? 0;
  usage.inputTokens = eventUsage.input_tokens + cacheReadTokens +
    cacheCreationTokens;
  usage.outputTokens = eventUsage.output_tokens;
  usage.cacheReadTokens = cacheReadTokens;
  usage.cacheCreationTokens = cacheCreationTokens;
  return usage.inputTokens > 0;
};

const mergeMessageDeltaUsage = (
  usage: TokenUsage,
  event: MessagesStreamEventData,
  gotInputFromStart: boolean,
): void => {
  if (event.type !== "message_delta" || !event.usage) return;

  if (!gotInputFromStart && event.usage.input_tokens !== undefined) {
    const cacheReadTokens = event.usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = event.usage.cache_creation_input_tokens ?? 0;
    usage.inputTokens = event.usage.input_tokens + cacheReadTokens +
      cacheCreationTokens;
    usage.cacheReadTokens = cacheReadTokens;
    usage.cacheCreationTokens = cacheCreationTokens;
  }
  usage.outputTokens = event.usage.output_tokens;
};

export const messagesProtocolEventsToSSEFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
  options: MessagesProtocolEventsToSSEFramesOptions,
): AsyncGenerator<SseFrame> {
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let gotInputFromStart = false;

  for await (
    const event of protocolEventsUntilTerminal(
      frames,
      messagesSourceStreamAlgebra,
    )
  ) {
    gotInputFromStart = mergeMessageStartUsage(usage, event) ||
      gotInputFromStart;
    mergeMessageDeltaUsage(usage, event, gotInputFromStart);
    if (event.type === "message_stop" && hasTokenUsage(usage)) {
      await options.onUsage(usage);
    }

    yield messagesProtocolEventToSSEFrame(event);
  }
};
