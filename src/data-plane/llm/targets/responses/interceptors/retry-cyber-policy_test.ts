import { assertEquals } from "@std/assert";
import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../../shared/protocol/responses.ts";
import type { EmitInput } from "../../emit-types.ts";
import { eventResult } from "../../../shared/errors/result.ts";
import { jsonFrame, sseFrame } from "../../../shared/stream/types.ts";
import { withCyberPolicyRetried } from "./retry-cyber-policy.ts";

const makePayload = (): ResponsesPayload => ({
  model: "gpt-test",
  input: "hi",
  instructions: null,
  temperature: 1,
  top_p: null,
  max_output_tokens: 32,
  tools: null,
  tool_choice: "auto",
  metadata: null,
  stream: true,
  store: false,
  parallel_tool_calls: true,
});

const makeInput = (payload: ResponsesPayload): EmitInput<ResponsesPayload> => ({
  sourceApi: "responses",
  payload,
  githubToken: "github-token",
  accountType: "individual",
});

type PromiseState<T> =
  | { type: "pending" }
  | { type: "fulfilled"; value: T }
  | { type: "rejected"; error: unknown };

const promiseStateAfterMicrotasks = async <T>(
  promise: Promise<T>,
): Promise<PromiseState<T>> => {
  let state: PromiseState<T> = { type: "pending" };
  promise.then(
    (value) => {
      state = { type: "fulfilled", value };
    },
    (error) => {
      state = { type: "rejected", error };
    },
  );

  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    if (state.type !== "pending") return state;
  }

  return state;
};

const completedResponse = (): ResponsesResult => ({
  id: "resp_ok",
  object: "response",
  model: "gpt-test",
  status: "completed",
  output_text: "ok",
  output: [],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});

const upstreamCyberPolicyError = (message: string) => ({
  type: "upstream-error" as const,
  status: 400,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(
    JSON.stringify({
      error: {
        message,
        type: "invalid_request_error",
        code: "cyber_policy",
      },
    }),
  ),
});

const upstreamServerError = (message: string) => ({
  type: "upstream-error" as const,
  status: 500,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(
    JSON.stringify({
      error: {
        message,
        type: "server_error",
        code: "upstream_failed",
      },
    }),
  ),
});

Deno.test("withCyberPolicyRetried retries fatal upstream cyber policy errors five times before returning success", async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInput(payload), () => {
    attempts += 1;

    if (attempts < 6) {
      return Promise.resolve(upstreamCyberPolicyError(`blocked ${attempts}`));
    }

    return Promise.resolve(eventResult((async function* () {
      yield jsonFrame(completedResponse());
    })()));
  });

  assertEquals(attempts, 6);
  assertEquals(result.type, "events");
});

Deno.test("withCyberPolicyRetried retries fatal Responses SSE cyber policy failures before returning success", async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInput(payload), () => {
    attempts += 1;

    if (attempts < 3) {
      return Promise.resolve(eventResult((async function* () {
        yield sseFrame(
          JSON.stringify({
            type: "response.failed",
            sequence_number: 1,
            response: {
              id: `resp_blocked_${attempts}`,
              object: "response",
              model: "gpt-test",
              status: "failed",
              output: [],
              output_text: "",
              error: {
                message: "This request was flagged for cyber policy.",
                type: "invalid_request_error",
                code: "cyber_policy",
              },
            },
          }),
          "response.failed",
        );
      })()));
    }

    return Promise.resolve(eventResult((async function* () {
      yield sseFrame(
        JSON.stringify({
          type: "response.completed",
          sequence_number: 1,
          response: completedResponse(),
        }),
        "response.completed",
      );
    })()));
  });

  assertEquals(attempts, 1);
  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events result");

  const frames = [];
  for await (const frame of result.events) frames.push(frame);
  assertEquals(attempts, 3);
  assertEquals(frames.length, 1);
  assertEquals(
    frames[0],
    sseFrame(
      JSON.stringify({
        type: "response.completed",
        sequence_number: 1,
        response: completedResponse(),
      }),
      "response.completed",
    ),
  );
});

