import type { Context } from "hono";
import {
  copilotFetch,
  isCopilotTokenFetchError,
} from "../../../../../shared/copilot.ts";
import type { MessagesPayload } from "../../../shared/protocol/messages.ts";
import { withAccountFallback } from "../../../../shared/account-pool/fallback.ts";
import {
  messagesModelResolutionIntent,
  resolveModelForRequest,
} from "../../../shared/models/resolve-model.ts";

export const countTokens = async (c: Context) => {
  try {
    const payload = await c.req.json<MessagesPayload>();
    const rawBeta = c.req.header("anthropic-beta");
    const intent = messagesModelResolutionIntent(payload, rawBeta);
    const modelId = await resolveModelForRequest(payload.model, intent);

    const resp = await withAccountFallback(
      modelId,
      ({ account }) => {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = modelId;
        return copilotFetch(
          "/v1/messages/count_tokens",
          { method: "POST", body: JSON.stringify(attemptPayload) },
          account.token,
          account.accountType,
        );
      },
    );

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        "content-type": resp.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e: unknown) {
    if (isCopilotTokenFetchError(e)) {
      return new Response(e.body, {
        status: e.status,
        headers: e.headers,
      });
    }

    const msg = e instanceof Error ? e.message : String(e);
    console.error("Error counting tokens:", msg);
    return c.json({
      error: {
        type: "invalid_request_error",
        message: `Failed to count tokens: ${msg}`,
      },
    }, 400);
  }
};
