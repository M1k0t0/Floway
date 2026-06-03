// Around-middleware for wrapping a single typed call. Each interceptor receives
// the call's context, the in-flight request, and a `run` to delegate to the
// next interceptor (the innermost run executes the call itself). Interceptors
// may inspect/mutate the request before `run`, await `run` and transform the
// result, short-circuit by returning without calling `run`, or retry by
// invoking `run` again. The shape is intentionally generic in Ctx/Req/Result so
// it works for any kind of call — provider-side wire shaping, source-side
// translation, retry policy — wired by the caller into concrete chains.
export type InterceptorRun<Result> = () => Promise<Result>;
export type Interceptor<Ctx, Req, Result> = (ctx: Ctx, request: Req, run: InterceptorRun<Result>) => Promise<Result>;

export const runInterceptors = async <Ctx, Req, Result>(
  ctx: Ctx,
  request: Req,
  interceptors: readonly Interceptor<Ctx, Req, Result>[],
  terminal: InterceptorRun<Result>,
): Promise<Result> => {
  const run = (index: number): Promise<Result> => (index < interceptors.length ? interceptors[index](ctx, request, () => run(index + 1)) : terminal());
  return await run(0);
};

// The minimal context shape interceptors read. Concrete invocation types in
// the consuming application structurally satisfy this — interceptors never
// require more than this baseline.
export interface InterceptorContext {
  readonly enabledFlags: ReadonlySet<string>;
}
