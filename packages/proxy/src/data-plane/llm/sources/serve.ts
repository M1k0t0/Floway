import type { Context } from 'hono';

import { executeLlmSourcePlan } from './execution.ts';
import { createHttpRequestContext } from './request-context.ts';
import { type LlmEndpointName, type LlmServeFailure, LlmServeFailureError, type LlmSourceRuntime, type LlmSourceTraits } from './traits.ts';

// HTTP adapter for every LLM source endpoint. `prepare` owns parsing and real
// runtime construction; this layer binds Hono to prepare/respond, keeps a
// provisional failure runtime, and gates non-streaming output-item commits.
// The Hono-free execution core owns stored-item lookup, provider selection,
// per-attempt execution, and output-item wrapping.

export const serveLlm = <TItems, TEvent>(
  traits: LlmSourceTraits<TItems, TEvent>,
  endpointName: LlmEndpointName,
) => {
  const endpoint = traits.endpoints[endpointName];
  if (!endpoint) throw new Error(`LLM source does not define the '${endpointName}' endpoint.`);

  return async (c: Context): Promise<Response> => {
    // Provisional runtime lets failures thrown before prepare returns render with telemetry.
    let runtime: LlmSourceRuntime = {
      request: createHttpRequestContext(c, undefined, false),
      wantsStream: false,
      downstreamAbortController: undefined,
    };

    try {
      const plan = await endpoint.prepare(c);
      if (plan instanceof Response) return plan;
      runtime = plan;

      const { result, commitForNonStreaming } = await executeLlmSourcePlan(plan, failure => traits.renderFailure(failure, endpointName));

      // `respond` reports only whether the response was produced; this adapter
      // owns commit timing. `commitForNonStreaming` exists solely on a successful
      // non-streaming attempt — it flushes the buffered rows once the body is
      // known good (streaming rows were already written per frame). A failed
      // response leaves the buffer unflushed.
      const { success, response } = await endpoint.respond({ c, result, runtime });
      if (success) await commitForNonStreaming?.();
      return response;
    } catch (error) {
      const failure: LlmServeFailure = error instanceof LlmServeFailureError ? error.failure : { kind: 'internal', error };
      return (await endpoint.respond({ c, result: traits.renderFailure(failure, endpointName), runtime })).response;
    }
  };
};
