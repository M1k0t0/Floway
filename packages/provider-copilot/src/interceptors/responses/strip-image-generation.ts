import type { ResponsesBoundaryCtx } from './types.ts';

/**
 * Copilot's `/responses` endpoint rejects public `image_generation` tool
 * entries, so strip them once the planner has committed to a native Responses
 * target on a Copilot upstream. Other Responses-capable upstreams (e.g. OpenAI
 * direct) accept the entry and must continue to see it. Other public hosted
 * and deferred tools (`web_search`, `tool_search`, `namespace`) are left in
 * place: Codex relies on `tool_search` / `namespace` for client-executed
 * deferred tool discovery, and Copilot accepts `web_search`.
 *
 * References:
 * - https://platform.openai.com/docs/guides/tools-image-generation
 * - https://github.com/openai/codex/blob/9f42c89c0112771dc29100a6f3fc904049b2655f/codex-rs/tools/src/tool_spec.rs#L17-L27
 * - https://github.com/caozhiyuan/copilot-api/blob/5d37d5b1ac6566c935a5c26d046396ee5fa423cc/src/routes/responses/handler.ts#L187-L204
 */
export const withImageGenerationStripped = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const { payload } = ctx;
  let removedTool = false;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.filter(tool => {
      const drop = tool.type === 'image_generation';
      removedTool ||= drop;
      return !drop;
    });

    if (tools.length === 0) {
      delete payload.tools;
    } else {
      payload.tools = tools;
    }
  }

  const toolChoice = payload.tool_choice;
  if (typeof toolChoice === 'object' && toolChoice !== null && toolChoice.type === 'image_generation') {
    delete payload.tool_choice;
  } else if (removedTool && toolChoice === 'required' && (!Array.isArray(payload.tools) || payload.tools.length === 0)) {
    delete payload.tool_choice;
  }

  return await run();
};
