import Dexie, { type Table } from 'dexie';
import type { BrickCheckItem, BrickCheckOrder } from './types';
import { makeId } from './lib/id';

export interface StoredThumbnail {
  id: string;
  orderId: string;
  itemId: string;
  blob: Blob;
  createdAt: string;
}

export class BrickCheckDatabase extends Dexie {
  orders!: Table<BrickCheckOrder, string>;
  thumbnails!: Table<StoredThumbnail, string>;

  constructor() {
    super('brickcheck');
    this.version(1).stores({
      orders: 'id, createdAt, sourcePdfName',
      thumbnails: 'id, orderId, itemId'
    });
  }
}

export const db = new BrickCheckDatabase();

export async function saveOrder(order: BrickCheckOrder, thumbnailBlobs = new Map<string, Blob>()) {
  const orderToSave = structuredClone(order);
  const now = new Date().toISOString();

  await db.transaction('rw', db.orders, db.thumbnails, async () => {
    for (const item of orderToSave.items) {
      const blob = thumbnailBlobs.get(item.id);
      if (!blob) continue;
      const thumbnailId = makeId('thumb');
      item.thumbnailBlobId = thumbnailId;
      await db.thumbnails.put({
        id: thumbnailId,
        orderId: orderToSave.id,
        itemId: item.id,
        blob,
        createdAt: now
      });
    }
    await db.orders.put(orderToSave);
  });

  return orderToSave;
}

export async function listOrders() {
  return db.orders.orderBy('createdAt').reverse().toArray();
}

export async function getOrder(id: string) {
  return db.orders.get(id);
}

export async function deleteOrder(id: string) {
  await db.transaction('rw', db.orders, db.thumbnails, async () => {
    await db.orders.delete(id);
    await db.thumbnails.where('orderId').equals(id).delete();
  });
}

export async function updateOrder(order: BrickCheckOrder) {
  await db.orders.put(order);
}

export async function replaceOrderThumbnails(order: BrickCheckOrder, thumbnailBlobs: Map<string, Blob>) {
  const orderToSave = structuredClone(order);
  const now = new Date().toISOString();

  await db.transaction('rw', db.orders, db.thumbnails, async () => {
    await db.thumbnails.where('orderId').equals(orderToSave.id).delete();
    for (const item of orderToSave.items) {
      item.thumbnailBlobId = undefined;
      const blob = thumbnailBlobs.get(item.id);
      if (!blob) continue;
      const thumbnailId = makeId('thumb');
      item.thumbnailBlobId = thumbnailId;
      await db.thumbnails.put({
        id: thumbnailId,
        orderId: orderToSave.id,
        itemId: item.id,
        blob,
        createdAt: now
      });
    }
    await db.orders.put(orderToSave);
  });

  return orderToSave;
}

export async function countOrderThumbnails(orderId: string): Promise<number> {
  return db.thumbnails.where('orderId').equals(orderId).count();
}

export function updateItem(order: BrickCheckOrder, itemId: string, updater: (item: BrickCheckItem) => BrickCheckItem): BrickCheckOrder {
  return {
    ...order,
    items: order.items.map((item) => (item.id === itemId ? updater(item) : item))
  };
}

export async function getThumbnailUrl(thumbnailBlobId?: string): Promise<string | undefined> {
  if (!thumbnailBlobId) return undefined;
  const record = await db.thumbnails.get(thumbnailBlobId);
  return record ? URL.createObjectURL(record.blob) : undefined;
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
