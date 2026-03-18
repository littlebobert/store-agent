import type { ProviderAdapter } from "./provider.js";
import { UnsupportedProviderError } from "./provider.js";

export class GooglePlayProvider implements ProviderAdapter {
  public readonly providerId = "google-play" as const;

  public resolve(): Promise<never> {
    return Promise.reject(new UnsupportedProviderError(this.providerId));
  }

  public revalidate(): Promise<never> {
    return Promise.reject(new UnsupportedProviderError(this.providerId));
  }

  public execute(): Promise<never> {
    return Promise.reject(new UnsupportedProviderError(this.providerId));
  }
}
