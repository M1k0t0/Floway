import type { CopilotFetchOptions } from "../../../shared/copilot.ts";
import type { ExecuteResult } from "../shared/errors/result.ts";
import type { ProtocolFrame, StreamFrame } from "../shared/stream/types.ts";

type SourceApi = "messages" | "responses" | "chat-completions" | "gemini";

export interface EmitInput<TPayload extends { model: string }> {
  sourceApi: SourceApi;
  payload: TPayload;
  githubToken: string;
  accountType: string;
  apiKeyId?: string;
  clientStream?: boolean;
  runtimeLocation?: string;
  scheduleBackground?: (promise: Promise<unknown>) => void;
  fetchOptions?: CopilotFetchOptions;
  downstreamAbortSignal?: AbortSignal;
}

export type RawEmitResult<TJson> = ExecuteResult<StreamFrame<TJson>>;

export type EmitResult<TEvent> = ExecuteResult<ProtocolFrame<TEvent>>;
