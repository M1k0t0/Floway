import type { Context } from 'hono';

// Headers that authenticate the client to the gateway, plus per-hop
// headers the inbound request sets for the gateway-side connection.
// Azure and custom upstreams pass `opts.headers` straight to the wire
// after setting their own pinned auth (`api-key` on Azure's OpenAI
// surface, `x-api-key` on the Anthropic surface, `Authorization: Bearer`
// on custom), so an inbound copy of any of these would override the
// pinned value and either leak a gateway-private credential or hand the
// upstream a value the client controls. `content-type` is stripped for
// the same reason: each provider sets it from the wire-body shape it
// builds, and a FormData passthrough additionally needs the runtime to
// derive a fresh multipart boundary on the outbound request.
// Forwarded-* / `cf-*` / `x-real-ip` and similar non-secret diagnostic
// signals stay in the bag — they identify the client at the upstream and
// have no clobber risk. Copilot and Codex clone before they merge, so
// they inherit the scrub for free.
const GATEWAY_PRIVATE_INBOUND_HEADERS = [
  'api-key',
  'authorization',
  'content-type',
  'cookie',
  'host',
  'proxy-authorization',
  'x-api-key',
  'x-floway-session',
  'x-goog-api-key',
];

// Build the unified inbound-headers bag the data plane threads to the
// provider boundary. Copies the source request's headers and removes the
// gateway's own auth + per-hop signals before the provider can observe
// them, regardless of whether the provider passes the bag through (Azure,
// custom) or clones it into a boundary ctx (Copilot, Codex).
export const inboundHeadersForUpstream = (c: Context): Headers => {
  const headers = new Headers(c.req.raw.headers);
  for (const name of GATEWAY_PRIVATE_INBOUND_HEADERS) headers.delete(name);
  return headers;
};