Deno.test("withCyberPolicyRetried returns successful streams without draining them", async () => {
  const payload = makePayload();
  let release!: () => void;
  let markStreamDrained!: () => void;
  const untilRelease = new Promise<void>((resolve) => release = resolve);
  const streamDrained = new Promise<"drained">((resolve) => {
    markStreamDrained = () => resolve("drained");
  });

  const resultPromise = withCyberPolicyRetried(
    makeInput(payload),
    () =>
      Promise.resolve(eventResult((async function* () {
        yield sseFrame(
          JSON.stringify({
            type: "response.output_text.delta",
            sequence_number: 1,
            delta: "ok",
          }),
          "response.output_text.delta",
        );

        markStreamDrained();
        await untilRelease;
        yield sseFrame(
          JSON.stringify({
            type: "response.completed",
            sequence_number: 2,
            response: completedResponse(),
          }),
          "response.completed",
        );
      })())),
  );

  const firstAction = await Promise.race([
    resultPromise.then(() => "returned" as const),
    streamDrained,
  ]);
  release();

  assertEquals(firstAction, "returned");
  const result = await resultPromise;
  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events result");

  const frames = [];
  for await (const frame of result.events) frames.push(frame);
  assertEquals(frames.length, 2);
});

Deno.test("withCyberPolicyRetried returns streaming results before the first upstream frame arrives", async () => {
  const payload = makePayload();
  let releaseFirstFrame!: () => void;
  const firstFrameReady = new Promise<void>((resolve) => {
    releaseFirstFrame = resolve;
  });

  const resultPromise = withCyberPolicyRetried(
    makeInput(payload),
    () =>
      Promise.resolve(eventResult((async function* () {
        await firstFrameReady;
        yield sseFrame(
          JSON.stringify({
            type: "response.completed",
            sequence_number: 1,
            response: completedResponse(),
          }),
          "response.completed",
        );
      })())),
  );

  const state = await promiseStateAfterMicrotasks(resultPromise);
  releaseFirstFrame();
  const result = await resultPromise;

  assertEquals(state.type, "fulfilled");
  assertEquals(result.type, "events");
});

Deno.test("withCyberPolicyRetried does not start another streaming retry after downstream abort", async () => {
  const payload = makePayload();
  const downstreamAbortController = new AbortController();
  let attempts = 0;
  const cyberPolicyFrame = sseFrame(
    JSON.stringify({
      type: "response.failed",
      sequence_number: 1,
      response: {
        id: "resp_blocked_after_abort",
        object: "response",
        model: "gpt-test",
        status: "failed",
        output: [],
        output_text: "",
        error: {
          message: "This request was flagged for cyber policy.",
          type: "invalid_request_error",
          code: "cyber_policy",
        },
      },
    }),
    "response.failed",
  );

  const result = await withCyberPolicyRetried(
    {
      ...makeInput(payload),
      downstreamAbortSignal: downstreamAbortController.signal,
    },
    () => {
      attempts += 1;
      return Promise.resolve(eventResult((async function* () {
        downstreamAbortController.abort();
        yield cyberPolicyFrame;
      })()));
    },
  );

  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events result");

  const frames = [];
  for await (const frame of result.events) frames.push(frame);

  assertEquals(attempts, 1);
  assertEquals(frames, [cyberPolicyFrame]);
});

Deno.test("withCyberPolicyRetried streams the final HTTP cyber policy failure after a streaming policy failure", async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInput(payload), () => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.resolve(eventResult((async function* () {
        yield sseFrame(
          JSON.stringify({
            type: "response.failed",
            sequence_number: 1,
            response: {
              id: "resp_stream_policy_failure",
              object: "response",
              model: "gpt-test",
              status: "failed",
              output: [],
              output_text: "",
              error: {
                message: "This request was flagged for cyber policy.",
                type: "invalid_request_error",
                code: "cyber_policy",
              },
            },
          }),
          "response.failed",
        );
      })()));
    }

    return Promise.resolve(upstreamCyberPolicyError(`blocked ${attempts}`));
  });

  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events result");

  const frames = [];
  for await (const frame of result.events) frames.push(frame);

  assertEquals(attempts, 11);
  assertEquals(frames.length, 1);
  const finalFrame = frames[0];
  assertEquals(finalFrame.type, "sse");
  if (finalFrame.type !== "sse") throw new Error("expected SSE frame");
  assertEquals(finalFrame.event, "response.failed");
  const finalFailure = JSON.parse(finalFrame.data);
  assertEquals(finalFailure.type, "response.failed");
  assertEquals(finalFailure.response.status, "failed");
  assertEquals(finalFailure.response.model, "gpt-test");
  assertEquals(finalFailure.response.error, {
    message: "blocked 11",
    type: "invalid_request_error",
    code: "cyber_policy",
  });
});

