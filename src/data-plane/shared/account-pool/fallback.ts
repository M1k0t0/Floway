import { getRepo } from "../../../repo/index.ts";
import type { GitHubAccount } from "../../../repo/types.ts";
import {
  isAccountSwitchableStatus,
  isCopilotTokenFetchError,
} from "../../../shared/copilot.ts";
import {
  clearModelBackoffs,
  isAccountModelBackedOff,
  markAccountModelBackoff,
} from "./backoffs.ts";
import {
  findModelInModels,
  isSwitchableModelsLoadError,
  loadModelsForAccount,
  ModelsFetchError,
} from "../../models/cache.ts";

export interface AccountPoolAttemptContext {
  account: GitHubAccount;
}

type LastFailure<T> =
  | { type: "result"; result: T }
  | { type: "error"; error: unknown };

const markModelUnavailable = async (
  account: GitHubAccount,
  model: string,
  status: number,
): Promise<void> => {
  await markAccountModelBackoff(account.user.id, model, status);
};

const clearModelUnavailable = async (
  accounts: GitHubAccount[],
  model: string,
): Promise<void> => {
  await clearModelBackoffs(accounts.map((account) => account.user.id), model);
};

const isUnavailable = async (
  account: GitHubAccount,
  model: string,
): Promise<boolean> => {
  return await isAccountModelBackedOff(account.user.id, model);
};

const switchableStatusFromError = (error: unknown): number | null => {
  if (
    isCopilotTokenFetchError(error) && isAccountSwitchableStatus(error.status)
  ) {
    return error.status;
  }
  if (
    error instanceof ModelsFetchError && isAccountSwitchableStatus(error.status)
  ) {
    return error.status;
  }
  return null;
};

export const switchableStatusFromResult = (result: unknown): number | null => {
  if (result instanceof Response) {
    return isAccountSwitchableStatus(result.status) ? result.status : null;
  }

  const maybeResult = result as { type?: unknown; status?: unknown };
  if (
    maybeResult?.type === "upstream-error" &&
    typeof maybeResult.status === "number" &&
    isAccountSwitchableStatus(maybeResult.status)
  ) {
    return maybeResult.status;
  }

  return null;
};

const eligibleAccountsForModel = async (
  accounts: GitHubAccount[],
  model: string,
): Promise<GitHubAccount[]> => {
  const matches: GitHubAccount[] = [];

  for (const account of accounts) {
    const result = await loadModelsForAccount(account);
    if (result.type === "models") {
      if (findModelInModels(result.data, model)) matches.push(account);
      continue;
    }

    if (isSwitchableModelsLoadError(result.error)) {
      const status = switchableStatusFromError(result.error);
      if (status) await markModelUnavailable(account, model, status);
    }
  }

  return matches.length > 0 ? matches : accounts;
};

const availableAccountsForModel = async (
  accounts: GitHubAccount[],
  model: string,
): Promise<GitHubAccount[]> => {
  const checks = await Promise.all(accounts.map(async (account) => ({
    account,
    unavailable: await isUnavailable(account, model),
  })));
  return checks
    .filter((check) => !check.unavailable)
    .map((check) => check.account);
};

export async function withAccountFallback<T>(
  model: string,
  run: (ctx: AccountPoolAttemptContext) => Promise<T>,
): Promise<T> {
  const accounts = await getRepo().github.listAccounts();
  if (accounts.length === 0) {
    throw new Error("No GitHub account connected — add one via the dashboard");
  }

  const eligible = await eligibleAccountsForModel(accounts, model);
  let attempts = await availableAccountsForModel(eligible, model);
  if (attempts.length === 0) {
    await clearModelUnavailable(eligible, model);
    attempts = eligible;
  }

  let lastFailure: LastFailure<T> | null = null;

  for (const account of attempts) {
    try {
      const result = await run({ account });
      const status = switchableStatusFromResult(result);
      if (!status) return result;

      await markModelUnavailable(account, model, status);
      lastFailure = { type: "result", result };
    } catch (error) {
      const status = switchableStatusFromError(error);
      if (!status) throw error;

      await markModelUnavailable(account, model, status);
      lastFailure = { type: "error", error };
    }
  }

  if (lastFailure?.type === "result") return lastFailure.result;
  if (lastFailure?.type === "error") throw lastFailure.error;

  throw new Error(`No GitHub account is eligible for model ${model}`);
}
