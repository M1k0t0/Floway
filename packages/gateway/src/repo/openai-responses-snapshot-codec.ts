import { z } from 'zod';

import { decodeStoredJson } from './stored-json.ts';

const itemIdsSchema = z.array(z.string());

const decodeOpenAIResponsesSnapshotIds = (raw: string, column: 'item_ids_json' | 'source_item_ids_json', id: string, apiKeyId: string): string[] =>
  decodeStoredJson(raw, itemIdsSchema, {
    malformed: `responses_snapshots.${column} is malformed for id=${id}, api_key_id=${apiKeyId}`,
    invalid: `responses_snapshots.${column} is invalid for id=${id}, api_key_id=${apiKeyId}`,
  });

export const decodeOpenAIResponsesSnapshotItemIds = (raw: string, id: string, apiKeyId: string): string[] =>
  decodeOpenAIResponsesSnapshotIds(raw, 'item_ids_json', id, apiKeyId);

export const decodeOpenAIResponsesSnapshotSourceItemIds = (raw: string, id: string, apiKeyId: string): string[] =>
  decodeOpenAIResponsesSnapshotIds(raw, 'source_item_ids_json', id, apiKeyId);

export const encodeOpenAIResponsesSnapshotItemIds = (itemIds: readonly string[]): string => JSON.stringify(itemIds);

export const encodeOpenAIResponsesSnapshotSourceItemIds = (sourceItemIds: readonly string[]): string => JSON.stringify(sourceItemIds);
