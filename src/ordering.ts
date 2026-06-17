import type { BrickCheckItem, RouteMode } from './types';

const routeRank = {
  treasure: 0,
  bulk: 1,
  cleanup: 2
};

export function orderChecklistItems(items: BrickCheckItem[], mode: RouteMode) {
  return [...items].sort((a, b) => {
    if (mode === 'hybrid' && routeRank[a.routeGroup] !== routeRank[b.routeGroup]) {
      return routeRank[a.routeGroup] - routeRank[b.routeGroup];
    }
    if (mode === 'bulk') {
      return b.visualBulk - a.visualBulk || b.quantityExpected - a.quantityExpected || b.priorityScore - a.priorityScore;
    }
    if (mode === 'treasure') {
      return b.priorityScore - a.priorityScore || b.costDensity - a.costDensity;
    }
    return b.priorityScore - a.priorityScore || a.partFamily.localeCompare(b.partFamily) || a.name.localeCompare(b.name);
  });
}
