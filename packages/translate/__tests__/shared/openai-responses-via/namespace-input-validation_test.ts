import { test } from 'vitest';

import { flattenNamespaceTools } from '../../../src/shared/openai-responses-via/namespace-tools.ts';
import { TranslatorInputError } from '../../../src/translator-input-error.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

for (const carrier of [
  { type: 'additional_tools', role: 'user', tools: [] },
  { type: 'additional_tools', role: 'developer', tools: null },
  { type: 'additional_tools', role: 'developer', tools: [null] },
  { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 42 }] },
]) {
  test(`callable projection typed-rejects malformed Standard carrier ${JSON.stringify(carrier)}`, () => {
    const request = { model: 'm', input: [carrier] } as unknown as CanonicalOpenAIResponsesPayload;
    const original = structuredClone(request);
    assertThrows(() => flattenNamespaceTools(request), TranslatorInputError, 'additional_tools');
    assertEquals(request, original);
  });
}