Deno.test("withCyberPolicyRetried streams a later HTTP upstream failure after a streaming policy failure", async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInput(payload), () => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.resolve(eventResult((async function* () {
        yield sseFrame(
          JSON.stringify({
            type: "response.failed",
            sequence_number: 1,
            response: {
              id: "resp_stream_policy_failure",
              object: "response",
              model: "gpt-test",
              status: "failed",
              output: [],
              output_text: "",
              error: {
                message: "This request was flagged for cyber policy.",
                type: "invalid_request_error",
                code: "cyber_policy",
              },
            },
          }),
          "response.failed",
        );
      })()));
    }

    return Promise.resolve(upstreamServerError("upstream failed after retry"));
  });

  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events result");

  const frames = [];
  for await (const frame of result.events) frames.push(frame);

  assertEquals(attempts, 2);
  assertEquals(frames.length, 1);
  const finalFrame = frames[0];
  assertEquals(finalFrame.type, "sse");
  if (finalFrame.type !== "sse") throw new Error("expected SSE frame");
  assertEquals(finalFrame.event, "response.failed");
  const finalFailure = JSON.parse(finalFrame.data);
  assertEquals(finalFailure.response.status, "failed");
  assertEquals(finalFailure.response.error, {
    message: "upstream failed after retry",
    type: "server_error",
    code: "upstream_failed",
  });
});

Deno.test("withCyberPolicyRetried preserves debug fields for later internal failures after a streaming policy failure", async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInput(payload), () => {
    attempts += 1;

    if (attempts === 1) {
      return Promise.resolve(eventResult((async function* () {
        yield sseFrame(
          JSON.stringify({
            type: "response.failed",
            sequence_number: 1,
            response: {
              id: "resp_stream_policy_failure",
              object: "response",
              model: "gpt-test",
              status: "failed",
              output: [],
              output_text: "",
              error: {
                message: "This request was flagged for cyber policy.",
                type: "invalid_request_error",
                code: "cyber_policy",
              },
            },
          }),
          "response.failed",
        );
      })()));
    }

    return Promise.resolve({
      type: "internal-error" as const,
      status: 502,
      error: {
        type: "internal_error" as const,
        name: "Error",
        message: "retry setup failed",
        stack: "Error: retry setup failed\n    at test",
        cause: { message: "nested" },
        source_api: "responses" as const,
        target_api: "responses" as const,
      },
    });
  });

  assertEquals(result.type, "events");
  if (result.type !== "events") throw new Error("expected events result");

  const frames = [];
  for await (const frame of result.events) frames.push(frame);

  assertEquals(attempts, 2);
  assertEquals(frames.length, 1);
  const finalFrame = frames[0];
  assertEquals(finalFrame.type, "sse");
  if (finalFrame.type !== "sse") throw new Error("expected SSE frame");
  const finalFailure = JSON.parse(finalFrame.data);
  assertEquals(finalFailure.response.error, {
    message: "retry setup failed",
    type: "internal_error",
    code: "internal_error",
    name: "Error",
    stack: "Error: retry setup failed\n    at test",
    cause: { message: "nested" },
    source_api: "responses",
    target_api: "responses",
  });
});

Deno.test("withCyberPolicyRetried returns the final cyber policy failure after exhausting retries", async () => {
  const payload = makePayload();
  let attempts = 0;

  const result = await withCyberPolicyRetried(makeInput(payload), () => {
    attempts += 1;
    return Promise.resolve(upstreamCyberPolicyError(`blocked ${attempts}`));
  });

  assertEquals(attempts, 11);
  assertEquals(result.type, "upstream-error");
  if (result.type !== "upstream-error") {
    throw new Error("expected upstream-error result");
  }
  assertEquals(
    JSON.parse(new TextDecoder().decode(result.body)).error.message,
    "blocked 11",
  );
});
