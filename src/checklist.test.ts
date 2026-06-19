import { describe, expect, it } from 'vitest';
import { normalizeChecklistSettings, splitChecklistItems } from './checklist';
import { orderChecklistItems } from './ordering';
import type { BrickCheckItem } from './types';

function item(overrides: Partial<BrickCheckItem>): BrickCheckItem {
  return {
    id: 'item',
    source: 'pdf',
    sourcePdfName: 'order.pdf',
    sourcePage: 1,
    subOrderId: '11998',
    sku: '1234567',
    name: 'BRICK 2X4',
    quantityExpected: 1,
    quantityFound: 0,
    lineTotalPrice: 0.1,
    unitPrice: 0.1,
    estimatedVolume: 8,
    volumeConfidence: 'high',
    visualBulk: 8,
    costDensity: 0.1,
    partFamily: 'bricks',
    riskTags: [],
    priorityScore: 100,
    routeGroup: 'cleanup',
    status: 'unchecked',
    notes: '',
    ...overrides
  };
}

describe('checklist presentation', () => {
  it('keeps found items in a separate section while the Open filter is selected', () => {
    const settings = normalizeChecklistSettings({ moveFoundToDoneList: true, statusFilter: 'open' });
    const result = splitChecklistItems([
      item({ id: 'open' }),
      item({ id: 'done', status: 'found', quantityFound: 1 })
    ], settings);

    expect(result.active.map((entry) => entry.id)).toEqual(['open']);
    expect(result.done.map((entry) => entry.id)).toEqual(['done']);
  });

  it('filters a checklist to one sub-order', () => {
    const settings = normalizeChecklistSettings({ subOrderFilter: '11996' });
    const result = splitChecklistItems([
      item({ id: 'first', subOrderId: '11998' }),
      item({ id: 'second', subOrderId: '11996' })
    ], settings);

    expect(result.active.map((entry) => entry.id)).toEqual(['second']);
  });

  it('changes the leading group for treasure and bulk routes', () => {
    const treasure = item({ id: 'treasure', routeGroup: 'treasure', priorityScore: 900, visualBulk: 1 });
    const bulk = item({ id: 'bulk', routeGroup: 'bulk', priorityScore: 200, visualBulk: 100, quantityExpected: 50 });
    const cleanup = item({ id: 'cleanup', routeGroup: 'cleanup', priorityScore: 700, visualBulk: 20 });

    expect(orderChecklistItems([bulk, cleanup, treasure], 'treasure')[0].id).toBe('treasure');
    expect(orderChecklistItems([treasure, cleanup, bulk], 'bulk')[0].id).toBe('bulk');
    expect(orderChecklistItems([bulk, cleanup, treasure], 'hybrid').map((entry) => entry.id)).toEqual(['treasure', 'bulk', 'cleanup']);
  });
});
