import type { ChatCompletionsContentPart } from '@floway-dev/protocols/chat-completions';
import type { ResponsesInputContent } from '@floway-dev/protocols/responses';

// Chat and Responses text arrays are transport fragments of one message, not
// paragraph blocks. Preserve the existing no-separator flattening.
const contentPartText = (part: ChatCompletionsContentPart | ResponsesInputContent): string | null => (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' ? part.text : null);

const contentPartsToText = (parts: readonly (ChatCompletionsContentPart | ResponsesInputContent)[]): string =>
  parts
    .map(contentPartText)
    .filter((text): text is string => text !== null)
    .join('');

export const chatCompletionsContentToText = (content: string | ChatCompletionsContentPart[] | null): string => (typeof content === 'string' ? content : Array.isArray(content) ? contentPartsToText(content) : '');

export const chatCompletionsContentToResponsesInputContent = (content: string | ChatCompletionsContentPart[] | null): string | ResponsesInputContent[] => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return '';

  return content.map(
    (part): ResponsesInputContent =>
      part.type === 'text'
        ? { type: 'input_text', text: part.text }
        : {
            type: 'input_image',
            image_url: part.image_url.url,
            detail: part.image_url.detail ?? 'auto',
          },
  );
};

export const responsesContentToText = (content: string | ResponsesInputContent[]): string => (typeof content === 'string' ? content : contentPartsToText(content));

export const responsesContentToChatCompletionsContent = (content: string | ResponsesInputContent[]): string | ChatCompletionsContentPart[] => {
  if (typeof content === 'string') return content;

  return content.some(part => part.type === 'input_image')
    ? content.map(
        (part): ChatCompletionsContentPart =>
          part.type === 'input_image'
            ? {
                type: 'image_url',
                image_url: {
                  url: part.image_url,
                  detail: part.detail,
                },
              }
            : { type: 'text', text: part.text },
      )
    : contentPartsToText(content);
};
