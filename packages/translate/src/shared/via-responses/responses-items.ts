import { parseToolArgumentsObject } from '../messages/tool-arguments.ts';
import { packReasoningSignature, responsesReasoningToMessagesBlock, unpackReasoningSignature } from '../messages-and-responses/reasoning.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsReasoningItem, ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiContent, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesAssistantContentBlock, MessagesMessage, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesInputItem, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export type ResponsesItemMapper = (
  item: ResponsesInputItem,
) => ResponsesInputItem | null | Promise<ResponsesInputItem | null>;

export type ResponsesItemVisitor = (item: ResponsesInputItem) => void | Promise<void>;

// Stream side splits id-rewrite from persistence. The id rewrite is a sync,
// per-frame transform — every appearance of a Responses item carrier in the
// source stream is fed through `idMapper` and the rewritten id flows out
// without delaying SSE. Persistence sits behind `onItemFinalized`, which is
// awaited once per upstream id at the protocol-specific terminal frame, before
// the view yields that frame. Whether the handler writes the row immediately
// or buffers it for a later commit is the caller's concern; the view only
// guarantees the callback resolves before the frame flows on.
export type ResponsesItemIdMapper = (upstreamId: string, itemType: string) => string;

export type ResponsesItemFinalizedHandler = (
  originalItem: ResponsesInputItem,
  newId: string,
) => void | Promise<void>;

// A view onto a source protocol that projects Responses items in and out
// of the source's payload (request) and stream (response).
//
// Payload side: visit (read-only iteration) and map (1-to-1 rewrite or
// 1-to-null drop). The mapper is asymmetric with the stream side because
// payload-side rewrites consume the whole structure at once.
//
// `mapAsResponsesItems` ownership invariant: callers pass items they own —
// the per-attempt `structuredClone` of the payload is the sole isolation —
// so the mapper builds fresh container arrays/objects but reuses input
// elements directly and must not defensively deep-clone them.
//
// Stream side: id-only rewrite is per-frame and synchronous; the row write
// is per-item and async, fired through `onItemFinalized` at the carrier's
// terminal frame.
// The mapped form of a source-items type is always its source minus the
// top-level `readonly`: the view owns the per-attempt payload clone, so it
// hands back a freely-mutable container. The mapped type is therefore derived
// rather than carried as a second generic. Distributing over unions keeps
// `Mutable<string | readonly ResponsesInputItem[]>` equal to
// `string | ResponsesInputItem[]`.
export type Mutable<T> = T extends readonly (infer E)[] ? E[] : T;

export interface ResponsesItemsView<TSourceItems, TStreamFrame = unknown> {
  visitAsResponsesItems(sourceItems: TSourceItems, visitor: ResponsesItemVisitor): Promise<void>;
  mapAsResponsesItems(sourceItems: TSourceItems, mapper: ResponsesItemMapper): Promise<Mutable<TSourceItems>>;
  streamMapIdAsResponsesItems(
    frames: AsyncIterable<TStreamFrame>,
    idMapper: ResponsesItemIdMapper,
    onItemFinalized?: ResponsesItemFinalizedHandler,
  ): AsyncGenerator<TStreamFrame>;
}

// ---------------------------------------------------------------------------
// Responses source
// ---------------------------------------------------------------------------

