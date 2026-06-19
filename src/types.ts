export type ItemStatus = 'unchecked' | 'found' | 'partial' | 'missing' | 'unsure';

export type ParseWarningSeverity = 'info' | 'warning' | 'error';

export type PartFamily =
  | 'bricks'
  | 'plates_tiles'
  | 'slopes_arches'
  | 'plants_foliage'
  | 'minifig_parts'
  | 'minifig_accessories'
  | 'animals_food_objects'
  | 'bars_tubes_connectors'
  | 'unknown';

export type RiskTag =
  | 'quantityOne'
  | 'tiny'
  | 'highUnitPrice'
  | 'animal'
  | 'minifig'
  | 'printedDecorated'
  | 'plant'
  | 'weaponTool'
  | 'accessory'
  | 'transparent'
  | 'easyToMissColor'
  | 'specialtyVariant';

export type RouteMode = 'treasure' | 'bulk' | 'hybrid';

export type RouteGroup = 'treasure' | 'bulk' | 'cleanup';

export type ChecklistStatusFilter = 'all' | 'open' | 'unchecked' | 'partial' | 'missing' | 'found';

export type ChecklistSortKey = 'route' | 'priority' | 'quantity' | 'lineTotal' | 'unitPrice' | 'costDensity' | 'visualBulk' | 'family' | 'name';

export type ThumbnailSize = 'small' | 'medium' | 'large';

export interface ChecklistSettings {
  moveFoundToDoneList: boolean;
  statusFilter: ChecklistStatusFilter;
  familyFilter: PartFamily | 'all';
  routeFilter: RouteGroup | 'all';
  subOrderFilter: string;
  sortKey: ChecklistSortKey;
  routeMode: RouteMode;
  thumbnailSize: ThumbnailSize;
  search: string;
}

export interface ThumbnailCrop {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: 'exact' | 'wide' | 'failed';
}

export interface ParseWarning {
  id: string;
  severity: ParseWarningSeverity;
  message: string;
  subOrderId?: string;
  sku?: string;
  sourcePage?: number;
}

export interface BrickCheckSubOrder {
  id: string;
  legoItemNumber: string;
  subtotal: number;
  expectedLineCount: number;
  parsedLineCount: number;
  status: string;
}

export interface BrickCheckItem {
  id: string;
  source: 'pdf' | 'manual' | 'csv';
  sourcePdfName: string;
  sourcePage: number;
  subOrderId: string;
  sku: string;
  name: string;
  quantityExpected: number;
  quantityFound: number;
  lineTotalPrice: number;
  unitPrice: number;
  thumbnailBlobId?: string;
  thumbnailCrop?: ThumbnailCrop;
  estimatedVolume: number;
  volumeConfidence: 'high' | 'medium' | 'low';
  visualBulk: number;
  costDensity: number;
  partFamily: PartFamily;
  riskTags: RiskTag[];
  priorityScore: number;
  routeGroup: RouteGroup;
  status: ItemStatus;
  notes: string;
}

export interface BrickCheckOrder {
  id: string;
  name: string;
  createdAt: string;
  sourcePdfName: string;
  subOrders: BrickCheckSubOrder[];
  items: BrickCheckItem[];
  parseWarnings: ParseWarning[];
  checklistSettings?: ChecklistSettings;
}

export interface ScoringSettings {
  lineTotalWeight: number;
  costDensityWeight: number;
  visualBulkWeight: number;
  quantityWeight: number;
  riskWeight: number;
  ambiguityWeight: number;
}

export interface ProviderSearchResult {
  sku: string;
  name: string;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface PartsMetadataProvider {
  readonly id: string;
  readonly enabledByDefault: boolean;
  lookupBySku(sku: string): Promise<ProviderSearchResult | null>;
}
