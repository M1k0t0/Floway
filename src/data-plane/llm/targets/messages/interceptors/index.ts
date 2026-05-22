import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import type { OptionalFixId } from '../../../../providers/fixes.ts';
import type { ProviderTargetInterceptors } from '../../../../providers/types.ts';
import type { MessagesInterceptor } from '../../../interceptors.ts';

const baseInterceptors: readonly MessagesInterceptor[] = [];

export const messagesOptionalInterceptors = [
  {
    fixId: 'disable-reasoning-on-forced-tool-choice',
    run: withReasoningDisabledOnForcedToolChoice,
  },
] as const satisfies readonly { fixId: OptionalFixId; run: MessagesInterceptor }[];

export const interceptorsForMessages = (provider: { enabledFixes: ReadonlySet<string>; targetInterceptors?: ProviderTargetInterceptors }): readonly MessagesInterceptor[] => [
  ...baseInterceptors,
  ...(provider.targetInterceptors?.messages ?? []),
  ...messagesOptionalInterceptors.filter(({ fixId }) => provider.enabledFixes.has(fixId)).map(({ run }) => run),
];
