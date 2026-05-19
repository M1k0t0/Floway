import type { MessagesResponse } from "../../../shared/protocol/messages.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitToMessagesInput } from "../emit.ts";
import { withBetaHeaderFixed } from "./fix-beta-header.ts";
import { withThinkingDisplayPromoted } from "./promote-thinking-display.ts";
import { withEagerInputStreamingStripped } from "./strip-eager-input-streaming.ts";

export const messagesTargetInterceptors = [
  withThinkingDisplayPromoted,
  withBetaHeaderFixed,
  withEagerInputStreamingStripped,
] satisfies readonly TargetInterceptor<
  EmitToMessagesInput,
  MessagesResponse
>[];
