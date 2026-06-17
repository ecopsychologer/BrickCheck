import { describe, expect, it } from 'vitest';
import { assignRouteGroup, enrichParsedItems, estimateVolume } from './scoring';

const base = {
  source: 'pdf' as const,
  sourcePdfName: 'sample.pdf',
  sourcePage: 1,
  subOrderId: '11998',
  quantityFound: 0,
  thumbnailCrop: undefined,
  status: 'unchecked' as const,
  notes: ''
};

describe('scoring', () => {
  it('scores tiny expensive items high', () => {
    const items = enrichParsedItems([
      { ...base, id: 'tiny', sku: '1', name: 'MINIFIG ACCESSORY WAND TRANSPARENT', quantityExpected: 1, lineTotalPrice: 3, unitPrice: 3 },
      { ...base, id: 'brick', sku: '2', name: 'BRICK 2X4 RED', quantityExpected: 4, lineTotalPrice: 1, unitPrice: 0.25 }
    ]);

    expect(items.find((item) => item.id === 'tiny')!.priorityScore).toBeGreaterThan(items.find((item) => item.id === 'brick')!.priorityScore);
    expect(items.find((item) => item.id === 'tiny')!.riskTags).toContain('tiny');
    expect(items.find((item) => item.id === 'tiny')!.riskTags).toContain('highUnitPrice');
  });

  it('scores high-quantity bulk items reasonably high', () => {
    const items = enrichParsedItems([
      { ...base, id: 'bulk', sku: '1', name: 'BRICK 2X4 RED', quantityExpected: 60, lineTotalPrice: 12, unitPrice: 0.2 },
      { ...base, id: 'small', sku: '2', name: 'PLATE 1X1 BLUE', quantityExpected: 2, lineTotalPrice: 0.2, unitPrice: 0.1 }
    ]);

    const bulk = items.find((item) => item.id === 'bulk')!;
    expect(bulk.priorityScore).toBeGreaterThan(450);
    expect(bulk.routeGroup).toBe('bulk');
  });

  it('assigns route grouping', () => {
    expect(assignRouteGroup({ riskTags: ['tiny'], costDensity: 3, quantityExpected: 1, visualBulk: 0.2 }, 'hybrid')).toBe('treasure');
    expect(assignRouteGroup({ riskTags: [], costDensity: 0.05, quantityExpected: 40, visualBulk: 80 }, 'hybrid')).toBe('bulk');
    expect(assignRouteGroup({ riskTags: [], costDensity: 0.05, quantityExpected: 2, visualBulk: 1 }, 'hybrid')).toBe('cleanup');
  });

  it('treats printed or numbered tile variants as specialty treasure', () => {
    const items = enrichParsedItems([
      { ...base, id: 'printed', sku: '1', name: 'FLAT TILE 1X2 "NO. 86"', quantityExpected: 14, lineTotalPrice: 3.22, unitPrice: 0.23 },
      { ...base, id: 'plain', sku: '2', name: 'FLAT TILE 1X2', quantityExpected: 20, lineTotalPrice: 1.4, unitPrice: 0.07 }
    ]);

    const printed = items.find((item) => item.id === 'printed')!;
    expect(printed.riskTags).toContain('printedDecorated');
    expect(printed.riskTags).toContain('specialtyVariant');
    expect(printed.routeGroup).toBe('treasure');
  });

  it('keeps high-quantity masonry/profile bricks in bulk unless another risk applies', () => {
    const items = enrichParsedItems([
      { ...base, id: 'masonry', sku: '1', name: 'Profile brick 1 × 2 single gro.', quantityExpected: 20, lineTotalPrice: 2.6, unitPrice: 0.13 }
    ]);

    expect(items[0].routeGroup).toBe('bulk');
  });

  it('does not treat slope degree text as a fraction dimension', () => {
    const volume = estimateVolume('ROOF TILE 1X2X3/74° INV.');
    expect(volume.estimatedVolume).toBeGreaterThan(0.1);
    expect(volume.estimatedVolume).toBeLessThan(10);
  });
});
