import type {
  GeminiCandidate,
  GeminiGenerateContentResponse,
  GeminiPart,
  GeminiStreamEvent,
} from "../../../shared/protocol/gemini.ts";
import { protocolEventsUntilTerminal } from "../../../shared/stream/protocol-algebra.ts";
import type { ProtocolFrame } from "../../../shared/stream/types.ts";
import { geminiSourceStreamAlgebra, isGeminiErrorEvent } from "./protocol.ts";

const hasOnlyTextShape = (part: GeminiPart): boolean =>
  part.inlineData === undefined && part.functionCall === undefined &&
  part.functionResponse === undefined && part.fileData === undefined &&
  part.executableCode === undefined && part.codeExecutionResult === undefined;

const isMergeableTextPart = (part: GeminiPart): boolean =>
  part.text !== undefined && part.thought !== true &&
  part.thoughtSignature === undefined && hasOnlyTextShape(part);

const appendPart = (parts: GeminiPart[], part: GeminiPart): void => {
  const previous = parts.at(-1);
  if (previous && isMergeableTextPart(previous) && isMergeableTextPart(part)) {
    previous.text = `${previous.text}${part.text}`;
    return;
  }

  parts.push({ ...part });
};

const mergeCandidate = (
  candidates: Map<number, GeminiCandidate>,
  incoming: GeminiCandidate,
): void => {
  const existing = candidates.get(incoming.index);
  if (!existing) {
    const candidate: GeminiCandidate = {
      index: incoming.index,
      content: {
        ...(incoming.content.role !== undefined
          ? { role: incoming.content.role }
          : {}),
        parts: [],
      },
      ...(incoming.finishReason !== undefined
        ? { finishReason: incoming.finishReason }
        : {}),
    };
    for (const part of incoming.content.parts) {
      appendPart(candidate.content.parts, part);
    }
    candidates.set(incoming.index, candidate);
    return;
  }

  if (incoming.content.role !== undefined) {
    existing.content.role = incoming.content.role;
  }
  for (const part of incoming.content.parts) {
    appendPart(existing.content.parts, part);
  }
  if (incoming.finishReason !== undefined) {
    existing.finishReason = incoming.finishReason;
  }
};

export const collectGeminiProtocolEventsToResponse = async (
  frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
): Promise<GeminiGenerateContentResponse> => {
  const candidates = new Map<number, GeminiCandidate>();
  const response: GeminiGenerateContentResponse = {};

  for await (
    const event of protocolEventsUntilTerminal(
      frames,
      geminiSourceStreamAlgebra,
    )
  ) {
    if (isGeminiErrorEvent(event)) {
      throw new Error(`${event.error.status}: ${event.error.message}`, {
        cause: event,
      });
    }

    for (const candidate of event.candidates ?? []) {
      mergeCandidate(candidates, candidate);
    }

    if (event.modelVersion !== undefined) {
      response.modelVersion = event.modelVersion;
    }
    if (event.responseId !== undefined) response.responseId = event.responseId;
    if (event.usageMetadata !== undefined) {
      response.usageMetadata = event.usageMetadata;
    }
  }

  const mergedCandidates = [...candidates.values()].sort((a, b) =>
    a.index - b.index
  );
  if (mergedCandidates.length > 0) response.candidates = mergedCandidates;

  return response;
};
