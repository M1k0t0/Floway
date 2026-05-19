import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../../shared/protocol/responses.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitInput } from "../../emit-types.ts";

/**
 * Copilot does not expose a compatible `service_tier` control on native or
 * translated Responses handling. Strip it only after planning has committed to
 * the Responses target so source-side behavior and accounting still see the
 * caller's original request.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/f7835a44f06976cab874700e4d94a5f5c0379369
 * - https://platform.openai.com/docs/api-reference/responses/create
 */
export const withServiceTierStripped: TargetInterceptor<
  EmitInput<ResponsesPayload>,
  ResponsesResult
> = async (ctx, run) => {
  const { service_tier: _, ...payload } = ctx.payload;
  ctx.payload = payload;

  return await run();
};
