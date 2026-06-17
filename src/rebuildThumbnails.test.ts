import { describe, expect, it } from 'vitest';
import type { BrickCheckItem } from './types';
import { mergeThumbnailCrops } from './thumbnailMatch';

function item(overrides: Partial<BrickCheckItem>): BrickCheckItem {
  return {
    id: 'item',
    source: 'pdf',
    sourcePdfName: 'order.pdf',
    sourcePage: 1,
    subOrderId: '11998',
    sku: '1234567',
    name: 'FLAT TILE 1X2',
    quantityExpected: 1,
    quantityFound: 0,
    lineTotalPrice: 0.1,
    unitPrice: 0.1,
    estimatedVolume: 1,
    volumeConfidence: 'medium',
    visualBulk: 1,
    costDensity: 0.1,
    partFamily: 'plates_tiles',
    riskTags: [],
    priorityScore: 1,
    routeGroup: 'cleanup',
    status: 'unchecked',
    notes: '',
    ...overrides
  };
}

describe('thumbnail rebuild matching', () => {
  it('copies fresh parsed crop metadata onto old saved items', () => {
    const old = item({ id: 'old', thumbnailCrop: undefined });
    const parsed = item({
      id: 'parsed',
      thumbnailCrop: { page: 3, x: 10, y: 20, width: 30, height: 40, confidence: 'wide' }
    });

    expect(mergeThumbnailCrops([old], [parsed])[0].thumbnailCrop).toEqual(parsed.thumbnailCrop);
  });

  it('falls back to row order when old saved identifiers do not match the fresh parse', () => {
    const old = item({ id: 'old', sku: 'old-sku', name: 'OLD NAME', thumbnailCrop: undefined });
    const parsed = item({
      id: 'parsed',
      sku: 'fresh-sku',
      name: 'FRESH NAME',
      thumbnailCrop: { page: 5, x: 11, y: 22, width: 33, height: 44, confidence: 'wide' }
    });

    expect(mergeThumbnailCrops([old], [parsed])[0].thumbnailCrop).toEqual(parsed.thumbnailCrop);
  });
});
