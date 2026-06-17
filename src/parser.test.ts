import { describe, expect, it } from 'vitest';
import { parseOrderFromTextRuns, type PdfTextRun } from './parser';

function run(page: number, y: number, text: string, x = 100): PdfTextRun {
  return { page, text, x, y, width: text.length * 6, height: 10 };
}

function orderedRun(page: number, orderIndex: number, text: string): PdfTextRun {
  return { ...run(page, 700 - orderIndex, text), orderIndex };
}

function parseFixture(lines: Array<[number, number, string]>) {
  return parseOrderFromTextRuns(
    lines.map(([page, y, text]) => run(page, y, text)),
    'sample.pdf',
    { idFactory: (prefix) => `${prefix}_${Math.random().toString(36).slice(2)}` }
  ).order;
}

describe('parseOrderFromTextRuns', () => {
  it('parses a sample PDF text stream with two Pick a Brick sections', () => {
    const order = parseFixture([
      [1, 760, 'Pick a Brick item 11998'],
      [1, 742, 'Status Shipped'],
      [1, 724, 'Hide parts (2)'],
      [1, 706, 'Subtotal $3.50'],
      [1, 670, 'MINI HEAD PRINTED SKU 6431234 Quantity 1 $2.50'],
      [1, 650, 'BRICK 2X4 RED SKU 3001234 Quantity 10 $1.00'],
      [1, 610, 'Pick a Brick item 11996'],
      [1, 592, 'Status In Warehouse'],
      [1, 574, 'Hide parts (2)'],
      [1, 556, 'Subtotal $2.35'],
      [1, 520, 'PLATE 1X1 TRANSPARENT SKU 6388011 Quantity 5 $0.75'],
      [1, 500, 'PLANT LEAVES SKU 6266969 Quantity 4 $1.60']
    ]);

    expect(order.subOrders).toHaveLength(2);
    expect(order.items).toHaveLength(4);
    expect(order.subOrders[0]).toMatchObject({ legoItemNumber: '11998', expectedLineCount: 2, parsedLineCount: 2, subtotal: 3.5 });
    expect(order.subOrders[1]).toMatchObject({ legoItemNumber: '11996', expectedLineCount: 2, parsedLineCount: 2, subtotal: 2.35 });
    expect(order.parseWarnings).toHaveLength(0);
  });

  it('handles page-break item parsing', () => {
    const order = parseFixture([
      [1, 760, 'Pick a Brick item 11998'],
      [1, 742, 'Hide parts (1)'],
      [1, 724, 'Subtotal $1.20'],
      [1, 40, 'ROOF TILE 1X2X3/74° INV.'],
      [2, 760, 'SKU 6343565 Quantity 1 $1.20']
    ]);

    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      name: 'ROOF TILE 1X2X3/74° INV.',
      sku: '6343565',
      quantityExpected: 1,
      lineTotalPrice: 1.2,
      sourcePage: 1
    });
  });

  it('validates totals', () => {
    const order = parseFixture([
      [1, 760, 'Pick a Brick item 11998'],
      [1, 742, 'Hide parts (2)'],
      [1, 724, 'Subtotal $9.99'],
      [1, 700, 'BRICK 1X1 BLUE SKU 3005211 Quantity 1 $0.10']
    ]);

    expect(order.parseWarnings.some((warning) => warning.message.includes('Expected 2 parts'))).toBe(true);
    expect(order.parseWarnings.some((warning) => warning.message.includes('Subtotal mismatch'))).toBe(true);
    expect(order.parseWarnings.some((warning) => warning.message.includes('Grand total mismatch'))).toBe(true);
  });

  it('calculates unit prices', () => {
    const order = parseFixture([
      [1, 760, 'Pick a Brick item 11998'],
      [1, 742, 'Hide parts (1)'],
      [1, 724, 'Subtotal $2.40'],
      [1, 700, 'BRICK 2X4 GREEN SKU 3001234 Quantity 12 $2.40']
    ]);

    expect(order.items[0].unitPrice).toBe(0.2);
  });

  it('extracts combined LEGO Pick A Brick header metadata from the real PDF shape', () => {
    const order = parseFixture([
      [1, 760, 'LEGO Pick A Brick Item: 11998 $71.75 In Warehouse Hide parts (1)'],
      [1, 724, 'MINI WIG, NO. 406 SKU: 6537946 Quantity: 1 $0.86']
    ]);

    expect(order.subOrders[0]).toMatchObject({
      legoItemNumber: '11998',
      subtotal: 71.75,
      expectedLineCount: 1,
      status: 'In Warehouse'
    });
  });

  it('matches the real order aggregate fixture counts', () => {
    const order = parseOrderFromTextRuns(
      [
        run(1, 760, 'Pick a Brick item 11998'),
        run(1, 742, 'Hide parts (89)'),
        run(1, 724, 'Subtotal $71.75'),
        run(1, 700, 'PLATE 1X1 SKU 6000001 Quantity 1 $71.75'),
        run(1, 660, 'Pick a Brick item 11996'),
        run(1, 642, 'Hide parts (74)'),
        run(1, 624, 'Subtotal $62.36'),
        run(1, 600, 'TILE 1X2 SKU 6000002 Quantity 1 $62.36')
      ],
      'T507018185.pdf'
    ).order;

    expect(order.subOrders.map((subOrder) => subOrder.expectedLineCount)).toEqual([89, 74]);
    expect(order.subOrders.reduce((sum, subOrder) => sum + subOrder.expectedLineCount, 0)).toBe(163);
    expect(order.subOrders.reduce((sum, subOrder) => sum + subOrder.subtotal, 0)).toBeCloseTo(134.11);
  });

  it('parses ordered pdf.js tokens without footer warnings or duplicate page-top prices', () => {
    const tokens = [
      'LEGO® Pick A Brick',
      'Item:',
      '11998',
      '$1.24',
      'Shipped',
      'Hide parts (2)',
      'BOTTLE 1X1X2 M',
      'SKU:',
      '6507876',
      'Quantity:',
      '1',
      '$0.20',
      '$0.20',
      'SLIDE HANDLE',
      'SKU:',
      '4211081',
      'Quantity:',
      '1',
      '$1.04',
      'Bricks and Pieces',
      'Pick a Brick standard orders take up to 28 business days',
      'your order',
      'LEGO® Pick A Brick',
      'Item:',
      '11996',
      '$0.72',
      'In Warehouse',
      'Hide parts (1)',
      'ARCH 1X4X2',
      'SKU:',
      '6031056',
      'Quantity:',
      '4',
      '$0.72'
    ];
    const order = parseOrderFromTextRuns(tokens.map((text, index) => orderedRun(index < 22 ? 1 : 2, index, text)), 'ordered.pdf').order;

    expect(order.parseWarnings).toEqual([]);
    expect(order.subOrders).toMatchObject([
      { legoItemNumber: '11998', expectedLineCount: 2, parsedLineCount: 2, subtotal: 1.24 },
      { legoItemNumber: '11996', expectedLineCount: 1, parsedLineCount: 1, subtotal: 0.72 }
    ]);
    expect(order.items.map((item) => [item.sku, item.name, item.lineTotalPrice])).toEqual([
      ['6507876', 'BOTTLE 1X1X2 M', 0.2],
      ['4211081', 'SLIDE HANDLE', 1.04],
      ['6031056', 'ARCH 1X4X2', 0.72]
    ]);
  });
});
