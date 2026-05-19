import type {
  MessagesResponse,
  MessagesThinkingDisplay,
} from "../../../shared/protocol/messages.ts";
import { normalizeModelName } from "../../../../../shared/model-name.ts";
import type { StreamFrame } from "../../../shared/stream/types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";

const CLAUDE_VERSION_PATTERN = /(?:^|-)(\d+)\.(\d+)(?=-|$)/;

const isMessagesThinkingDisplay = (
  value: unknown,
): value is MessagesThinkingDisplay =>
  value === "omitted" || value === "summarized" || value === "full";

const isClaudeVersionAtLeast = (
  model: string,
  major: number,
  minor: number,
): boolean => {
  const normalized = normalizeModelName(model);
  if (!normalized.startsWith("claude-")) return false;

  const match = normalized.match(CLAUDE_VERSION_PATTERN);
  if (!match) return false;

  const modelMajor = Number(match[1]);
  const modelMinor = Number(match[2]);

  return modelMajor > major ||
    (modelMajor === major && modelMinor >= minor);
};

export const resolveMessagesDownstreamThinkingDisplay = (
  ctx: EmitToMessagesInput,
): MessagesThinkingDisplay | undefined => {
  const display = ctx.payload.thinking?.display;
  if (display !== undefined) {
    // Request JSON is not runtime-validated before target interceptors; leave
    // unknown display values untouched so upstream, not this workaround, owns
    // rejecting or accepting future values.
    return isMessagesThinkingDisplay(display) ? display : undefined;
  }

  return isClaudeVersionAtLeast(ctx.payload.model, 4, 7)
    ? "omitted"
    : "summarized";
};

const omitThinkingTextFromStreamFrame = (
  frame: StreamFrame<MessagesResponse>,
): StreamFrame<MessagesResponse> | undefined => {
  if (frame.type === "json") {
    return {
      ...frame,
      data: {
        ...frame.data,
        content: frame.data.content.map((block) =>
          block.type === "thinking" ? { ...block, thinking: "" } : block
        ),
      },
    };
  }

  const data = frame.data.trim();
  if (!data || data === "[DONE]") return frame;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return frame;
  }

  if (
    event.type === "content_block_start" &&
    (event.content_block as Record<string, unknown> | undefined)?.type ===
      "thinking"
  ) {
    return {
      ...frame,
      data: JSON.stringify({
        ...event,
        content_block: {
          ...(event.content_block as Record<string, unknown>),
          thinking: "",
        },
      }),
    };
  }

  if (
    event.type === "content_block_delta" &&
    (event.delta as Record<string, unknown> | undefined)?.type ===
      "thinking_delta"
  ) {
    return undefined;
  }

  return frame;
};

const omitThinkingTextFromStreamFrames = async function* (
  frames: AsyncIterable<StreamFrame<MessagesResponse>>,
): AsyncGenerator<StreamFrame<MessagesResponse>> {
  for await (const frame of frames) {
    const omitted = omitThinkingTextFromStreamFrame(frame);
    if (omitted) yield omitted;
  }
};

/**
 * Workaround for Copilot/Claude turns that go silent during long extended
 * thinking, then surface to clients as `API Error: Network connection lost`,
 * `Stream idle timeout`, or a short no-tool-call turn. The direct Copilot
 * references below document a roughly 60s HTTP response-idle boundary in
 * GitHub Copilot paths; the related client reports show the same user-visible
 * stall/no-output failure shape in official Copilot and Claude Code clients.
 *
 * The native Copilot Messages target is the boundary where `thinking.display`
 * controls whether the upstream emits token-level `thinking_delta` SSE while
 * the model is reasoning. Our Copilot probes found Claude 4.7 defaults to
 * omitted display, while 4.6/4.5 default to summarized; forcing summarized
 * upstream keeps data flowing during thinking and avoids the idle gap. To keep
 * downstream omitted semantics, this target interceptor removes only thinking
 * text/deltas after the upstream attempt and preserves every `signature` byte;
 * the same probes showed blank thinking text is accepted, while any signature
 * tampering makes the next Messages request fail with 400. Those probes justify
 * the request/response mechanics here; the public references justify why this
 * workaround exists.
 *
 * References:
 * Direct Copilot HTTP idle-boundary reports:
 * - https://github.com/ericc-ch/copilot-api/issues/223
 * - https://github.com/copilot-extensions/user-feedback/issues/2
 * Related official-client and downstream symptoms:
 * - https://github.com/microsoft/vscode-copilot-release/issues/7640
 * - https://github.com/github/copilot-cli/issues/686
 * - https://github.com/github/copilot-cli/issues/1614
 * - https://github.com/anthropics/claude-code/issues/46987
 * - https://github.com/anthropics/claude-code/issues/50477
 */
export const withThinkingDisplayPromoted: TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
> = async (ctx, run) => {
  const downstreamDisplay = resolveMessagesDownstreamThinkingDisplay(ctx);
  const thinking = ctx.payload.thinking;
  const hasActiveThinking = !!thinking && thinking.type !== "disabled";
  const shouldExposeOmitted = hasActiveThinking &&
    downstreamDisplay === "omitted";

  if (
    hasActiveThinking && downstreamDisplay !== undefined &&
    downstreamDisplay !== "full"
  ) {
    ctx.payload.thinking = {
      ...thinking,
      display: "summarized",
    };
  }

  const result = await run();

  if (!shouldExposeOmitted || result.type !== "events") return result;
  return { ...result, events: omitThinkingTextFromStreamFrames(result.events) };
};
