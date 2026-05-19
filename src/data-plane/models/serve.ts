// GET /v1/models, /api/models — proxy to Copilot models endpoint

import type { Context } from "hono";
import { isCopilotTokenFetchError } from "../../shared/copilot.ts";
import { ModelsFetchError } from "./cache.ts";
import { loadMergedModels } from "./load.ts";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorResponse = (error: unknown): Response | null => {
  if (error instanceof ModelsFetchError) {
    return new Response(error.body, {
      status: error.status,
      headers: error.headers,
    });
  }

  if (isCopilotTokenFetchError(error)) {
    return new Response(error.body, {
      status: error.status,
      headers: error.headers,
    });
  }

  return null;
};

export const models = async (c: Context) => {
  try {
    return Response.json(await loadMergedModels());
  } catch (e: unknown) {
    const upstreamErrorResponse = errorResponse(e);
    if (upstreamErrorResponse) return upstreamErrorResponse;

    return c.json(
      { error: { message: errorMessage(e), type: "api_error" } },
      502,
    );
  }
};
