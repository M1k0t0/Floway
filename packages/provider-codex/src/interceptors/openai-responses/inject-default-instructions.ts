import type { OpenAIResponsesBoundaryCtx } from './types.ts';
import { downstreamRequestsCodexResponsesLite, hasLeadingCodexResponsesLiteTools } from '../../responses-lite.ts';

// ChatGPT-subscription catalog models reject missing or empty `instructions`.
// Native and translated callers may omit the field, so the provider supplies a
// neutral value at its boundary. Other values remain upstream-owned validation.
// https://github.com/im4codes/imcodes/blob/5f769d933dfd679e3a4d670183b0384a1baf62cd/src/agent/providers/codex-sdk.ts#L560-L579
export const withDefaultInstructions = <T extends { instructions?: string | null }>(body: T): T =>
  body.instructions === undefined || body.instructions === null || body.instructions === ''
    ? { ...body, instructions: "You're a helpful assistant." }
    : body;

export const injectDefaultInstructions = async <TResult>(
  ctx: OpenAIResponsesBoundaryCtx,
  _env: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  if (
    !downstreamRequestsCodexResponsesLite(ctx.headers, ctx.payload)
    || !hasLeadingCodexResponsesLiteTools(ctx.payload.input)
  ) {
    ctx.payload = withDefaultInstructions(ctx.payload);
  }
  return await run();
};
