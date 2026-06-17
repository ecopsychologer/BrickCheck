import type { BrickCheckItem, BrickCheckOrder, BrickCheckSubOrder, ParseWarning, ThumbnailCrop } from './types';
import { makeId } from './lib/id';
import { parseMoney, roundMoney } from './lib/money';
import { enrichParsedItems } from './scoring';

export interface PdfTextRun {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  orderIndex?: number;
}

export interface VisualLine {
  page: number;
  text: string;
  x: number;
  y: number;
  yCenter: number;
  width: number;
  height: number;
  runs: PdfTextRun[];
}

export interface ParseResult {
  order: BrickCheckOrder;
  reviewItems: BrickCheckItem[];
}

interface PendingItem {
  subOrderId: string;
  sourcePage: number;
  rowYCenter: number;
  nameParts: string[];
  sku?: string;
  quantityExpected?: number;
  lineTotalPrice?: number;
}

interface LineFields {
  name?: string;
  sku?: string;
  quantityExpected?: number;
  lineTotalPrice?: number;
  hasItemSignal: boolean;
  hasOnlyName: boolean;
}

export function groupTextRunsIntoLines(runs: PdfTextRun[], tolerance = 4): VisualLine[] {
  const byPage = new Map<number, PdfTextRun[]>();
  for (const run of runs.filter((item) => item.text.trim())) {
    byPage.set(run.page, [...(byPage.get(run.page) ?? []), run]);
  }

  const lines: VisualLine[] = [];
  for (const [page, pageRuns] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = pageRuns.sort((a, b) => b.y - a.y || a.x - b.x);
    const buckets: PdfTextRun[][] = [];
    for (const run of sorted) {
      const match = buckets.find((bucket) => Math.abs(bucket[0].y - run.y) <= tolerance);
      if (match) match.push(run);
      else buckets.push([run]);
    }

    for (const bucket of buckets) {
      const ordered = bucket.sort((a, b) => a.x - b.x);
      const text = ordered.map((run) => run.text.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const minX = Math.min(...ordered.map((run) => run.x));
      const maxX = Math.max(...ordered.map((run) => run.x + run.width));
      const minY = Math.min(...ordered.map((run) => run.y));
      const maxY = Math.max(...ordered.map((run) => run.y + run.height));
      lines.push({
        page,
        text,
        x: minX,
        y: minY,
        yCenter: minY + (maxY - minY) / 2,
        width: maxX - minX,
        height: maxY - minY,
        runs: ordered
      });
    }
  }

  return lines.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
}

export function parseOrderFromTextRuns(
  runs: PdfTextRun[],
  sourcePdfName: string,
  options: { orderName?: string; idFactory?: (prefix: string) => string } = {}
): ParseResult {
  if (runs.some((run) => run.orderIndex !== undefined)) {
    return parseOrderFromOrderedRuns(runs, sourcePdfName, options);
  }
  return parseOrderFromLines(groupTextRunsIntoLines(runs), sourcePdfName, options);
}

function parseOrderFromOrderedRuns(
  runs: PdfTextRun[],
  sourcePdfName: string,
  options: { orderName?: string; idFactory?: (prefix: string) => string } = {}
): ParseResult {
  const idFactory = options.idFactory ?? makeId;
  const subOrders = new Map<string, BrickCheckSubOrder>();
  const parseWarnings: ParseWarning[] = [];
  const parsedBaseItems: Array<Omit<BrickCheckItem, 'estimatedVolume' | 'volumeConfidence' | 'visualBulk' | 'costDensity' | 'partFamily' | 'riskTags' | 'priorityScore' | 'routeGroup'>> = [];
  let currentSubOrder: BrickCheckSubOrder | undefined;
  let pending: PendingItem | undefined;
  let inSectionHeader = false;
  let awaitingSku = false;
  let awaitingQuantity = false;

  const warn = (warning: Omit<ParseWarning, 'id'>) => {
    parseWarnings.push({ id: idFactory('warning'), ...warning });
  };

  const getOrCreateSubOrder = (legoItemNumber: string) => {
    const key = legoItemNumber.trim();
    const existing = subOrders.get(key);
    if (existing) return existing;
    const subOrder: BrickCheckSubOrder = {
      id: key,
      legoItemNumber: key,
      subtotal: 0,
      expectedLineCount: 0,
      parsedLineCount: 0,
      status: 'Unknown'
    };
    subOrders.set(key, subOrder);
    return subOrder;
  };

  const ensurePending = (run: PdfTextRun) => {
    if (!currentSubOrder) return undefined;
    pending ??= {
      subOrderId: currentSubOrder.id,
      sourcePage: run.page,
      rowYCenter: run.y + run.height / 2,
      nameParts: []
    };
    return pending;
  };

  const flushPending = (reason: string) => {
    if (!pending) return;
    if (isPendingComplete(pending)) {
      const name = normalizeName(pending.nameParts.join(' '));
      const quantityExpected = pending.quantityExpected;
      const lineTotalPrice = pending.lineTotalPrice;
      parsedBaseItems.push({
        id: idFactory('item'),
        source: 'pdf',
        sourcePdfName,
        sourcePage: pending.sourcePage,
        subOrderId: pending.subOrderId,
        sku: pending.sku,
        name,
        quantityExpected,
        quantityFound: 0,
        lineTotalPrice,
        unitPrice: roundMoney(lineTotalPrice / quantityExpected),
        thumbnailCrop: estimateThumbnailCrop(pending.sourcePage, pending.rowYCenter),
        status: 'unchecked',
        notes: ''
      });
    } else {
      const partialName = normalizeName(pending.nameParts.join(' '));
      const hasStructuredPartial = Boolean(pending.sku || pending.quantityExpected !== undefined || pending.lineTotalPrice !== undefined);
      if (hasStructuredPartial || looksLikePartNameLine(partialName)) {
        warn({
          severity: 'warning',
          message: `Incomplete item sent to review: ${reason}`,
          subOrderId: pending.subOrderId,
          sku: pending.sku,
          sourcePage: pending.sourcePage
        });
      }
    }
    pending = undefined;
    awaitingSku = false;
    awaitingQuantity = false;
  };

  const orderedRuns = runs
    .filter((run) => run.text.trim())
    .sort((a, b) => a.page - b.page || (a.orderIndex ?? 0) - (b.orderIndex ?? 0));

  for (const run of orderedRuns) {
    const text = run.text.trim();
    if (!text || text === '-' || text === '|') continue;

    if (isPickABrickSectionHeader(text) || /\blego\b.*\bpick\s*a\s*brick\b/i.test(text)) {
      flushPending('new Pick a Brick section');
      currentSubOrder = undefined;
      inSectionHeader = true;
      continue;
    }

    if (inSectionHeader) {
      const id = extractSubOrderId(text) ?? (/^\d{4,6}$/.test(text) ? text : null);
      if (id) {
        currentSubOrder = getOrCreateSubOrder(id);
        continue;
      }
      if (!currentSubOrder || /^item:?$/i.test(text)) continue;

      const subtotal = extractBareSectionSubtotal(text);
      if (subtotal !== null) {
        currentSubOrder.subtotal = subtotal;
        continue;
      }

      const status = extractBareStatus(text);
      if (status) {
        currentSubOrder.status = status;
        continue;
      }

      const expectedLineCount = extractExpectedLineCount(text);
      if (expectedLineCount !== null) {
        currentSubOrder.expectedLineCount = expectedLineCount;
        inSectionHeader = false;
        continue;
      }
      continue;
    }

    if (!currentSubOrder) continue;
    if (isMetadataLine(text) || /^item:?$/i.test(text)) continue;

    if (/^sku:?$/i.test(text)) {
      awaitingSku = true;
      continue;
    }

    const labeledSku = text.match(/\bsku\s*:?\s*(\d{5,8})\b/i)?.[1];
    if (labeledSku || (awaitingSku && /^\d{5,8}$/.test(text))) {
      const item = ensurePending(run);
      if (item) item.sku = labeledSku ?? text;
      awaitingSku = false;
      continue;
    }

    if (/^quantity:?$/i.test(text)) {
      awaitingQuantity = true;
      continue;
    }

    const quantity = text.match(/\bquantity\s*:?\s*(\d+)\b/i)?.[1] ?? (awaitingQuantity && /^\d+$/.test(text) ? text : undefined);
    if (quantity !== undefined) {
      const item = ensurePending(run);
      if (item) item.quantityExpected = Number(quantity);
      awaitingQuantity = false;
      continue;
    }

    const lineTotalPrice = parseMoney(text.match(/\$\s*\d{1,4}(?:,\d{3})*\.\d{2}\b/)?.[0]);
    if (lineTotalPrice !== null) {
      if (pending) {
        pending.lineTotalPrice = lineTotalPrice;
        flushPending('complete row');
      }
      continue;
    }

    if (!looksLikeNonItemToken(text)) {
      const item = ensurePending(run);
      if (item) item.nameParts.push(text);
    }
  }

  flushPending('end of document');

  const items = enrichParsedItems(parsedBaseItems);
  validateParsedOrder([...subOrders.values()], items, parseWarnings, idFactory);

  const order: BrickCheckOrder = {
    id: idFactory('order'),
    name: options.orderName ?? sourcePdfName.replace(/\.pdf$/i, ''),
    createdAt: new Date().toISOString(),
    sourcePdfName,
    subOrders: [...subOrders.values()],
    items,
    parseWarnings
  };

  return { order, reviewItems: [] };
}

export function parseOrderFromLines(
  lines: VisualLine[],
  sourcePdfName: string,
  options: { orderName?: string; idFactory?: (prefix: string) => string } = {}
): ParseResult {
  const idFactory = options.idFactory ?? makeId;
  const subOrders = new Map<string, BrickCheckSubOrder>();
  const parseWarnings: ParseWarning[] = [];
  const parsedBaseItems: Array<Omit<BrickCheckItem, 'estimatedVolume' | 'volumeConfidence' | 'visualBulk' | 'costDensity' | 'partFamily' | 'riskTags' | 'priorityScore' | 'routeGroup'>> = [];
  let currentSubOrder: BrickCheckSubOrder | undefined;
  let pending: PendingItem | undefined;
  let awaitingPickABrickNumber = false;

  const warn = (warning: Omit<ParseWarning, 'id'>) => {
    parseWarnings.push({ id: idFactory('warning'), ...warning });
  };

  const getOrCreateSubOrder = (legoItemNumber: string) => {
    const key = legoItemNumber.trim();
    const existing = subOrders.get(key);
    if (existing) return existing;
    const subOrder: BrickCheckSubOrder = {
      id: key,
      legoItemNumber: key,
      subtotal: 0,
      expectedLineCount: 0,
      parsedLineCount: 0,
      status: 'Unknown'
    };
    subOrders.set(key, subOrder);
    return subOrder;
  };

  const flushPending = (reason: string) => {
    if (!pending) return;
    if (isPendingComplete(pending)) {
      const name = normalizeName(pending.nameParts.join(' '));
      const quantityExpected = pending.quantityExpected;
      const lineTotalPrice = pending.lineTotalPrice;
      const item = {
        id: idFactory('item'),
        source: 'pdf' as const,
        sourcePdfName,
        sourcePage: pending.sourcePage,
        subOrderId: pending.subOrderId,
        sku: pending.sku,
        name,
        quantityExpected,
        quantityFound: 0,
        lineTotalPrice,
        unitPrice: roundMoney(lineTotalPrice / quantityExpected),
        thumbnailCrop: estimateThumbnailCrop(pending.sourcePage, pending.rowYCenter),
        status: 'unchecked' as const,
        notes: ''
      };
      parsedBaseItems.push(item);
    } else {
      const partialName = normalizeName(pending.nameParts.join(' '));
      const hasStructuredPartial = Boolean(pending.sku || pending.quantityExpected !== undefined || pending.lineTotalPrice !== undefined);
      const looksLikeRealPart = looksLikePartNameLine(partialName);
      if (hasStructuredPartial || looksLikeRealPart) {
        warn({
          severity: 'warning',
          message: `Incomplete item sent to review: ${reason}`,
          subOrderId: pending.subOrderId,
          sku: pending.sku,
          sourcePage: pending.sourcePage
        });
      }
    }
    pending = undefined;
  };

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;

    if (isPickABrickSectionHeader(text)) {
      flushPending('new Pick a Brick section');
      awaitingPickABrickNumber = true;
      const id = extractSubOrderId(text);
      if (id) {
        currentSubOrder = getOrCreateSubOrder(id);
        awaitingPickABrickNumber = false;
        applySubOrderMetadata(currentSubOrder, text, true);
      }
      continue;
    }

    if (awaitingPickABrickNumber) {
      const id = extractSubOrderId(text);
      if (id) {
        currentSubOrder = getOrCreateSubOrder(id);
        awaitingPickABrickNumber = false;
        applySubOrderMetadata(currentSubOrder, text, true);
        continue;
      }
    }

    if (!currentSubOrder) continue;

    applySubOrderMetadata(currentSubOrder, text, false);

    const bareStatus = extractBareStatus(text);
    if (bareStatus) {
      currentSubOrder.status = bareStatus;
      continue;
    }

    const expectedLineCount = extractExpectedLineCount(text);
    if (expectedLineCount !== null) {
      currentSubOrder.expectedLineCount = expectedLineCount;
      continue;
    }

    const subtotal = extractSubtotal(text);
    if (subtotal !== null) {
      currentSubOrder.subtotal = subtotal;
      continue;
    }

    const status = extractStatus(text);
    if (status) {
      currentSubOrder.status = status;
      continue;
    }

    if (isMetadataLine(text)) continue;

    const fields = extractLineFields(text);
    if (!fields.hasItemSignal && !pending) continue;
    if (!pending && fields.hasOnlyName && !looksLikePartNameLine(fields.name ?? '')) continue;

    if (!pending) {
      pending = {
        subOrderId: currentSubOrder.id,
        sourcePage: line.page,
        rowYCenter: line.yCenter,
        nameParts: []
      };
    }

    if (pending.subOrderId !== currentSubOrder.id) {
      flushPending('sub-order changed');
      pending = {
        subOrderId: currentSubOrder.id,
        sourcePage: line.page,
        rowYCenter: line.yCenter,
        nameParts: []
      };
    }

    if (fields.name) pending.nameParts.push(fields.name);
    if (fields.sku) pending.sku = fields.sku;
    if (fields.quantityExpected !== undefined) pending.quantityExpected = fields.quantityExpected;
    if (fields.lineTotalPrice !== undefined) pending.lineTotalPrice = fields.lineTotalPrice;

    if (isPendingComplete(pending)) flushPending('complete row');
  }

  flushPending('end of document');

  const items = enrichParsedItems(parsedBaseItems);
  const reviewItems = items.filter((item) => !item.sku || !item.name || item.quantityExpected <= 0 || item.lineTotalPrice <= 0);

  for (const subOrder of subOrders.values()) {
    const subItems = items.filter((item) => item.subOrderId === subOrder.id);
    subOrder.parsedLineCount = subItems.length;
    const parsedSubtotal = roundMoney(subItems.reduce((sum, item) => sum + item.lineTotalPrice, 0));
    if (subOrder.expectedLineCount > 0 && subOrder.expectedLineCount !== subOrder.parsedLineCount) {
      warn({
        severity: 'error',
        message: `Expected ${subOrder.expectedLineCount} parts but parsed ${subOrder.parsedLineCount}.`,
        subOrderId: subOrder.id
      });
    }
    if (subOrder.subtotal > 0 && parsedSubtotal !== subOrder.subtotal) {
      warn({
        severity: 'error',
        message: `Subtotal mismatch: PDF ${subOrder.subtotal.toFixed(2)} vs parsed ${parsedSubtotal.toFixed(2)}.`,
        subOrderId: subOrder.id
      });
    }
  }

  const expectedGrandTotal = roundMoney([...subOrders.values()].reduce((sum, subOrder) => sum + subOrder.subtotal, 0));
  const parsedGrandTotal = roundMoney(items.reduce((sum, item) => sum + item.lineTotalPrice, 0));
  if (expectedGrandTotal > 0 && expectedGrandTotal !== parsedGrandTotal) {
    warn({
      severity: 'error',
      message: `Grand total mismatch: PDF ${expectedGrandTotal.toFixed(2)} vs parsed ${parsedGrandTotal.toFixed(2)}.`
    });
  }

  const order: BrickCheckOrder = {
    id: idFactory('order'),
    name: options.orderName ?? sourcePdfName.replace(/\.pdf$/i, ''),
    createdAt: new Date().toISOString(),
    sourcePdfName,
    subOrders: [...subOrders.values()],
    items,
    parseWarnings
  };

  return { order, reviewItems };
}

