import type { ChatCompletionsPayload } from "../../../../lib/chat-completions-types.ts";
import type { MessagesTargetPayload } from "../../../../lib/messages-types.ts";
import { translateChatCompletionsToMessages } from "../../../../lib/translate/chat-completions-to-messages.ts";
import { fetchRemoteImage } from "../../../../lib/translate/remote-images.ts";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";

export const buildTargetRequest = async (
  payload: ChatCompletionsPayload,
  capabilities: ModelCapabilities,
): Promise<MessagesTargetPayload> =>
  await translateChatCompletionsToMessages(payload, {
    loadRemoteImage: fetchRemoteImage,
    fallbackMaxOutputTokens: capabilities.maxOutputTokens,
  });
