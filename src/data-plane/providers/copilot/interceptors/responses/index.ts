// Copilot-only Responses target workarounds. The Copilot provider attaches
// this set to its provider metadata, so the generic target assembler does not
// need to know which provider kind is running.

import type { ResponsesInterceptor } from "../../../../llm/interceptors.ts";
import { withConnectionMismatchRetried } from "./retry-connection-mismatch.ts";
import { withServiceTierStripped } from "./strip-service-tier.ts";
import { withOutputItemIdsSynchronized } from "./synchronize-output-item-ids.ts";

export const responsesCopilotInterceptors = [
  withServiceTierStripped,
  withConnectionMismatchRetried,
  withOutputItemIdsSynchronized,
] as const satisfies readonly ResponsesInterceptor[];
