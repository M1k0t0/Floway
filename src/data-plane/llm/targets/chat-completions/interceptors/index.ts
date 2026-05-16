import type { ChatCompletionResponse } from "../../../../../lib/chat-completions-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToChatCompletionsInput } from "../emit.ts";
import { withUsageStreamOptionsIncluded } from "./include-usage-stream-options.ts";

export const chatCompletionsTargetInterceptors = [
  withUsageStreamOptionsIncluded,
] satisfies readonly TargetInterceptor<
  EmitToChatCompletionsInput,
  ChatCompletionResponse
>[];
