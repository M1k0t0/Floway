// POST /v1/embeddings — forward embedding requests to Copilot

import type { Context } from "hono";
import {
  copilotFetch,
  isCopilotTokenFetchError,
} from "../../shared/copilot.ts";
import { withAccountFallback } from "../shared/account-pool/fallback.ts";
import { setUsageResponseMetadata } from "../../middleware/usage-response-metadata.ts";

interface EmbeddingsRequestBody {
  model?: unknown;
  input?: unknown;
  [key: string]: unknown;
}

const prepareEmbeddingsRequest = (body: string) => {
  let model = "unknown";
  let usageModel: string | undefined;

  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { body, model, usageModel };
    }

    const request = parsed as EmbeddingsRequestBody;
    if (typeof request.model === "string") {
      model = request.model;
      usageModel = request.model;
    }

    if (typeof request.input !== "string") return { body, model, usageModel };

    // OpenAI-compatible clients may send scalar string input, but Copilot's
    // upstream /embeddings endpoint currently returns 400 unless text input is
    // wrapped as an array. This belongs at the embeddings boundary so invalid
    // JSON and already-array inputs remain transparent to upstream.
    // References:
    // https://platform.openai.com/docs/api-reference/embeddings/create
    // https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L21
    // https://github.com/BerriAI/litellm/blob/c8fb77f119ad69a80f5fde088efd3a1aa77f458b/litellm/proxy/proxy_server.py#L7826-L7839
    return {
      body: JSON.stringify({ ...request, input: [request.input] }),
      model,
      usageModel,
    };
  } catch {
    // Let upstream preserve the request-shape error; fallback simply has no model signal.
    return { body, model, usageModel };
  }
};

export const embeddings = async (c: Context) => {
  try {
    const request = prepareEmbeddingsRequest(await c.req.text());

    const resp = await withAccountFallback(
      request.model,
      ({ account }) =>
        copilotFetch(
          "/embeddings",
          { method: "POST", body: request.body },
          account.token,
          account.accountType,
        ),
    );

    const response = new Response(resp.body, {
      status: resp.status,
      headers: {
        "content-type": resp.headers.get("content-type") ?? "application/json",
      },
    });
    setUsageResponseMetadata(c, {
      usageModel: request.usageModel,
    });
    return response;
  } catch (e: unknown) {
    if (isCopilotTokenFetchError(e)) {
      return new Response(e.body, {
        status: e.status,
        headers: e.headers,
      });
    }

    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: { message, type: "api_error" } }, 502);
  }
};
