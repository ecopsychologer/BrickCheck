import type { PartsMetadataProvider } from './types';

class DisabledProvider implements PartsMetadataProvider {
  readonly enabledByDefault = false;

  constructor(readonly id: string) {}

  async lookupBySku(): Promise<null> {
    return null;
  }
}

export const RebrickableProvider = new DisabledProvider('rebrickable');
export const BrickLinkProvider = new DisabledProvider('bricklink');
export const BrickognizeProvider = new DisabledProvider('brickognize');

export const disabledProviders = [RebrickableProvider, BrickLinkProvider, BrickognizeProvider];
