import { assertEquals, assertExists } from "@std/assert";
import {
  copilotModels,
  jsonResponse,
  requestApp,
  setupAppTest,
  withMockedFetch,
} from "../../../../../test-helpers.ts";

Deno.test("/v1beta/models/:model:countTokens translates Gemini request to Messages count_tokens", async () => {
  const { apiKey } = await setupAppTest();
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(async (request) => {
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
        { id: "claude-count", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (url.pathname === "/v1/messages/count_tokens") {
      upstreamBody = JSON.parse(await request.text()) as Record<
        string,
        unknown
      >;
      return jsonResponse({ input_tokens: 17 });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp(
      "/v1beta/models/claude-count:countTokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey.key,
        },
        body: JSON.stringify({
          generateContentRequest: {
            systemInstruction: { parts: [{ text: "system" }] },
            contents: [{ role: "user", parts: [{ text: "hello" }] }],
            generationConfig: { maxOutputTokens: 123 },
          },
        }),
      },
    );

    assertEquals(response.status, 200);
    assertEquals(await response.json(), { totalTokens: 17 });
  });

  assertExists(upstreamBody);
  assertEquals(upstreamBody.model, "claude-count");
  assertEquals(upstreamBody.system, "system");
  assertEquals(upstreamBody.max_tokens, 123);
  assertEquals(upstreamBody.messages, [{
    role: "user",
    content: [{ type: "text", text: "hello" }],
  }]);
});

Deno.test("/v1beta/models/:model:countTokens supports top-level contents", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(async (request) => {
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
        { id: "claude-count-top", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (url.pathname === "/v1/messages/count_tokens") {
      return jsonResponse({ total_tokens: 19 });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp(
      "/v1beta/models/claude-count-top:countTokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey.key,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        }),
      },
    );

    assertEquals(response.status, 200);
    assertEquals(await response.json(), { totalTokens: 19 });
  });
});

Deno.test("/v1beta/models/:model:countTokens internal failures include debug fields", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(async (request) => {
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
        { id: "claude-count-invalid", supported_endpoints: ["/v1/messages"] },
      ]));
    }
    if (url.pathname === "/v1/messages/count_tokens") {
      return jsonResponse({ unexpected: true });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp(
      "/v1beta/models/claude-count-invalid:countTokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey.key,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        }),
      },
    );

    assertEquals(response.status, 502);
    const body = await response.json();
    assertEquals(body.error.code, 502);
    assertEquals(body.error.status, "UNAVAILABLE");
    assertEquals(body.error.type, "internal_error");
    assertEquals(body.error.name, "Error");
    assertEquals(body.error.source_api, "gemini");
    assertExists(body.error.stack);
  });
});

Deno.test("/v1beta/models/:model:countTokens maps model-list failures to Google RPC errors", async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(async (request) => {
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
      return new Response("models unavailable", { status: 503 });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const response = await requestApp(
      "/v1beta/models/claude-count-models-down:countTokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey.key,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        }),
      },
    );

    assertEquals(response.status, 503);
    assertEquals(await response.json(), {
      error: {
        code: 503,
        message: "models unavailable",
        status: "UNAVAILABLE",
      },
    });
  });
});
