import { assertEquals } from "@std/assert";
import { clearCopilotTokenCache } from "../../shared/copilot.ts";
import { initRepo } from "../../repo/index.ts";
import { InMemoryRepo } from "../../repo/memory.ts";
import type { GitHubAccount } from "../../repo/types.ts";
import { clearModelsCache, findModelInModels, loadModels } from "./cache.ts";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const githubAccount: GitHubAccount = {
  token: "ghu_models_cache_test",
  accountType: "individual",
  user: {
    id: 1001,
    login: "models-cache-test",
    name: "Models Cache Test",
    avatar_url: "https://example.com/models-cache.png",
  },
};

const setupModelsCacheTest = async (): Promise<void> => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.github.saveAccount(githubAccount.user.id, githubAccount);
  clearModelsCache();
  await clearCopilotTokenCache();
};

const loadModelList = async () => {
  const result = await loadModels(
    githubAccount.token,
    githubAccount.accountType,
  );
  assertEquals(result.type, "models");
  if (result.type !== "models") throw result.error;
  return result.data;
};

const withMockedFetch = async <T>(
  handler: (request: Request) => Promise<Response> | Response,
  run: () => Promise<T>,
): Promise<T> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: FetchInput, init?: FetchInit) => {
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input, init);
    return Promise.resolve(handler(request));
  };

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const copilotModels = (
  models: Array<{ id: string; supported_endpoints?: string[] }>,
) => ({
  object: "list",
  data: models.map((model) => ({
    id: model.id,
    name: model.id,
    version: "1",
    object: "model",
    supported_endpoints: model.supported_endpoints ?? [],
    capabilities: {
      family: "test",
      type: "chat",
      limits: {},
      supports: {},
    },
  })),
});

function withFakeNow<T>(times: number[], run: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  let index = 0;
  Date.now = () => times[Math.min(index++, times.length - 1)];
  return run().finally(() => {
    Date.now = originalNow;
  });
}

function withMutableNow<T>(
  initial: number,
  run: (setNow: (value: number) => void) => Promise<T>,
): Promise<T> {
  const originalNow = Date.now;
  let now = initial;
  Date.now = () => now;
  return run((value) => {
    now = value;
  }).finally(() => {
    Date.now = originalNow;
  });
}

Deno.test("models cache uses L1 cache for 120s and L2 cache for 600s", async () => {
  await setupModelsCacheTest();

  let modelsFetches = 0;

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
      modelsFetches++;
      return jsonResponse({
        object: "list",
        data: [{
          id: "claude-sonnet-4",
          name: "claude-sonnet-4",
          version: "1",
          object: "model",
          supported_endpoints: ["/v1/messages"],
          capabilities: {
            family: "claude",
            type: "chat",
            limits: {},
            supports: {},
          },
        }],
      });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    await withFakeNow([0, 60_000, 130_000], async () => {
      const first = await loadModelList();
      const second = await loadModelList();
      const third = await loadModelList();

      assertEquals(first.data[0].id, "claude-sonnet-4");
      assertEquals(second.data[0].id, "claude-sonnet-4");
      assertEquals(third.data[0].id, "claude-sonnet-4");
    });
  });

  assertEquals(modelsFetches, 1);
});

Deno.test("models cache refreshes upstream after repo-backed cache expires", async () => {
  await setupModelsCacheTest();

  let modelsFetches = 0;

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
      modelsFetches++;
      return jsonResponse({
        object: "list",
        data: [{
          id: `model-${modelsFetches}`,
          name: `model-${modelsFetches}`,
          version: "1",
          object: "model",
          supported_endpoints: ["/responses"],
          capabilities: {
            family: "gpt",
            type: "chat",
            limits: {},
            supports: {},
          },
        }],
      });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    await withFakeNow([0, 610_000], async () => {
      const first = await loadModelList();
      const second = await loadModelList();

      assertEquals(first.data[0].id, "model-1");
      assertEquals(second.data[0].id, "model-2");
    });
  });

  assertEquals(modelsFetches, 2);
});

Deno.test("models cache uses stale data after soft expiry on switchable errors until hard expiry", async () => {
  await setupModelsCacheTest();

  let modelsFetches = 0;

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
      modelsFetches++;
      if (modelsFetches === 1) {
        return jsonResponse(copilotModels([
          { id: "stale-model", supported_endpoints: ["/v1/messages"] },
        ]));
      }
      return jsonResponse({ error: { message: "rate limited" } }, 429);
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    await withMutableNow(0, async (setNow) => {
      const fresh = await loadModels(
        githubAccount.token,
        githubAccount.accountType,
      );
      assertEquals(fresh.type, "models");
      if (fresh.type === "models") {
        assertEquals(fresh.stale, false);
        assertEquals(fresh.data.data[0].id, "stale-model");
      }

      setNow(610_000);
      const stale = await loadModels(
        githubAccount.token,
        githubAccount.accountType,
      );
      assertEquals(stale.type, "models");
      if (stale.type === "models") {
        assertEquals(stale.stale, true);
        assertEquals(stale.data.data[0].id, "stale-model");
      }

      setNow(7_201_000);
      const expired = await loadModels(
        githubAccount.token,
        githubAccount.accountType,
      );
      assertEquals(expired.type, "error");
    });
  });

  assertEquals(modelsFetches, 3);
});

Deno.test("findModel applies dated Claude aliases only after exact model misses", async () => {
  await setupModelsCacheTest();

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
      return jsonResponse({
        object: "list",
        data: [
          {
            id: "claude-haiku-4.5-20251001",
            name: "claude-haiku-4.5-20251001",
            version: "1",
            object: "model",
            supported_endpoints: ["/chat/completions"],
            capabilities: {
              family: "claude",
              type: "chat",
              limits: {},
              supports: {},
            },
          },
          {
            id: "claude-haiku-4.5",
            name: "claude-haiku-4.5",
            version: "1",
            object: "model",
            supported_endpoints: ["/v1/messages"],
            capabilities: {
              family: "claude",
              type: "chat",
              limits: {},
              supports: {},
            },
          },
          {
            id: "claude-opus-4.7",
            name: "claude-opus-4.7",
            version: "1",
            object: "model",
            supported_endpoints: ["/v1/messages"],
            capabilities: {
              family: "claude",
              type: "chat",
              limits: {},
              supports: {},
            },
          },
          {
            id: "claude-sonnet-4.5",
            name: "claude-sonnet-4.5",
            version: "1",
            object: "model",
            supported_endpoints: ["/responses"],
            capabilities: {
              family: "claude",
              type: "chat",
              limits: {},
              supports: {},
            },
          },
        ],
      });
    }

    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const models = await loadModelList();
    const exact = findModelInModels(models, "claude-haiku-4.5-20251001");
    const fallbackDotted = findModelInModels(
      models,
      "claude-opus-4.7-20251001",
    );
    const fallbackDashed = findModelInModels(
      models,
      "claude-sonnet-4-5-20251001",
    );

    assertEquals(exact?.id, "claude-haiku-4.5-20251001");
    assertEquals(fallbackDotted?.id, "claude-opus-4.7");
    assertEquals(fallbackDashed?.id, "claude-sonnet-4.5");
  });
});
