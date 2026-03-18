import type {
  AppAliasRecord,
  NormalizedActionRequest,
  ProviderExecutionPlan,
  ProviderExecutionResult,
  ProviderId
} from "@store-agent/core";

export interface ResolveRequestContext {
  app: AppAliasRecord;
  request: NormalizedActionRequest;
}

export interface RevalidateRequestContext {
  app: AppAliasRecord;
  request: NormalizedActionRequest;
  previousPlan: ProviderExecutionPlan;
}

export interface ExecuteRequestContext {
  app: AppAliasRecord;
  request: NormalizedActionRequest;
  plan: ProviderExecutionPlan;
}

export interface ProviderAdapter {
  readonly providerId: ProviderId;
  resolve(context: ResolveRequestContext): Promise<ProviderExecutionPlan>;
  revalidate(context: RevalidateRequestContext): Promise<ProviderExecutionPlan>;
  execute(context: ExecuteRequestContext): Promise<ProviderExecutionResult>;
}

export class UnsupportedProviderError extends Error {
  public constructor(providerId: string) {
    super(`Provider ${providerId} is not implemented yet.`);
    this.name = "UnsupportedProviderError";
  }
}
