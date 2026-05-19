// Aggregate raw usage records for the dashboard.
//
// Cost is computed per raw record before grouping (so per-variant pricing
// stays accurate even when display ids merge variants), then summed alongside
// tokens. The frontend reads cost as a precomputed number on each record and
// has no model-name parsing or pricing logic.
//
// Storage and export/import remain raw-model — see /api/data-transfer.

import { displayModelName } from "../../shared/model-name.ts";
import { recordCostUsd } from "./pricing.ts";
import type { UsageRecord } from "../../repo/types.ts";

export interface DisplayUsageRecord extends UsageRecord {
  cost: number;
}

const usageRecordKey = (record: DisplayUsageRecord): string =>
  `${record.keyId}\0${record.model}\0${record.hour}`;

export function aggregateUsageForDisplay(
  records: readonly UsageRecord[],
): DisplayUsageRecord[] {
  const byKey = new Map<string, DisplayUsageRecord>();

  for (const record of records) {
    const cacheRead = record.cacheReadTokens ?? 0;
    const cacheCreation = record.cacheCreationTokens ?? 0;
    const cost = recordCostUsd(
      record.model,
      record.inputTokens,
      record.outputTokens,
      cacheRead,
      cacheCreation,
    );

    const displayRecord: DisplayUsageRecord = {
      ...record,
      model: displayModelName(record.model),
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      cost,
    };
    const key = usageRecordKey(displayRecord);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, displayRecord);
      continue;
    }

    existing.requests += displayRecord.requests;
    existing.inputTokens += displayRecord.inputTokens;
    existing.outputTokens += displayRecord.outputTokens;
    existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) +
      (displayRecord.cacheReadTokens ?? 0);
    existing.cacheCreationTokens = (existing.cacheCreationTokens ?? 0) +
      (displayRecord.cacheCreationTokens ?? 0);
    existing.cost += displayRecord.cost;
  }

  return [...byKey.values()].sort((a, b) =>
    a.hour.localeCompare(b.hour) ||
    a.keyId.localeCompare(b.keyId) ||
    a.model.localeCompare(b.model)
  );
}
