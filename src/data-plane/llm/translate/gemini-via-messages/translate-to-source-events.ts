import type {
  GeminiFinishReason,
  GeminiPart,
  GeminiStreamEvent,
  GeminiUsageMetadata,
} from "../../../../lib/gemini-types.ts";
import type { MessagesStreamEventData } from "../../../../lib/messages-types.ts";
import { protocolEventsUntilTerminal } from "../../shared/stream/protocol-algebra.ts";
import { eventFrame, type ProtocolFrame } from "../../shared/stream/types.ts";
import { upstreamMessagesStreamAlgebra } from "../upstream-protocol.ts";

interface ToolUseState {
  id: string;
  name: string;
  input: Record<string, unknown>;
  partialJson: string;
}

interface GeminiViaMessagesStreamState {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  pendingThoughtSignature?: string;
  toolUses: Record<number, ToolUseState>;
}

const createState = (): GeminiViaMessagesStreamState => ({
  inputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  toolUses: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const appendPendingThoughtSignature = (
  state: GeminiViaMessagesStreamState,
  signature: string,
): void => {
  state.pendingThoughtSignature = `${
    state.pendingThoughtSignature ?? ""
  }${signature}`;
};

const attachPendingThoughtSignature = (
  part: GeminiPart,
  state: GeminiViaMessagesStreamState,
): GeminiPart => {
  if (state.pendingThoughtSignature === undefined) return part;

  const signedPart = {
    ...part,
    thoughtSignature: state.pendingThoughtSignature,
  };
  state.pendingThoughtSignature = undefined;
  return signedPart;
};

const geminiResponse = (
  parts: GeminiPart[],
  finishReason?: GeminiFinishReason,
  usageMetadata?: GeminiUsageMetadata,
): GeminiStreamEvent => ({
  candidates: [{
    index: 0,
    content: { role: "model", parts },
    ...(finishReason !== undefined ? { finishReason } : {}),
  }],
  ...(usageMetadata !== undefined ? { usageMetadata } : {}),
});

const parseToolInput = (toolUse: ToolUseState): Record<string, unknown> => {
  if (!toolUse.partialJson) return toolUse.input;

  let parsed: unknown;
  try {
    parsed = JSON.parse(toolUse.partialJson) as unknown;
  } catch (error) {
    throw new Error(
      "Upstream Messages tool use input was not valid JSON.",
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("Upstream Messages tool use input must be a JSON object.");
  }

  return parsed;
};

const toolUsePart = (
  toolUse: ToolUseState,
  state: GeminiViaMessagesStreamState,
): GeminiPart =>
  attachPendingThoughtSignature({
    functionCall: {
      id: toolUse.id,
      name: toolUse.name,
      args: parseToolInput(toolUse),
    },
  }, state);

const messagesStopReasonToGemini = (
  stopReason: Extract<
    MessagesStreamEventData,
    { type: "message_delta" }
  >["delta"]["stop_reason"],
): GeminiFinishReason => {
  switch (stopReason) {
    case "end_turn":
    case "tool_use":
    case "stop_sequence":
      return "STOP";
    case "max_tokens":
      return "MAX_TOKENS";
    case "refusal":
      return "SAFETY";
    default:
      return "OTHER";
  }
};

// Anthropic's input_tokens excludes cache reads and cache creation; Gemini's
// promptTokenCount is an inclusive total like OpenAI's prompt_tokens. Fold all
// three Anthropic buckets into the Gemini total, then surface cache reads
// separately as cachedContentTokenCount.
const mapUsage = (
  state: GeminiViaMessagesStreamState,
  usage?: Extract<MessagesStreamEventData, { type: "message_delta" }>["usage"],
): GeminiUsageMetadata | undefined => {
  if (!usage) return undefined;

  const promptTokenCount = state.inputTokens +
    state.cacheReadInputTokens +
    state.cacheCreationInputTokens;
  const candidatesTokenCount = usage.output_tokens;

  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount: promptTokenCount + candidatesTokenCount,
    ...(state.cacheReadInputTokens > 0
      ? { cachedContentTokenCount: state.cacheReadInputTokens }
      : {}),
  };
};

const throwOnMessagesFatalEvent = (event: MessagesStreamEventData): void => {
  if (event.type !== "error") return;

  throw new Error(
    `Upstream Messages stream error: ${event.error.type}: ${event.error.message}`,
    { cause: event },
  );
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const state = createState();

  for await (
    const event of protocolEventsUntilTerminal(
      frames,
      upstreamMessagesStreamAlgebra,
    )
  ) {
    throwOnMessagesFatalEvent(event);

    switch (event.type) {
      case "message_start":
        state.inputTokens = event.message.usage.input_tokens;
        state.cacheReadInputTokens =
          event.message.usage.cache_read_input_tokens ?? 0;
        state.cacheCreationInputTokens =
          event.message.usage.cache_creation_input_tokens ?? 0;
        break;

      case "content_block_start":
        if (event.content_block.type === "tool_use") {
          state.toolUses[event.index] = {
            id: event.content_block.id,
            name: event.content_block.name,
            input: event.content_block.input,
            partialJson: "",
          };
          break;
        }

        if (event.content_block.type === "redacted_thinking") {
          appendPendingThoughtSignature(state, event.content_block.data);
          break;
        }

        if (
          event.content_block.type === "thinking" &&
          event.content_block.thinking.length > 0
        ) {
          yield eventFrame(geminiResponse([{
            text: event.content_block.thinking,
            thought: true,
          }]));
          break;
        }

        if (
          event.content_block.type === "text" &&
          event.content_block.text.length > 0
        ) {
          yield eventFrame(geminiResponse([
            attachPendingThoughtSignature(
              { text: event.content_block.text },
              state,
            ),
          ]));
        }
        break;

      case "content_block_delta":
        switch (event.delta.type) {
          case "thinking_delta":
            if (event.delta.thinking.length > 0) {
              yield eventFrame(geminiResponse([{
                text: event.delta.thinking,
                thought: true,
              }]));
            }
            break;
          case "signature_delta":
            appendPendingThoughtSignature(state, event.delta.signature);
            break;
          case "text_delta":
            if (event.delta.text.length > 0) {
              yield eventFrame(geminiResponse([
                attachPendingThoughtSignature(
                  { text: event.delta.text },
                  state,
                ),
              ]));
            }
            break;
          case "input_json_delta":
            if (state.toolUses[event.index]) {
              state.toolUses[event.index].partialJson +=
                event.delta.partial_json;
            }
            break;
          default:
            break;
        }
        break;

      case "content_block_stop": {
        const toolUse = state.toolUses[event.index];
        if (toolUse) {
          delete state.toolUses[event.index];
          yield eventFrame(geminiResponse([toolUsePart(toolUse, state)]));
        }
        break;
      }

      case "message_delta": {
        const parts = state.pendingThoughtSignature !== undefined
          ? [attachPendingThoughtSignature({ text: "" }, state)]
          : [];
        yield eventFrame(geminiResponse(
          parts,
          messagesStopReasonToGemini(event.delta.stop_reason),
          mapUsage(state, event.usage),
        ));
        break;
      }

      case "message_stop":
      case "ping":
        break;
    }
  }
};