function extractLineFields(text: string): LineFields {
  const priceMatches = [...text.matchAll(/\$\s*\d{1,4}(?:,\d{3})*\.\d{2}\b/g)];
  const lastPrice = priceMatches.at(-1)?.[0];
  const quantityMatch = text.match(/\b(?:qty|quantity)\s*:?\s*(\d+)\b/i);
  const labeledSkuMatch = text.match(/\b(?:sku|element|element\s*id)\s*:?\s*(\d{5,8})\b/i);
  const looseSkuMatch = text.match(/\b(\d{6,8})\b/);
  const sku = labeledSkuMatch?.[1] ?? looseSkuMatch?.[1];
  const lineTotalPrice = parseMoney(lastPrice);
  const quantityExpected = quantityMatch ? Number(quantityMatch[1]) : undefined;
  let name = text
    .replace(/\b(?:sku|element|element\s*id)\s*:?\s*\d{5,8}\b/gi, ' ')
    .replace(/\b(?:qty|quantity)\s*:?\s*\d+\b/gi, ' ')
    .replace(/\$\s*\d{1,4}(?:,\d{3})*\.\d{2}\b/g, ' ')
    .replace(/\b\d{6,8}\b/g, ' ')
    .replace(/\b(?:line\s*total|unit\s*price|price|total)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^(sku|quantity|qty|price|total|line total)$/i.test(name)) name = '';

  return {
    name: name || undefined,
    sku,
    quantityExpected,
    lineTotalPrice: lineTotalPrice ?? undefined,
    hasItemSignal: Boolean(name || sku || quantityExpected !== undefined || lineTotalPrice !== null),
    hasOnlyName: Boolean(name && !sku && quantityExpected === undefined && lineTotalPrice === null)
  };
}

