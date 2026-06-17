import { describe, expect, it } from 'vitest';
import type { BrickCheckOrder } from './types';
import { buildMissingReportRows, generateMissingReportCsv } from './exportReport';

describe('missing report export', () => {
  it('exports missing pieces only', () => {
    const order: BrickCheckOrder = {
      id: 'order',
      name: 'Order',
      createdAt: '2026-06-17T00:00:00.000Z',
      sourcePdfName: 'sample.pdf',
      subOrders: [],
      parseWarnings: [],
      items: [
        {
          id: 'a',
          source: 'pdf',
          sourcePdfName: 'sample.pdf',
          sourcePage: 1,
          subOrderId: '11998',
          sku: '6431234',
          name: 'MINI HEAD PRINTED',
          quantityExpected: 2,
          quantityFound: 1,
          lineTotalPrice: 4,
          unitPrice: 2,
          estimatedVolume: 0.3,
          volumeConfidence: 'low',
          visualBulk: 0.6,
          costDensity: 6.67,
          partFamily: 'minifig_parts',
          riskTags: ['tiny'],
          priorityScore: 900,
          routeGroup: 'treasure',
          status: 'partial',
          notes: 'One short'
        },
        {
          id: 'b',
          source: 'pdf',
          sourcePdfName: 'sample.pdf',
          sourcePage: 1,
          subOrderId: '11998',
          sku: '3001234',
          name: 'BRICK 2X4',
          quantityExpected: 4,
          quantityFound: 4,
          lineTotalPrice: 1,
          unitPrice: 0.25,
          estimatedVolume: 8,
          volumeConfidence: 'high',
          visualBulk: 32,
          costDensity: 0.03,
          partFamily: 'bricks',
          riskTags: [],
          priorityScore: 200,
          routeGroup: 'bulk',
          status: 'found',
          notes: ''
        }
      ]
    };

    expect(buildMissingReportRows(order)).toEqual([
      {
        subOrderId: '11998',
        sku: '6431234',
        name: 'MINI HEAD PRINTED',
        expected: 2,
        found: 1,
        missing: 1,
        unitPrice: 2,
        missingValue: 2,
        notes: 'One short'
      }
    ]);
    const csv = generateMissingReportCsv(order);
    expect(csv).toContain('subOrderId,sku,name,expected,found,missing,unitPrice,missingValue,notes');
    expect(csv).toContain('11998,6431234,MINI HEAD PRINTED,2,1,1,2,2,One short');
  });
});
