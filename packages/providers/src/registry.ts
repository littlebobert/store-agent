import type { ProviderId } from "@store-agent/core";

import { AppleAscProvider } from "./appleAsc.js";
import { GooglePlayProvider } from "./googlePlay.js";
import type { ProviderAdapter } from "./provider.js";

export interface ProviderRegistryOptions {
  apple?: ConstructorParameters<typeof AppleAscProvider>[0];
}

export class ProviderRegistry {
  private readonly providers: Map<ProviderId, ProviderAdapter>;

  public constructor(options: ProviderRegistryOptions = {}) {
    this.providers = new Map<ProviderId, ProviderAdapter>([
      ["apple", new AppleAscProvider(options.apple)],
      ["google-play", new GooglePlayProvider()]
    ]);
  }

  public get(providerId: ProviderId): ProviderAdapter {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`No provider registered for ${providerId}.`);
    }

    return provider;
  }
}
