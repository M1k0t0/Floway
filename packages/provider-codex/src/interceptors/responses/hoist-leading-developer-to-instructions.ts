import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesInputItem, ResponsesInputMessage } from '@floway-dev/protocols/responses';

const isInputMessage = (item: ResponsesInputItem): item is ResponsesInputMessage =>
  item.type === 'message';

const developerInstructionText = (item: ResponsesInputMessage): string | null => {
  const { content } = item;
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type !== 'input_text' && part.type !== 'output_text') return null;
    parts.push(part.text);
  }
  return parts.join('\n\n');
};

const mergeInstructions = (existing: string | null | undefined, additions: readonly string[]): string | null | undefined => {
  const parts: string[] = [];
  if (typeof existing === 'string' && existing.length > 0) parts.push(existing);
  for (const addition of additions) {
    if (addition.length > 0) parts.push(addition);
  }
  return parts.length > 0 ? parts.join('\n\n') : existing;
};

export const hoistLeadingDeveloperToInstructions = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const { input } = ctx.payload;
  if (!Array.isArray(input)) return await run();

  const hoisted: string[] = [];
  let prefixEnd = 0;
  for (const item of input) {
    if (!isInputMessage(item) || item.role !== 'developer') break;
    const text = developerInstructionText(item);
    if (text === null) break;
    hoisted.push(text);
    prefixEnd++;
  }

  if (prefixEnd > 0) {
    const next = {
      ...ctx.payload,
      input: input.slice(prefixEnd),
    };
    const instructions = mergeInstructions(ctx.payload.instructions, hoisted);
    if (instructions !== undefined) next.instructions = instructions;
    ctx.payload = next;
  }

  return await run();
};
