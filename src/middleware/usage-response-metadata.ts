import type { Context } from "hono";
import type { ChatCompletionResponse } from "../data-plane/llm/shared/protocol/chat-completions.ts";
import type { PerformanceTelemetryContext } from "../data-plane/shared/performance/telemetry.ts";

export interface HiddenChatStreamUsageCapture {
  usage?: ChatCompletionResponse["usage"];
}

export interface PerformanceFailureCapture {
  failed?: boolean;
  completed?: boolean;
}

export interface UsageResponseMetadata {
  usageModel?: string;
  hiddenChatStreamUsageCapture?: HiddenChatStreamUsageCapture;
  performance?: PerformanceTelemetryContext;
  performanceFailureCapture?: PerformanceFailureCapture;
}

const USAGE_RESPONSE_METADATA_CONTEXT_KEY =
  "copilotGatewayUsageResponseMetadata";

// Keep accounting metadata on Hono's per-request Context instead of smuggling it
// through Response headers. Headers are part of the client-visible HTTP
// contract; this state is an internal route-to-middleware side channel only.
export function setUsageResponseMetadata(
  c: Context,
  metadata: UsageResponseMetadata,
): void {
  const existing = getUsageResponseMetadata(c);
  c.set(USAGE_RESPONSE_METADATA_CONTEXT_KEY, { ...existing, ...metadata });
}

export function getUsageResponseMetadata(
  c: Context,
): UsageResponseMetadata | undefined {
  const value = c.get(USAGE_RESPONSE_METADATA_CONTEXT_KEY);
  return value as UsageResponseMetadata | undefined;
}
