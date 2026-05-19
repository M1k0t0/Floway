import { getRepo } from "../../../repo/index.ts";
import type { AccountModelBackoffRecord } from "../../../repo/types.ts";

const ACCOUNT_MODEL_BACKOFF_TTL_MS = 60 * 60 * 1000;

const isActive = (
  record: AccountModelBackoffRecord,
  now: number,
): boolean => record.expiresAt > now;

const clearExpired = async (
  records: AccountModelBackoffRecord[],
  now: number,
): Promise<AccountModelBackoffRecord[]> => {
  const active: AccountModelBackoffRecord[] = [];
  const expired: AccountModelBackoffRecord[] = [];

  for (const record of records) {
    if (isActive(record, now)) active.push(record);
    else expired.push(record);
  }

  await Promise.all(
    expired.map((record) =>
      getRepo().accountModelBackoffs.clear(record.accountId, record.model)
    ),
  );

  return active.sort((a, b) =>
    a.accountId - b.accountId || a.model.localeCompare(b.model)
  );
};

export const markAccountModelBackoff = async (
  accountId: number,
  model: string,
  status: number,
  now = Date.now(),
): Promise<void> => {
  await getRepo().accountModelBackoffs.mark({
    accountId,
    model,
    status,
    expiresAt: now + ACCOUNT_MODEL_BACKOFF_TTL_MS,
  });
};

export const isAccountModelBackedOff = async (
  accountId: number,
  model: string,
  now = Date.now(),
): Promise<boolean> => {
  const record = await getRepo().accountModelBackoffs.get(accountId, model);
  if (!record) return false;
  if (isActive(record, now)) return true;

  await getRepo().accountModelBackoffs.clear(accountId, model);
  return false;
};

export const listAccountModelBackoffs = async (
  accountIds: number[],
  now = Date.now(),
): Promise<AccountModelBackoffRecord[]> =>
  await clearExpired(
    await getRepo().accountModelBackoffs.list(accountIds),
    now,
  );

export const clearModelBackoffs = async (
  accountIds: number[],
  model: string,
): Promise<void> => {
  await getRepo().accountModelBackoffs.clearModel(accountIds, model);
};

export const clearAccountModelBackoffs = async (
  accountId: number,
): Promise<void> => {
  await getRepo().accountModelBackoffs.clearAccount(accountId);
};
