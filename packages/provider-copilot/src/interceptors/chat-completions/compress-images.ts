import { targetSizeForResponsesChat } from '../image-size.ts';
import type { CopilotChatCompletionsBoundaryInterceptor } from './types.ts';
import type { ChatCompletionsContentPart, ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';
import { isBase64ImageDataUrl, memoizedDataUrlCompressor } from '@floway-dev/provider';

type ChatCompletionsImagePart = Extract<ChatCompletionsContentPart, { type: 'image_url' }>;

// Recompresses every inline base64 image (`data:image/*;base64,...` in an
// `image_url` part) in the outgoing Chat Completions payload to WebP before
// the Copilot upstream call. Remote https image references are left untouched.
export const withInlineImagesCompressed: CopilotChatCompletionsBoundaryInterceptor = async (ctx, _request, run) => {
  const targets: ChatCompletionsImagePart[] = [];
  for (const message of ctx.payload.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url' && isBase64ImageDataUrl(part.image_url.url)) targets.push(part);
    }
  }

  if (targets.length > 0) {
    const compress = memoizedDataUrlCompressor(targetSizeForResponsesChat(ctx.model.id));
    const compressedUrls = new Map<ChatCompletionsImagePart, string>();
    await Promise.all(
      targets.map(async target => {
        compressedUrls.set(target, await compress(target.image_url.url));
      }),
    );
    ctx.payload = {
      ...ctx.payload,
      messages: ctx.payload.messages.map((message): ChatCompletionsMessage => {
        if (!Array.isArray(message.content) || !message.content.some(part => part.type === 'image_url' && compressedUrls.has(part))) {
          return message;
        }
        return {
          ...message,
          content: message.content.map(part => {
            if (part.type !== 'image_url') return part;
            const url = compressedUrls.get(part);
            return url === undefined ? part : { ...part, image_url: { ...part.image_url, url } };
          }),
        };
      }),
    };
  }

  return await run();
};
