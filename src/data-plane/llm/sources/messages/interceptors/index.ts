import type { MessagesInterceptor } from "../../../interceptors.ts";
import {
  withMessagesWebSearchShim,
  withMessagesWebSearchShimForTranslatedTargets,
} from "./web-search-shim.ts";

export const messagesSourceInterceptors = [
  withMessagesWebSearchShimForTranslatedTargets,
] satisfies readonly MessagesInterceptor[];

export const messagesWebSearchShimInterceptors = [
  withMessagesWebSearchShim,
] satisfies readonly MessagesInterceptor[];
