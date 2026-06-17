import type { BrickCheckItem } from './types';

export function mergeThumbnailCrops(existingItems: BrickCheckItem[], parsedItems: BrickCheckItem[]): BrickCheckItem[] {
  const exact = makeItemQueueMap(parsedItems, true);
  const skuOnly = makeItemQueueMap(parsedItems, false);
  const parsedBySubOrder = makeSubOrderQueueMap(parsedItems);
  const parsedGlobal = [...parsedItems];

  return existingItems.map((item) => {
    const exactMatch = exact.get(itemMatchKey(item, true))?.shift();
    const skuMatch = exactMatch ?? skuOnly.get(itemMatchKey(item, false))?.shift();
    const subOrderIndexMatch = skuMatch ?? parsedBySubOrder.get(item.subOrderId)?.shift();
    const globalIndexMatch = subOrderIndexMatch ?? parsedGlobal.shift();
    const thumbnailCrop = globalIndexMatch?.thumbnailCrop ?? item.thumbnailCrop;
    return { ...item, thumbnailCrop };
  });
}

function makeItemQueueMap(items: BrickCheckItem[], includeName: boolean) {
  const map = new Map<string, BrickCheckItem[]>();
  for (const item of items) {
    const key = itemMatchKey(item, includeName);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}

function makeSubOrderQueueMap(items: BrickCheckItem[]) {
  const map = new Map<string, BrickCheckItem[]>();
  for (const item of items) {
    map.set(item.subOrderId, [...(map.get(item.subOrderId) ?? []), item]);
  }
  return map;
}

function itemMatchKey(item: BrickCheckItem, includeName: boolean) {
  const pieces = [item.subOrderId, item.sku];
  if (includeName) pieces.push(normalizeItemNameForMatch(item.name));
  return pieces.join('|');
}

function normalizeItemNameForMatch(name: string) {
  return name.toLowerCase().replace(/[^\w]+/g, ' ').replace(/\s+/g, ' ').trim();
}