export const responsesItemsView = {
  visitAsResponsesItems: async (
    input: string | readonly ResponsesInputItem[],
    visitor: ResponsesItemVisitor,
  ): Promise<void> => {
    if (typeof input === 'string') return;
    for (const item of input) await visitor(item);
  },
  mapAsResponsesItems: async (
    input: string | readonly ResponsesInputItem[],
    mapper: ResponsesItemMapper,
  ): Promise<string | ResponsesInputItem[]> => {
    if (typeof input === 'string') return input;

    const out: ResponsesInputItem[] = [];
    for (const item of input) {
      const mapped = await mapper(item);
      if (mapped !== null) out.push(mapped);
    }
    return out;
  },
  async *streamMapIdAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
    idMapper: ResponsesItemIdMapper,
    onItemFinalized?: ResponsesItemFinalizedHandler,
  ): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    // `seenItemTypes` records the item type for every upstream id we have
    // mapped via an item-bearing frame. Delta events only carry `item_id`
    // and no type, so we look the type up here before re-invoking idMapper,
    // which requires a known item type to allocate fresh ids. A delta
    // referencing an unknown id is upstream protocol corruption and passes
    // through unchanged rather than allocating a phantom row.
    const seenItemTypes = new Map<string, string>();
    const finalized = new Set<string>();

    for await (const frame of frames) {
      if (frame.type !== 'event') {
        yield frame;
        continue;
      }
      const event = frame.event;

      if (event.type === 'response.output_item.added') {
        const upstreamId = itemId(event.item);
        if (upstreamId === null) {
          yield frame;
          continue;
        }
        seenItemTypes.set(upstreamId, event.item.type);
        const newId = idMapper(upstreamId, event.item.type);
        yield eventFrame({ ...event, item: { ...event.item, id: newId } });
        continue;
      }

      if (event.type === 'response.output_item.done') {
        const upstreamId = itemId(event.item);
        if (upstreamId === null) {
          yield frame;
          continue;
        }
        seenItemTypes.set(upstreamId, event.item.type);
        const newId = idMapper(upstreamId, event.item.type);
        if (onItemFinalized && !finalized.has(upstreamId)) {
          finalized.add(upstreamId);
          await onItemFinalized(event.item as unknown as ResponsesInputItem, newId);
        }
        yield eventFrame({ ...event, item: { ...event.item, id: newId } });
        continue;
      }

      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        const output: ResponsesInputItem[] = [];
        for (const item of event.response.output) {
          const upstreamId = itemId(item);
          if (upstreamId === null) {
            output.push(item as unknown as ResponsesInputItem);
            continue;
          }
          seenItemTypes.set(upstreamId, item.type);
          const newId = idMapper(upstreamId, item.type);
          if (onItemFinalized && !finalized.has(upstreamId)) {
            finalized.add(upstreamId);
            await onItemFinalized(item as unknown as ResponsesInputItem, newId);
          }
          output.push({ ...(item as unknown as ResponsesInputItem), id: newId });
        }
        yield eventFrame({
          ...event,
          response: { ...event.response, output: output as typeof event.response.output },
        });
        return;
      }

      if (event.type === 'response.failed' || event.type === 'error') {
        yield frame;
        return;
      }

      const refId = (event as { item_id?: unknown }).item_id;
      if (typeof refId === 'string') {
        const knownType = seenItemTypes.get(refId);
        if (knownType === undefined) {
          yield frame;
          continue;
        }
        const newId = idMapper(refId, knownType);
        yield eventFrame({ ...event, item_id: newId } as ResponsesStreamEvent);
        continue;
      }
      yield frame;
    }
  },
} satisfies ResponsesItemsView<string | readonly ResponsesInputItem[], ProtocolFrame<ResponsesStreamEvent>>;

