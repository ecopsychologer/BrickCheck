import type { BrickCheckItem, PartFamily, RiskTag, RouteGroup, RouteMode, ScoringSettings } from './types';
import { roundMoney } from './lib/money';

export const defaultScoringSettings: ScoringSettings = {
  lineTotalWeight: 0.35,
  costDensityWeight: 0.25,
  visualBulkWeight: 0.15,
  quantityWeight: 0.1,
  riskWeight: 0.1,
  ambiguityWeight: 0.05
};

const familyDefaults: Record<PartFamily, { volume: number; confidence: 'medium' | 'low' }> = {
  bricks: { volume: 2, confidence: 'medium' },
  plates_tiles: { volume: 0.7, confidence: 'medium' },
  slopes_arches: { volume: 1.5, confidence: 'medium' },
  plants_foliage: { volume: 0.4, confidence: 'low' },
  minifig_parts: { volume: 0.35, confidence: 'low' },
  minifig_accessories: { volume: 0.25, confidence: 'low' },
  animals_food_objects: { volume: 0.8, confidence: 'low' },
  bars_tubes_connectors: { volume: 0.4, confidence: 'low' },
  unknown: { volume: 1, confidence: 'low' }
};

export function classifyPartFamily(name: string): PartFamily {
  const normalized = name.toLowerCase();
  if (/\b(mini|minifig|mini figure|torso|leg|head|hair|helmet)\b/.test(normalized)) return 'minifig_parts';
  if (/\b(sword|weapon|tool|broom|wand|cup|mug|shield|backpack|accessory)\b/.test(normalized)) return 'minifig_accessories';
  if (/\b(plant|leaf|leaves|flower|stem|tree|foliage|bush)\b/.test(normalized)) return 'plants_foliage';
  if (/\b(animal|dog|cat|horse|bird|fish|frog|snake|rat|food|croissant|banana|carrot)\b/.test(normalized)) return 'animals_food_objects';
  if (/\b(bar|tube|hose|connector|shaft|pin|clip|holder)\b/.test(normalized)) return 'bars_tubes_connectors';
  if (/\b(slope|roof tile|arch|bow|wedge)\b/.test(normalized)) return 'slopes_arches';
  if (/\b(plate|tile|flat tile|round tile)\b/.test(normalized)) return 'plates_tiles';
  if (/\b(brick|block|wall element)\b/.test(normalized)) return 'bricks';
  return 'unknown';
}

export function estimateVolume(name: string): { estimatedVolume: number; volumeConfidence: 'high' | 'medium' | 'low' } {
  const normalized = name.toUpperCase();
  const family = classifyPartFamily(name);
  const compact = normalized.replace(/(\d+)\/(\d+)°/g, '$1 DEG $2');
  const match = compact.match(/\b(\d+(?:\/\d+)?)X(\d+(?:\/\d+)?)(?:X(\d+(?:\/\d+)?))?\b/);
  if (match) {
    const dimensions = match.slice(1).filter(Boolean).map(parseDimension);
    if (dimensions.every((dimension) => dimension > 0)) {
      const baseHeight = family === 'plates_tiles' ? 0.33 : 1;
      const volume = dimensions.length === 2 ? dimensions[0] * dimensions[1] * baseHeight : dimensions.reduce((a, b) => a * b, 1);
      return {
        estimatedVolume: clamp(volume, 0.1, 96),
        volumeConfidence: 'high'
      };
    }
  }

  const fallback = familyDefaults[family];
  return { estimatedVolume: fallback.volume, volumeConfidence: fallback.confidence };
}

function parseDimension(value: string): number {
  if (value.includes('/')) {
    const [top, bottom] = value.split('/').map(Number);
    return bottom ? top / bottom : 0;
  }
  return Number(value);
}

export function riskTagsForItem(input: {
  name: string;
  quantityExpected: number;
  unitPrice: number;
  estimatedVolume: number;
}): RiskTag[] {
  const tags = new Set<RiskTag>();
  const normalized = input.name.toLowerCase();
  if (input.quantityExpected === 1) tags.add('quantityOne');
  if (input.estimatedVolume <= 0.45) tags.add('tiny');
  if (input.unitPrice >= 1) tags.add('highUnitPrice');
  if (/\b(animal|dog|cat|horse|bird|fish|frog|snake|rat)\b/.test(normalized)) tags.add('animal');
  if (/\b(mini|minifig|torso|leg|head|hair|helmet)\b/.test(normalized)) tags.add('minifig');
  const decoratedKeyword = /\b(print|printed|decorated|pattern|sticker|stickered)\b/.test(normalized);
  const numberedSurfaceVariant = /\b(tile|brick|plate|slope|roof tile)\b/.test(normalized) && (/"[^"]+"/.test(input.name) || /\bno\.\s*\d+\b/i.test(input.name));
  const specialtyProcess = /\b(co-inj|dual mold|dual-mold|glow|metallic|pearl|chrome|opalescent)\b/.test(normalized);
  if (decoratedKeyword || numberedSurfaceVariant) tags.add('printedDecorated');
  if (decoratedKeyword || numberedSurfaceVariant || specialtyProcess || input.unitPrice >= 1.5) tags.add('specialtyVariant');
  if (/\b(plant|leaf|leaves|flower|stem|tree|foliage|bush)\b/.test(normalized)) tags.add('plant');
  if (/\b(sword|weapon|tool|axe|hammer|wrench|wand|knife|blaster)\b/.test(normalized)) tags.add('weaponTool');
  if (/\b(accessory|cup|mug|shield|backpack|book|basket)\b/.test(normalized)) tags.add('accessory');
  if (/\b(trans|transparent|translucent|clear)\b/.test(normalized)) tags.add('transparent');
  if (/\b(pearl|sand|tan|dark tan|light bluish gray|medium nougat|transparent|trans)\b/.test(normalized)) tags.add('easyToMissColor');
  return [...tags];
}

