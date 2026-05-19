import type {
  GeminiGenerateContentRequest,
  GeminiStreamEvent,
} from "../../../shared/protocol/gemini.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";
import { stripSafetySettings } from "./strip-safety-settings.ts";
import { stripUnsupportedPartFields } from "./strip-unsupported-part-fields.ts";
import { stripUnsupportedTools } from "./strip-unsupported-tools.ts";
import { suppressThoughtParts } from "./suppress-thought-parts.ts";

export interface GeminiSourceContext {
  payload: GeminiGenerateContentRequest;
  apiKeyId?: string;
}

export const geminiSourceInterceptors = [
  stripUnsupportedPartFields,
  stripUnsupportedTools,
  stripSafetySettings,
  suppressThoughtParts,
] satisfies readonly SourceInterceptor<
  GeminiSourceContext,
  GeminiStreamEvent
>[];
