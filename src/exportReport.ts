import Papa from 'papaparse';
import type { BrickCheckOrder } from './types';
import { roundMoney } from './lib/money';

export interface MissingReportRow {
  subOrderId: string;
  sku: string;
  name: string;
  expected: number;
  found: number;
  missing: number;
  unitPrice: number;
  missingValue: number;
  notes: string;
}

export function buildMissingReportRows(order: BrickCheckOrder): MissingReportRow[] {
  return order.items
    .map((item) => {
      const missing = Math.max(0, item.quantityExpected - item.quantityFound);
      return {
        subOrderId: item.subOrderId,
        sku: item.sku,
        name: item.name,
        expected: item.quantityExpected,
        found: item.quantityFound,
        missing,
        unitPrice: item.unitPrice,
        missingValue: roundMoney(missing * item.unitPrice),
        notes: item.notes
      };
    })
    .filter((row) => row.missing > 0);
}

export function generateMissingReportCsv(order: BrickCheckOrder): string {
  return Papa.unparse(buildMissingReportRows(order), {
    columns: ['subOrderId', 'sku', 'name', 'expected', 'found', 'missing', 'unitPrice', 'missingValue', 'notes']
  });
}

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
