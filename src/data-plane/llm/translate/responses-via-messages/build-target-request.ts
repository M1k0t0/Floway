import type { MessagesTargetPayload } from "../../../../lib/messages-types.ts";
import type { ResponsesPayload } from "../../../../lib/responses-types.ts";
import { translateResponsesToMessages } from "../../../../lib/translate/responses-to-messages.ts";
import type { ModelCapabilities } from "../../shared/models/get-model-capabilities.ts";

export const buildTargetRequest = (
  payload: ResponsesPayload,
  capabilities: ModelCapabilities,
): Promise<MessagesTargetPayload> =>
  translateResponsesToMessages(payload, {
    fallbackMaxOutputTokens: capabilities.maxOutputTokens,
  });