function isPendingComplete(pending: PendingItem): pending is PendingItem & {
  sku: string;
  quantityExpected: number;
  lineTotalPrice: number;
} {
  return Boolean(
    pending.sku &&
      pending.nameParts.join(' ').trim() &&
      pending.quantityExpected !== undefined &&
      pending.quantityExpected > 0 &&
      pending.lineTotalPrice !== undefined
  );
}

function extractSubOrderId(text: string): string | null {
  const explicit = text.match(/\b(?:item|order|sub[-\s]?order)\s*(?:number|#|id)?\s*:?\s*(\d{4,6})\b/i);
  if (explicit) return explicit[1];
  const pab = text.match(/\bpick\s*a\s*brick\b.*?\b(\d{4,6})\b/i);
  return pab?.[1] ?? null;
}

function isPickABrickSectionHeader(text: string): boolean {
  return /\blego\b.*\bpick\s*a\s*brick\b/i.test(text) || /\bpick\s*a\s*brick\b.*\bitem\s*:?\s*\d{4,6}\b/i.test(text);
}

function extractExpectedLineCount(text: string): number | null {
  const match = text.match(/\bhide\s+parts\s*\((\d+)\)/i);
  return match ? Number(match[1]) : null;
}

function extractSubtotal(text: string): number | null {
  if (!/\bsubtotal\b/i.test(text)) return null;
  const match = text.match(/\$\s*\d{1,4}(?:,\d{3})*\.\d{2}\b/);
  return parseMoney(match?.[0]);
}

function extractBareSectionSubtotal(text: string): number | null {
  const prices = [...text.matchAll(/\$\s*\d{1,4}(?:,\d{3})*\.\d{2}\b/g)].map((match) => parseMoney(match[0])).filter((value): value is number => value !== null);
  return prices[0] ?? null;
}

function extractStatus(text: string): string | null {
  const match = text.match(/\bstatus\s*:?\s*(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function extractBareStatus(text: string): string | null {
  const match = text.match(/\b(In Warehouse|Shipped|Processing|Cancelled|Canceled|Backordered)\b/i);
  return match?.[1] ?? null;
}

function applySubOrderMetadata(subOrder: BrickCheckSubOrder, text: string, sectionHeader: boolean) {
  const expectedLineCount = extractExpectedLineCount(text);
  if (expectedLineCount !== null) subOrder.expectedLineCount = expectedLineCount;

  const subtotal = extractSubtotal(text) ?? (sectionHeader ? extractBareSectionSubtotal(text) : null);
  if (subtotal !== null) subOrder.subtotal = subtotal;

  const status = extractStatus(text) ?? (sectionHeader ? extractBareStatus(text) : null);
  if (status) subOrder.status = status;
}

function isMetadataLine(text: string): boolean {
  return /\b(order summary|shipping|payment|billing|tax|discount|order date|delivery|pick a brick subtotal|bricks and pieces|standard orders|shipped separately|your order|gift cards|sitemap|subscribe|support|faqs|contact|replacement parts|your email address|find inspiration|lego catalogs|find a lego store|track package|visit carrier tracking page)\b/i.test(text);
}

function looksLikeNonItemToken(text: string): boolean {
  return /^(item:?|sku:?|quantity:?|hide parts|status:?|subtotal:?|lego®?|pick a brick)$/i.test(text) || isMetadataLine(text);
}

function looksLikePartNameLine(text: string): boolean {
  if (!text.trim()) return false;
  if (isMetadataLine(text)) return false;
  return /\b(brick|plate|tile|roof|window|arch|tube|plant|leaf|leaves|grass|limb|flower|bamboo|scorpion|mini|bottle|slide|handle|carrot|kitchen|pot|sword|armour|candlestick|violin|pitchfork|shaft|shield|flame|bow|figure|trophy|hammer|revolver|profile|wig|head|helmet|cup|whip|cupcake|blade|knife|tool|nozzle|shooter|wall|box|cone|ice cream|fruit|telephone|accessory|hood|column|balustrade|rail|fence|cavity|hanger|door|ingot|radiator|palisade|design|element|function)\b/i.test(text);
}

function validateParsedOrder(
  subOrders: BrickCheckSubOrder[],
  items: BrickCheckItem[],
  parseWarnings: ParseWarning[],
  idFactory: (prefix: string) => string
) {
  const warn = (warning: Omit<ParseWarning, 'id'>) => {
    parseWarnings.push({ id: idFactory('warning'), ...warning });
  };

  for (const subOrder of subOrders) {
    const subItems = items.filter((item) => item.subOrderId === subOrder.id);
    subOrder.parsedLineCount = subItems.length;
    const parsedSubtotal = roundMoney(subItems.reduce((sum, item) => sum + item.lineTotalPrice, 0));
    if (subOrder.expectedLineCount > 0 && subOrder.expectedLineCount !== subOrder.parsedLineCount) {
      warn({
        severity: 'error',
        message: `Expected ${subOrder.expectedLineCount} parts but parsed ${subOrder.parsedLineCount}.`,
        subOrderId: subOrder.id
      });
    }
    if (subOrder.subtotal > 0 && parsedSubtotal !== subOrder.subtotal) {
      warn({
        severity: 'error',
        message: `Subtotal mismatch: PDF ${subOrder.subtotal.toFixed(2)} vs parsed ${parsedSubtotal.toFixed(2)}.`,
        subOrderId: subOrder.id
      });
    }
  }

  const expectedGrandTotal = roundMoney(subOrders.reduce((sum, subOrder) => sum + subOrder.subtotal, 0));
  const parsedGrandTotal = roundMoney(items.reduce((sum, item) => sum + item.lineTotalPrice, 0));
  if (expectedGrandTotal > 0 && expectedGrandTotal !== parsedGrandTotal) {
    warn({
      severity: 'error',
      message: `Grand total mismatch: PDF ${expectedGrandTotal.toFixed(2)} vs parsed ${parsedGrandTotal.toFixed(2)}.`
    });
  }
}

function normalizeName(name: string): string {
  return name.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
}

function estimateThumbnailCrop(page: number, rowYCenter: number): ThumbnailCrop {
  return {
    page,
    x: 42,
    y: Math.max(0, rowYCenter - 64),
    width: 92,
    height: 72,
    confidence: 'wide'
  };
}
