import { assertEquals } from "@std/assert";
import {
  copilotModels,
  jsonResponse,
  requestApp,
  setupAppTest,
  withMockedFetch,
} from "../../test-helpers.ts";

Deno.test("/v1beta/models lists Copilot LLM models in Gemini model shape", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        {
          id: "gpt-gemini-list",
          supported_endpoints: ["/chat/completions"],
          maxPromptTokens: 12345,
          maxOutputTokens: 678,
        },
        { id: "embedding-only", supported_endpoints: ["/embeddings"] },
      ]));
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1beta/models", {
      headers: { "x-api-key": apiKey.key },
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.models, [{
      name: "models/gpt-gemini-list",
      baseModelId: "gpt-gemini-list",
      displayName: "gpt-gemini-list",
      supportedGenerationMethods: [
        "generateContent",
        "streamGenerateContent",
        "countTokens",
      ],
      inputTokenLimit: 12345,
      outputTokenLimit: 678,
      temperature: 1,
      topP: 0.95,
      topK: 40,
    }]);
  });
});

Deno.test("/v1beta/models/:modelId returns one Gemini model or Google RPC 404", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-access-token",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return jsonResponse(copilotModels([
        { id: "gpt-gemini-get", supported_endpoints: ["/v1/messages"] },
      ]));
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const found = await requestApp("/v1beta/models/gpt-gemini-get", {
      headers: { "x-api-key": apiKey.key },
    });
    assertEquals(found.status, 200);
    const model = await found.json();
    assertEquals(model.name, "models/gpt-gemini-get");
    assertEquals(model.supportedGenerationMethods, [
      "generateContent",
      "streamGenerateContent",
      "countTokens",
    ]);

    const resourceName = await requestApp(
      "/v1beta/models/models/gpt-gemini-get",
      { headers: { "x-api-key": apiKey.key } },
    );
    assertEquals(resourceName.status, 200);
    assertEquals((await resourceName.json()).name, "models/gpt-gemini-get");

    const missing = await requestApp("/v1beta/models/missing-model", {
      headers: { "x-api-key": apiKey.key },
    });
    assertEquals(missing.status, 404);
    assertEquals(await missing.json(), {
      error: {
        code: 404,
        message: "Model not found: missing-model",
        status: "NOT_FOUND",
      },
    });
  });
});

Deno.test("/v1beta/models maps upstream model-list failures to Google RPC errors", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch((request) => {
    const url = new URL(request.url);

    if (url.hostname === "update.code.visualstudio.com") {
      return jsonResponse(["1.110.1"]);
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return jsonResponse({
        token: "copilot-gemini-models-failure",
        expires_at: 4102444800,
        refresh_in: 3600,
      });
    }
    if (url.pathname === "/models") {
      return new Response("upstream unavailable", { status: 503 });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp("/v1beta/models", {
      headers: { "x-api-key": apiKey.key },
    });

    assertEquals(response.status, 503);
    assertEquals(await response.json(), {
      error: {
        code: 503,
        message: "upstream unavailable",
        status: "UNAVAILABLE",
      },
    });
  });
});
