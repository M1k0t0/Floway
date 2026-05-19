import { assertEquals } from "@std/assert";
import { initEnv } from "../../../runtime/env.ts";
import { runtimeLocationFromRequest } from "./telemetry.ts";

Deno.test("runtimeLocationFromRequest prefers Cloudflare colo", () => {
  initEnv(() => "fallback-location");
  const request = new Request("https://example.test");
  Object.defineProperty(request, "cf", { value: { colo: "SJC" } });

  assertEquals(runtimeLocationFromRequest(request), "SJC");
});

Deno.test("runtimeLocationFromRequest uses env fallback outside Cloudflare", () => {
  initEnv((name) => name === "RUNTIME_LOCATION" ? "deno-us-west" : "");

  assertEquals(
    runtimeLocationFromRequest(new Request("https://example.test")),
    "deno-us-west",
  );
});

Deno.test("runtimeLocationFromRequest uses unknown without colo or env", () => {
  initEnv(() => "");

  assertEquals(
    runtimeLocationFromRequest(new Request("https://example.test")),
    "unknown",
  );
});
