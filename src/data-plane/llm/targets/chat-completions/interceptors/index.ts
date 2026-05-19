import type { ChatCompletionResponse } from "../../../shared/protocol/chat-completions.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitInput } from "../../emit-types.ts";
import type { ChatCompletionsPayload } from "../../../shared/protocol/chat-completions.ts";
import { withUsageStreamOptionsIncluded } from "./include-usage-stream-options.ts";

export const chatCompletionsTargetInterceptors = [
  withUsageStreamOptionsIncluded,
] satisfies readonly TargetInterceptor<
  EmitInput<ChatCompletionsPayload>,
  ChatCompletionResponse
>[];