const itemId = (item: { id?: unknown }): string | null => {
  const id = item.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

// ---------------------------------------------------------------------------
// Messages source
// ---------------------------------------------------------------------------

export const messagesViaResponsesItemsView = {
  visitAsResponsesItems: async (
    messages: readonly MessagesMessage[],
    visitor: ResponsesItemVisitor,
  ): Promise<void> => {
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;

      for (const block of message.content) {
        const carrier = reasoningCarrier(block);
        if (carrier === null) continue;

        await visitor({
          type: 'reasoning',
          id: carrier.id,
          summary: carrier.thinking ? [{ type: 'summary_text', text: carrier.thinking }] : [],
          ...(carrier.encryptedContent ? { encrypted_content: carrier.encryptedContent } : {}),
        });
      }
    }
  },
  mapAsResponsesItems: async (
    messages: readonly MessagesMessage[],
    mapper: ResponsesItemMapper,
  ): Promise<MessagesMessage[]> => {
    const out: MessagesMessage[] = [];
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        out.push(message);
        continue;
      }

      const content: MessagesAssistantContentBlock[] = [];
      for (const block of message.content) {
        // A `${enc}@${id}` carrier never originates from a native Anthropic
        // Messages model — Anthropic only emits opaque signatures with no `@`.
        // It exists only because our own messages-via-responses translation
        // packed a Responses reasoning id into the signature, or the session
        // previously passed through another gateway using the same interop
        // layout. A foreign gateway's id is not one of our stored ids, so it
        // does not resolve here and the block is forwarded untouched.
        const carrier = reasoningCarrier(block);
        if (carrier === null) {
          content.push(block);
          continue;
        }

        const mapped = await mapper({
          type: 'reasoning',
          id: carrier.id,
          summary: carrier.thinking ? [{ type: 'summary_text', text: carrier.thinking }] : [],
          ...(carrier.encryptedContent ? { encrypted_content: carrier.encryptedContent } : {}),
        });
        if (mapped === null) continue;
        const projected = responsesItemToMessagesAssistantBlock(mapped);
        if (projected !== null) content.push(projected);
      }

      out.push({ role: 'assistant', content });
    }
    return out;
  },
  // Messages thinking blocks carry the gateway-encoded Responses reasoning
  // id via signature_delta, which arrives separately from content_block_start
  // and the thinking text deltas. The signature is buffered until
  // content_block_stop so the mapper sees the final accumulated thinking text
  // when reconstructing the virtual reasoning item; mid-block frames stream
  // straight through.
  //
  // Per Anthropic's streaming spec, signature_delta must arrive before
  // content_block_stop for the same block index — see
  // https://platform.claude.com/docs/en/docs/build-with-claude/streaming
  // and the SDKs at anthropics/anthropic-sdk-python and
  // anthropics/anthropic-sdk-typescript. We attack any violation: a stray
  // signature_delta after stop, or a thinking_delta after stop, is treated
  // as upstream protocol corruption and surfaced as a 5xx via plain throw.
  async *streamMapIdAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
    idMapper: ResponsesItemIdMapper,
    onItemFinalized?: ResponsesItemFinalizedHandler,
  ): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
    interface BlockState {
      thinking: string;
      signature?: string;
    }
    const blocks = new Map<number, BlockState>();
    const finalized = new Set<string>();

    for await (const frame of frames) {
      if (frame.type !== 'event') {
        yield frame;
        continue;
      }
      const event = frame.event;

      if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
        blocks.set(event.index, { thinking: event.content_block.thinking });
        yield frame;
        continue;
      }

      // A redacted_thinking block carries the packed `${enc}@${id}` value in
      // `data` with no deltas — rewrite the stored id inline and finalize the
      // reasoning row here. A native opaque blob (no `@`) is passed through.
      if (event.type === 'content_block_start' && event.content_block.type === 'redacted_thinking') {
        const { id: upstreamId, encryptedContent } = unpackReasoningSignature(event.content_block.data);
        if (upstreamId === null) {
          yield frame;
          continue;
        }
        const newId = idMapper(upstreamId, 'reasoning');
        if (onItemFinalized && !finalized.has(upstreamId)) {
          finalized.add(upstreamId);
          await onItemFinalized(
            { type: 'reasoning', id: upstreamId, summary: [], ...(encryptedContent ? { encrypted_content: encryptedContent } : {}) },
            newId,
          );
        }
        yield eventFrame({ ...event, content_block: { type: 'redacted_thinking', data: packReasoningSignature(newId, encryptedContent) } });
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
        const state = blocks.get(event.index);
        if (state === undefined) {
          throw new Error(`Messages stream invariant violated: thinking_delta for index ${event.index} arrived without an open thinking block`);
        }
        state.thinking += event.delta.thinking;
        yield frame;
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta.type === 'signature_delta') {
        const state = blocks.get(event.index);
        if (state === undefined) {
          // Either the block isn't a thinking block (no state opened) or
          // it was closed already. Pass through unrewritten; only thinking
          // blocks carry gateway-encoded reasoning ids.
          yield frame;
          continue;
        }
        state.signature = event.delta.signature;
        continue;
      }

      if (event.type === 'content_block_stop') {
        const state = blocks.get(event.index);
        blocks.delete(event.index);
        if (state?.signature !== undefined) {
          const { id: upstreamId, encryptedContent } = unpackReasoningSignature(state.signature);
          if (upstreamId === null) {
            // Opaque upstream signature (e.g. Anthropic's native encrypted
            // reasoning) — preserve verbatim so the client can replay it.
            yield eventFrame({
              type: 'content_block_delta',
              index: event.index,
              delta: { type: 'signature_delta', signature: state.signature },
            });
          } else {
            const newId = idMapper(upstreamId, 'reasoning');
            const originalItem: ResponsesInputItem = {
              type: 'reasoning',
              id: upstreamId,
              summary: state.thinking ? [{ type: 'summary_text', text: state.thinking }] : [],
              ...(encryptedContent ? { encrypted_content: encryptedContent } : {}),
            };
            if (onItemFinalized && !finalized.has(upstreamId)) {
              finalized.add(upstreamId);
              await onItemFinalized(originalItem, newId);
            }
            // Re-pack against the stored id the client should echo next turn,
            // preserving the opaque content untouched.
            yield eventFrame({
              type: 'content_block_delta',
              index: event.index,
              delta: { type: 'signature_delta', signature: packReasoningSignature(newId, encryptedContent) },
            });
          }
        }
        yield frame;
        continue;
      }

      yield frame;
    }
  },
} satisfies ResponsesItemsView<readonly MessagesMessage[], ProtocolFrame<MessagesStreamEvent>>;

