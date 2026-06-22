import type { Context } from 'hono';

import { effectiveUpstreamIdsFromContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { getCurrentColo } from '../../../runtime/runtime-info.ts';
import { runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

export interface GatewayCtx {
  readonly apiKeyId: string;
  readonly upstreamIds: readonly string[] | null;
  readonly abortSignal?: AbortSignal;
  readonly wantsStream: boolean;
  readonly downstreamAbortController?: AbortController;
  readonly backgroundScheduler: BackgroundScheduler;
  // Stamped at ctx construction so request-total latency telemetry can subtract
  // from `performance.now()` at response completion.
  readonly requestStartedAt: number;
  // The deployment colo / region, recorded as the `runtimeLocation` performance
  // dimension. Request-scoped, so it is resolved once here rather than at the
  // provider-call boundary.
  readonly runtimeLocation: string;
  readonly currentColo: string | null;
}

// Names the auth-middleware-stamped Hono variables this builder reads. Hono
// gives no compile-time guarantee that a middleware ran; the alias is the
// local declaration of what `auth.ts` is contracted to set so the lookup
// sheds its inline cast.
export interface GatewayCtxAuthVars {
  apiKeyId: string;
  apiKeyUpstreamIds: readonly string[] | null;
  userUpstreamIds: readonly string[] | null;
}

type AuthedContext = Context<{ Variables: GatewayCtxAuthVars }>;

export const createGatewayCtxFromHono = (c: AuthedContext, wantsStream: boolean): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId');
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  return {
    apiKeyId,
    upstreamIds,
    ...(downstreamAbortController !== undefined ? { abortSignal: downstreamAbortController.signal, downstreamAbortController } : {}),
    wantsStream,
    backgroundScheduler: backgroundSchedulerFromContext(c),
    requestStartedAt: performance.now(),
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    currentColo: getCurrentColo(c.req.raw),
  };
};

export const createGatewayCtxForWs = (
  c: AuthedContext,
  downstreamAbortController: AbortController,
): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId');
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  return {
    apiKeyId,
    upstreamIds,
    abortSignal: downstreamAbortController.signal,
    wantsStream: true,
    downstreamAbortController,
    backgroundScheduler: backgroundSchedulerFromContext(c),
    requestStartedAt: performance.now(),
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    currentColo: getCurrentColo(c.req.raw),
  };
};
