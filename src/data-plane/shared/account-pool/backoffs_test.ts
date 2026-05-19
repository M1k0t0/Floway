import { assertEquals } from "@std/assert";
import {
  clearAccountModelBackoffs,
  clearModelBackoffs,
  isAccountModelBackedOff,
  listAccountModelBackoffs,
  markAccountModelBackoff,
} from "./backoffs.ts";
import { initRepo } from "../../../repo/index.ts";
import { InMemoryRepo } from "../../../repo/memory.ts";

Deno.test("account model backoffs store each account/model independently", async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await markAccountModelBackoff(101, "gpt-5.3-codex", 500, 1_000);
  await markAccountModelBackoff(101, "claude-sonnet-4.5", 429, 2_000);

  assertEquals(await listAccountModelBackoffs([101], 3_000), [
    {
      accountId: 101,
      model: "claude-sonnet-4.5",
      status: 429,
      expiresAt: 3_602_000,
    },
    {
      accountId: 101,
      model: "gpt-5.3-codex",
      status: 500,
      expiresAt: 3_601_000,
    },
  ]);
});

Deno.test("account model backoffs expire without refreshing TTL", async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await markAccountModelBackoff(101, "gpt-5.3-codex", 500, 1_000);

  assertEquals(
    await isAccountModelBackedOff(101, "gpt-5.3-codex", 3_600_999),
    true,
  );
  assertEquals(
    await isAccountModelBackedOff(101, "gpt-5.3-codex", 3_601_000),
    false,
  );
  assertEquals(await listAccountModelBackoffs([101], 3_601_000), []);
});

Deno.test("account model backoffs can clear one model or one account", async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await markAccountModelBackoff(101, "gpt-5.3-codex", 500, 1_000);
  await markAccountModelBackoff(102, "gpt-5.3-codex", 500, 1_000);
  await markAccountModelBackoff(101, "claude-sonnet-4.5", 429, 1_000);

  await clearModelBackoffs([101, 102], "gpt-5.3-codex");
  assertEquals(await listAccountModelBackoffs([101, 102], 2_000), [
    {
      accountId: 101,
      model: "claude-sonnet-4.5",
      status: 429,
      expiresAt: 3_601_000,
    },
  ]);

  await clearAccountModelBackoffs(101);
  assertEquals(await listAccountModelBackoffs([101, 102], 2_000), []);
});