// A reasoning block echoed back by a Messages client carries the packed
// `${encrypted_content}@${id}` value in `thinking.signature` or
// `redacted_thinking.data`. Returns the unpacked id only when the carrier was
// issued by this gateway; a native upstream signature (no `@`) has no
// stored id to rewrite and is left untouched.
const reasoningCarrier = (block: MessagesAssistantContentBlock): { id: string; encryptedContent: string; thinking: string } | null => {
  const carrier = block.type === 'thinking' ? block.signature : block.type === 'redacted_thinking' ? block.data : undefined;
  if (carrier === undefined) return null;

  const { id, encryptedContent } = unpackReasoningSignature(carrier);
  if (id === null) return null;

  return { id, encryptedContent, thinking: block.type === 'thinking' ? block.thinking : '' };
};

const responsesItemToMessagesAssistantBlock = (item: ResponsesInputItem): MessagesAssistantContentBlock | null => {
  switch (item.type) {
  case 'reasoning':
    return responsesReasoningToMessagesBlock(item);
  case 'message': {
    if (item.role !== 'assistant') return null;
    const text = responsesMessageOutputText(item);
    return text ? { type: 'text', text } : null;
  }
  case 'function_call':
    return { type: 'tool_use', id: item.call_id, name: item.name, input: parseToolArgumentsObject(item.arguments) };
  case 'custom_tool_call':
    return { type: 'tool_use', id: item.call_id, name: item.name, input: { input: item.input } };
  default:
    throw new Error(`Cannot project Responses ${item.type} item into a Messages assistant content block`);
  }
};

const responsesMessageOutputText = (item: Extract<ResponsesInputItem, { type: 'message' }>): string => {
  if (typeof item.content === 'string') return item.content;
  return item.content
    .filter((part): part is Extract<typeof part, { text: string }> => 'text' in part)
    .map(part => part.text)
    .join('');
};

// ---------------------------------------------------------------------------
// Chat Completions source
// ---------------------------------------------------------------------------

