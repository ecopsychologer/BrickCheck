import type {
  BrickCheckItem,
  ChecklistSettings,
  ChecklistSortKey,
  ChecklistStatusFilter,
  PartFamily,
  RouteGroup,
  RouteMode
} from './types';
import { orderChecklistItems } from './ordering';

export const defaultChecklistSettings: ChecklistSettings = {
  moveFoundToDoneList: true,
  statusFilter: 'open',
  familyFilter: 'all',
  routeFilter: 'all',
  subOrderFilter: 'all',
  sortKey: 'route',
  routeMode: 'hybrid',
  thumbnailSize: 'medium',
  search: ''
};

export function normalizeChecklistSettings(settings?: Partial<ChecklistSettings>): ChecklistSettings {
  return { ...defaultChecklistSettings, ...settings };
}

export function getSearchText(item: BrickCheckItem): string {
  return normalizeSearch(
    [
      item.name,
      item.sku,
      item.partFamily,
      item.routeGroup,
      item.riskTags.join(' '),
      brickLinkishAliases(item.name),
      brickArchitectishAliases(item.name)
    ].join(' ')
  );
}

export function filterChecklistItems(items: BrickCheckItem[], settings: ChecklistSettings): BrickCheckItem[] {
  const query = normalizeSearch(settings.search);
  return items.filter((item) => {
    if (!matchesStatus(item, settings.statusFilter)) return false;
    if (settings.subOrderFilter !== 'all' && item.subOrderId !== settings.subOrderFilter) return false;
    if (settings.familyFilter !== 'all' && item.partFamily !== settings.familyFilter) return false;
    if (settings.routeFilter !== 'all' && item.routeGroup !== settings.routeFilter) return false;
    if (query && !getSearchText(item).includes(query)) return false;
    return true;
  });
}

export function sortChecklistItems(items: BrickCheckItem[], sortKey: ChecklistSortKey): BrickCheckItem[] {
  return [...items].sort((a, b) => {
    switch (sortKey) {
      case 'quantity':
        return b.quantityExpected - a.quantityExpected || b.priorityScore - a.priorityScore;
      case 'lineTotal':
        return b.lineTotalPrice - a.lineTotalPrice || b.priorityScore - a.priorityScore;
      case 'unitPrice':
        return b.unitPrice - a.unitPrice || b.priorityScore - a.priorityScore;
      case 'costDensity':
        return b.costDensity - a.costDensity || b.priorityScore - a.priorityScore;
      case 'visualBulk':
        return b.visualBulk - a.visualBulk || b.quantityExpected - a.quantityExpected;
      case 'family':
        return a.partFamily.localeCompare(b.partFamily) || a.name.localeCompare(b.name);
      case 'name':
        return a.name.localeCompare(b.name);
      case 'priority':
        return b.priorityScore - a.priorityScore || b.costDensity - a.costDensity;
      case 'route':
      default:
        return routeRank(a.routeGroup) - routeRank(b.routeGroup) || b.priorityScore - a.priorityScore || a.name.localeCompare(b.name);
    }
  });
}

export function splitChecklistItems(items: BrickCheckItem[], settings: ChecklistSettings) {
  const filteredWithoutStatus = filterChecklistItems(items, { ...settings, statusFilter: 'all' });
  const sorted = sortForSettings(filteredWithoutStatus, settings.sortKey, settings.routeMode);
  if (!settings.moveFoundToDoneList) {
    return {
      active: sorted.filter((item) => matchesStatus(item, settings.statusFilter)),
      done: []
    };
  }

  const showDone = settings.statusFilter === 'open' || settings.statusFilter === 'all' || settings.statusFilter === 'found';
  return {
    active: settings.statusFilter === 'found'
      ? []
      : sorted.filter((item) => item.status !== 'found' && matchesStatus(item, settings.statusFilter)),
    done: showDone ? sorted.filter((item) => item.status === 'found') : []
  };
}

function sortForSettings(items: BrickCheckItem[], sortKey: ChecklistSortKey, routeMode: RouteMode): BrickCheckItem[] {
  return sortKey === 'route' ? orderChecklistItems(items, routeMode) : sortChecklistItems(items, sortKey);
}

function matchesStatus(item: BrickCheckItem, statusFilter: ChecklistStatusFilter): boolean {
  if (statusFilter === 'all') return true;
  if (statusFilter === 'open') return item.status !== 'found';
  return item.status === statusFilter;
}

function routeRank(routeGroup: RouteGroup): number {
  if (routeGroup === 'treasure') return 0;
  if (routeGroup === 'bulk') return 1;
  return 2;
}

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[^\w]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function brickLinkishAliases(name: string): string {
  const lower = name.toLowerCase();
  const aliases: string[] = [];
  if (/\bflat tile\b/.test(lower)) aliases.push(name.replace(/flat tile/gi, 'tile'));
  if (/\bprofile brick\b/.test(lower)) aliases.push('masonry brick brick modified profile brick');
  if (/\bpal(is|i)sade brick\b/.test(lower)) aliases.push('palisade brick log brick');
  if (/\bplate\b.*\bknob\b/.test(lower)) aliases.push('jumper plate modified plate stud');
  if (/\bround\b/.test(lower)) aliases.push('round');
  if (/\bno\.\s*\d+\b/i.test(name) || /"[^"]+"/.test(name)) aliases.push('printed decorated patterned special variant');
  if (/\bmini\b/.test(lower)) aliases.push('minifigure minifig');
  if (/\bwig\b/.test(lower)) aliases.push('hair minifigure hair');
  if (/\bupper part\b/.test(lower)) aliases.push('torso body minifigure torso');
  if (/\blower part\b/.test(lower)) aliases.push('legs minifigure legs');
  return aliases.join(' ');
}

function brickArchitectishAliases(name: string): string {
  const lower = name.toLowerCase();
  const aliases: string[] = [];
  if (/\bbrick\b/.test(lower)) aliases.push('brick');
  if (/\bplate\b/.test(lower)) aliases.push('plate');
  if (/\btile\b/.test(lower)) aliases.push('tile');
  if (/\bslope|roof tile|wedge\b/.test(lower)) aliases.push('slope wedge roof');
  if (/\bbar|clip|shaft|tube|hose|connector\b/.test(lower)) aliases.push('bar clip connector tube');
  if (/\bplant|leaf|leaves|flower|grass\b/.test(lower)) aliases.push('plant foliage');
  if (/\banimal|scorpion|frog|bird|horse|dog|cat\b/.test(lower)) aliases.push('animal creature');
  return aliases.join(' ');
}
