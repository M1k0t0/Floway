import { getRepo } from "../../repo/index.ts";
import { loadModels, type ModelsResponse } from "./cache.ts";
import { mergeClaudeVariants } from "./merge.ts";

export const loadMergedModels = async (): Promise<ModelsResponse> => {
  const accounts = await getRepo().github.listAccounts();
  const byId = new Map<string, ModelsResponse["data"][number]>();
  let sawSuccess = false;
  let lastError: unknown = null;

  for (const account of accounts) {
    const result = await loadModels(account.token, account.accountType);
    if (result.type === "error") {
      lastError = result.error;
      continue;
    }

    sawSuccess = true;
    for (const model of result.data.data) {
      if (!byId.has(model.id)) byId.set(model.id, model);
    }
  }

  if (sawSuccess) {
    return mergeClaudeVariants({ object: "list", data: [...byId.values()] });
  }

  if (lastError) throw lastError;
  throw new Error("No GitHub account connected — add one via the dashboard");
};
