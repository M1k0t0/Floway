import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import {
  getUsageResponseMetadata,
  setUsageResponseMetadata,
} from "./usage-response-metadata.ts";
import type { UsageResponseMetadata } from "./usage-response-metadata.ts";
import type { PerformanceTelemetryContext } from "../data-plane/shared/performance/telemetry.ts";

const performance = {
  keyId: "key_a",
  model: "claude-opus-4.7",
  sourceApi: "messages" as const,
  targetApi: "responses" as const,
  stream: true,
  runtimeLocation: "SJC",
};

Deno.test("usage response metadata uses Context state without mutating response headers", async () => {
  const app = new Hono();
  let usageMetadata: UsageResponseMetadata | undefined;
  let performanceMetadata: PerformanceTelemetryContext | undefined;

  app.use("*", async (c, next) => {
    await next();
    usageMetadata = getUsageResponseMetadata(c);
    performanceMetadata = usageMetadata?.performance;
  });

  app.get("/", (c) => {
    setUsageResponseMetadata(c, {
      usageModel: "claude-opus-4.7",
      performance,
    });
    return new Response("ok");
  });

  const response = await app.request("/");

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("x-copilot-gateway-usage-model"), null);
  assertEquals(
    response.headers.get("x-copilot-gateway-hidden-chat-usage-capture"),
    null,
  );
  assertEquals(
    response.headers.get("x-copilot-gateway-performance-context"),
    null,
  );
  assertEquals(usageMetadata?.usageModel, "claude-opus-4.7");
  assertEquals(usageMetadata?.performance, performance);
  assertEquals(performanceMetadata, performance);
});
