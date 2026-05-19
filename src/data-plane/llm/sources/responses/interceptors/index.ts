import type { SourceInterceptor } from "../../run-interceptors.ts";
import type { ResponsesPayload } from "../../../shared/protocol/responses.ts";
import type { SourceResponseStreamEvent } from "../events/protocol.ts";
import { fixApplyPatchTools } from "./fix-apply-patch-tools.ts";
import { stripUnsupportedTools } from "./strip-unsupported-tools.ts";

export interface ResponsesSourceContext {
  payload: ResponsesPayload;
  apiKeyId?: string;
}

export const responsesSourceInterceptors = [
  // fix-apply-patch-tools must run before strip-unsupported-tools so the
  // `apply_patch` Freeform tool is rewritten into a function tool before the
  // strip pass removes every remaining `custom` entry.
  fixApplyPatchTools,
  stripUnsupportedTools,
] satisfies readonly SourceInterceptor<
  ResponsesSourceContext,
  SourceResponseStreamEvent
>[];
