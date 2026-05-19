import type { MessagesStreamEventData } from "../../../shared/protocol/messages.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";
import type { MessagesSourceContext } from "./index.ts";

/**
 * Claude Code injects `x-anthropic-billing-header` lines containing a per-turn
 * `cch=` hash. Copilot treats that metadata as ordinary prompt text, so prompt
 * caching stops hitting even when the real prompt did not change.
 *
 * Strip the whole metadata line and any orphaned `cch=` hashes before routing.
 * This is source-local normalization because every `/v1/messages` path should
 * behave the same after source parsing.
 *
 * References:
 * - https://github.com/Menci/copilot-gateway/issues/9
 */
const BILLING_HEADER_LINE_RE = /x-anthropic-billing-header[^\n]*/g;
const CCH_HASH_RE = /cch=[0-9a-f]{5,};?/gi;

const stripText = (text: string): string =>
  text.replace(BILLING_HEADER_LINE_RE, "").replace(CCH_HASH_RE, "").trim();

export const stripBillingAttribution: SourceInterceptor<
  MessagesSourceContext,
  MessagesStreamEventData
> = (ctx, run) => {
  const { payload } = ctx;

  if (typeof payload.system === "string") {
    payload.system = stripText(payload.system);
    if (!payload.system) delete payload.system;
  } else if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      block.text = stripText(block.text);
    }
    payload.system = payload.system.filter((block) => block.text.length > 0);
    if (payload.system.length === 0) delete payload.system;
  }

  return run();
};