export function scoreItem(
  item: Pick<BrickCheckItem, 'lineTotalPrice' | 'costDensity' | 'visualBulk' | 'quantityExpected' | 'riskTags' | 'volumeConfidence'>,
  maxima: { lineTotalPrice: number; costDensity: number; visualBulk: number; quantityExpected: number },
  settings: ScoringSettings = defaultScoringSettings
): number {
  const riskBonus = clamp(item.riskTags.length / 5, 0, 1);
  const ambiguityBonus = item.volumeConfidence === 'high' ? 0 : item.volumeConfidence === 'medium' ? 0.45 : 1;
  const score =
    settings.lineTotalWeight * normalize(item.lineTotalPrice, maxima.lineTotalPrice) +
    settings.costDensityWeight * normalize(item.costDensity, maxima.costDensity) +
    settings.visualBulkWeight * normalize(item.visualBulk, maxima.visualBulk) +
    settings.quantityWeight * normalize(item.quantityExpected, maxima.quantityExpected) +
    settings.riskWeight * riskBonus +
    settings.ambiguityWeight * ambiguityBonus;
  return Math.round(score * 1000);
}

export function calculateValueDensity(unitPrice: number, estimatedVolume: number, riskTags: RiskTag[]): number {
  const baseDensity = unitPrice / Math.max(estimatedVolume, 0.1);
  if (riskTags.includes('printedDecorated')) return roundMoney(Math.max(baseDensity, 1.5));
  if (riskTags.includes('specialtyVariant')) return roundMoney(Math.max(baseDensity, 1));
  return roundMoney(baseDensity);
}

export function assignRouteGroup(item: Pick<BrickCheckItem, 'riskTags' | 'costDensity' | 'quantityExpected' | 'visualBulk'>, mode: RouteMode): RouteGroup {
  const treasureRisk = item.riskTags.some((tag) =>
    ['quantityOne', 'tiny', 'highUnitPrice', 'minifig', 'printedDecorated', 'animal', 'accessory', 'transparent', 'specialtyVariant'].includes(tag)
  );
  const isTreasure = treasureRisk || (item.costDensity >= 1.2 && item.quantityExpected <= 8);
  const isBulk = item.quantityExpected >= 12 || item.visualBulk >= 10;

  if (mode === 'treasure') return isTreasure ? 'treasure' : 'cleanup';
  if (mode === 'bulk') return isBulk ? 'bulk' : 'cleanup';
  if (isTreasure) return 'treasure';
  if (isBulk) return 'bulk';
  return 'cleanup';
}

export function enrichParsedItems<T extends Omit<BrickCheckItem, 'estimatedVolume' | 'volumeConfidence' | 'visualBulk' | 'costDensity' | 'partFamily' | 'riskTags' | 'priorityScore' | 'routeGroup'>>(
  items: T[],
  routeMode: RouteMode = 'hybrid',
  settings: ScoringSettings = defaultScoringSettings
): BrickCheckItem[] {
  const firstPass = items.map((item) => {
    const partFamily = classifyPartFamily(item.name);
    const { estimatedVolume, volumeConfidence } = estimateVolume(item.name);
    const unitPrice = roundMoney(item.unitPrice);
    const visualBulk = roundMoney(estimatedVolume * item.quantityExpected);
    const riskTags = riskTagsForItem({ name: item.name, quantityExpected: item.quantityExpected, unitPrice, estimatedVolume });
    const costDensity = calculateValueDensity(unitPrice, estimatedVolume, riskTags);
    return {
      ...item,
      unitPrice,
      estimatedVolume,
      volumeConfidence,
      visualBulk,
      costDensity,
      partFamily,
      riskTags,
      priorityScore: 0,
      routeGroup: 'cleanup' as RouteGroup
    };
  });

  const maxima = {
    lineTotalPrice: Math.max(...firstPass.map((item) => item.lineTotalPrice), 1),
    costDensity: Math.max(...firstPass.map((item) => item.costDensity), 1),
    visualBulk: Math.max(...firstPass.map((item) => item.visualBulk), 1),
    quantityExpected: Math.max(...firstPass.map((item) => item.quantityExpected), 1)
  };

  return firstPass.map((item) => ({
    ...item,
    priorityScore: scoreItem(item, maxima, settings),
    routeGroup: assignRouteGroup(item, routeMode)
  }));
}

export function rescoreItems(items: BrickCheckItem[], routeMode: RouteMode, settings: ScoringSettings = defaultScoringSettings): BrickCheckItem[] {
  const maxima = {
    lineTotalPrice: Math.max(...items.map((item) => item.lineTotalPrice), 1),
    costDensity: Math.max(...items.map((item) => item.costDensity), 1),
    visualBulk: Math.max(...items.map((item) => item.visualBulk), 1),
    quantityExpected: Math.max(...items.map((item) => item.quantityExpected), 1)
  };

  return items.map((item) => ({
    ...item,
    priorityScore: scoreItem(item, maxima, settings),
    routeGroup: assignRouteGroup(item, routeMode)
  }));
}

function normalize(value: number, max: number): number {
  return max > 0 ? clamp(value / max, 0, 1) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
