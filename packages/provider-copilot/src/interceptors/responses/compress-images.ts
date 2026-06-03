import { targetSizeForResponsesChat } from '../image-size.ts';
import type { ResponsesInputImage } from '@floway-dev/protocols/responses';
import { compressImageDataUrlToWebp, isBase64ImageDataUrl } from '@floway-dev/provider';
import type { ProviderResponsesInterceptor } from '@floway-dev/provider';

// Recompresses every inline base64 image in the outgoing Responses payload to
// WebP before the Copilot upstream call. Images appear both as `input_image`
// parts inside message content and inside `function_call_output` outputs
// (multimodal tool results, e.g. a screenshot tool). Remote https image
// references are left untouched.
export const withInlineImagesCompressed: ProviderResponsesInterceptor = async (ctx, _request, run) => {
  const targets: ResponsesInputImage[] = [];
  if (Array.isArray(ctx.payload.input)) {
    for (const item of ctx.payload.input) {
      const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (part.type === 'input_image' && isBase64ImageDataUrl(part.image_url)) targets.push(part);
      }
    }
  }

  if (targets.length > 0) {
    const targetSize = targetSizeForResponsesChat(ctx.upstreamModel.id);
    await Promise.all(
      targets.map(async target => {
        target.image_url = await compressImageDataUrlToWebp(target.image_url, targetSize);
      }),
    );
  }

  return await run();
};