export const chatCompletionsViaResponsesItemsView = {
  visitAsResponsesItems: async (
    messages: readonly ChatCompletionsMessage[],
    visitor: ResponsesItemVisitor,
  ): Promise<void> => {
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.reasoning_items?.length) continue;

      for (const item of message.reasoning_items) {
        if (!item.id) continue;
        await visitor({ type: 'reasoning', id: item.id, summary: item.summary ?? [] });
      }
    }
  },
  mapAsResponsesItems: async (
    messages: readonly ChatCompletionsMessage[],
    mapper: ResponsesItemMapper,
  ): Promise<ChatCompletionsMessage[]> => {
    const out: ChatCompletionsMessage[] = [];
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.reasoning_items?.length) {
        out.push(message);
        continue;
      }

      const reasoningItems: ChatCompletionsReasoningItem[] = [];
      for (const item of message.reasoning_items) {
        if (!item.id) {
          reasoningItems.push(item);
          continue;
        }
        const mapped = await mapper({ type: 'reasoning', id: item.id, summary: item.summary ?? [] });
        if (mapped === null) continue;
        if (mapped.type !== 'reasoning') throw new Error(`Cannot project Responses ${mapped.type} item into Chat reasoning_items`);
        reasoningItems.push({ type: 'reasoning', id: mapped.id, summary: mapped.summary });
      }

      out.push({
        ...message,
        reasoning_items: reasoningItems.length > 0 ? reasoningItems : null,
      });
    }
    return out;
  },
  // Native Chat upstreams emit `reasoning_items` exactly once per item, in
  // the chunk carrying the output_item.done analogue, with the full summary
  // text. We treat each appearance as the finalizing one and dedupe via the
  // `finalized` set, so a misbehaving upstream that streams the same id
  // across chunks still produces a single row (first chunk's content wins —
  // accepted limitation; native upstreams don't hit this path).
  async *streamMapIdAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
    idMapper: ResponsesItemIdMapper,
    onItemFinalized?: ResponsesItemFinalizedHandler,
  ): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
    const finalized = new Set<string>();

    for await (const frame of frames) {
      if (frame.type !== 'event') {
        yield frame;
        continue;
      }
      const chunk = frame.event;
      const rewritten = await Promise.all(chunk.choices.map(async choice => {
        const reasoningItems = choice.delta.reasoning_items;
        if (!reasoningItems?.length) return { choice, mutated: false };

        let mutated = false;
        const out: ChatCompletionsReasoningItem[] = [];
        for (const item of reasoningItems) {
          if (!item.id) {
            out.push(item);
            continue;
          }
          const newId = idMapper(item.id, 'reasoning');
          if (onItemFinalized && !finalized.has(item.id)) {
            finalized.add(item.id);
            await onItemFinalized(
              { type: 'reasoning', id: item.id, summary: item.summary ?? [] },
              newId,
            );
          }
          mutated = true;
          out.push({ type: 'reasoning', id: newId, summary: item.summary });
        }

        if (!mutated) return { choice, mutated: false };
        return {
          choice: { ...choice, delta: { ...choice.delta, reasoning_items: out.length > 0 ? out : null } },
          mutated: true,
        };
      }));

      if (!rewritten.some(entry => entry.mutated)) {
        yield frame;
        continue;
      }
      yield eventFrame({ ...chunk, choices: rewritten.map(entry => entry.choice) });
    }
  },
} satisfies ResponsesItemsView<readonly ChatCompletionsMessage[], ProtocolFrame<ChatCompletionsStreamEvent>>;

// ---------------------------------------------------------------------------
// Gemini source
// ---------------------------------------------------------------------------

// Placeholder view. Gemini does not yet have a reasoning-id / signature
// carrier in its protocol, so there is nothing to project. The empty
// implementations let `gemini/serve.ts` go through the uniform stored-items
// ceremony without branching on protocol; when Gemini gains signature
// support, fill these in and the rest of the pipeline keeps working.
export const geminiViaResponsesItemsView = {
  visitAsResponsesItems: async (
    _contents: readonly GeminiContent[],
    _visitor: ResponsesItemVisitor,
  ): Promise<void> => {},
  mapAsResponsesItems: async (
    contents: readonly GeminiContent[],
    _mapper: ResponsesItemMapper,
  ): Promise<GeminiContent[]> => [...contents],
  async *streamMapIdAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
    _idMapper: ResponsesItemIdMapper,
    _onItemFinalized?: ResponsesItemFinalizedHandler,
  ): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
    for await (const frame of frames) yield frame;
  },
} satisfies ResponsesItemsView<readonly GeminiContent[], ProtocolFrame<GeminiStreamEvent>>;
