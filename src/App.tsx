import { useEffect, useMemo, useState } from 'react';
import type { BrickCheckItem, BrickCheckOrder, ChecklistSettings, ChecklistSortKey, ChecklistStatusFilter, PartFamily, RouteGroup, RouteMode, ScoringSettings } from './types';
import { createThumbnailExtractionDiagnostics, parsePdfFile, extractThumbnailBlobs, type ImportProgress } from './pdf';
import { countOrderThumbnails, deleteOrder, getThumbnailUrl, listOrders, replaceOrderThumbnails, requestPersistentStorage, saveOrder, updateItem, updateOrder } from './db';
import { formatMoney } from './lib/money';
import { buildMissingReportRows, downloadText, generateMissingReportCsv } from './exportReport';
import { defaultScoringSettings, rescoreItems } from './scoring';
import { normalizeChecklistSettings, splitChecklistItems } from './checklist';
import { mergeThumbnailCrops } from './thumbnailMatch';

type Screen = 'home' | 'review' | 'dashboard' | 'checklist' | 'settings' | 'export';

interface DraftImport {
  order: BrickCheckOrder;
  thumbnails: Map<string, Blob>;
}

const IMPORT_DIAGNOSTIC_KEY = 'brickcheck.lastImportDiagnostic';

const statusLabels: Record<BrickCheckItem['status'], string> = {
  unchecked: 'Unchecked',
  found: 'Found',
  partial: 'Partial',
  missing: 'Missing',
  unsure: 'Unsure'
};

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [orders, setOrders] = useState<BrickCheckOrder[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<BrickCheckOrder | null>(null);
  const [draftImport, setDraftImport] = useState<DraftImport | null>(null);
  const [settings, setSettings] = useState<ScoringSettings>(() => loadSettings());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [importDiagnostic, setImportDiagnostic] = useState(() => loadImportDiagnostic());
  const [photoDiagnostic, setPhotoDiagnostic] = useState('');
  const [editingItem, setEditingItem] = useState<BrickCheckItem | null>(null);

  useEffect(() => {
    refreshOrders();
    requestPersistentStorage();
  }, []);

  async function refreshOrders(focusOrderId = selectedOrder?.id) {
    const stored = await listOrders();
    setOrders(stored);
    if (focusOrderId) {
      setSelectedOrder(stored.find((order) => order.id === focusOrderId) ?? null);
    }
  }

  async function handleImport(file: File) {
    setBusy(true);
    setMessage('Importing PDF...');
    let importFailed = false;
    let lastProgress: ImportProgress = { phase: 'loading', current: 0, total: 1, message: 'Starting import' };
    let lastRecordedProgress: ImportProgress | undefined;
    const trackProgress = (progress: ImportProgress) => {
      lastProgress = progress;
      setImportProgress(progress);
      if (
        !lastRecordedProgress
        || progress.phase !== lastRecordedProgress.phase
        || progress.current === 0
        || progress.current === progress.total
        || progress.current % 10 === 0
      ) {
        persistImportDiagnostic(setImportDiagnostic, createImportDiagnostic({
          file,
          outcome: 'running',
          progress
        }));
        lastRecordedProgress = progress;
      }
    };
    trackProgress(lastProgress);
    persistImportDiagnostic(setImportDiagnostic, createImportDiagnostic({
      file,
      outcome: 'started',
      progress: lastProgress
    }));
    const captureUnhandledError = (error: unknown, outcome: string) => {
      persistImportDiagnostic(setImportDiagnostic, createImportDiagnostic({
        file,
        outcome,
        progress: lastProgress,
        error
      }));
    };
    const onWindowError = (event: ErrorEvent) => captureUnhandledError(
      event.error ?? new Error(`${event.message} at ${event.filename}:${event.lineno}:${event.colno}`),
      'uncaught-window-error'
    );
    const onUnhandledRejection = (event: PromiseRejectionEvent) => captureUnhandledError(event.reason, 'unhandled-rejection');
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    try {
      const result = await parsePdfFile(file, trackProgress);
      persistImportDiagnostic(setImportDiagnostic, createImportDiagnostic({
        file,
        outcome: 'parsed',
        progress: lastProgress,
        extra: {
          parsedItems: result.order.items.length,
          subOrders: result.order.subOrders.length,
          parseWarnings: result.order.parseWarnings.map((warning) => ({
            severity: warning.severity,
            message: warning.message,
            subOrderId: warning.subOrderId
          }))
        }
      }));
      let thumbnails = new Map<string, Blob>();
      let thumbnailDiagnostics = createThumbnailExtractionDiagnostics(result.order.items.length);
      try {
        thumbnailDiagnostics = createThumbnailExtractionDiagnostics(result.order.items.length);
        thumbnails = await extractThumbnailBlobs(file, result.order.items, trackProgress, thumbnailDiagnostics);
        if (thumbnails.size === 0 && result.order.items.length > 0) {
          result.order.parseWarnings.push({
            id: `warning_${Date.now()}`,
            severity: 'warning',
            message: `Thumbnail extraction produced 0 images. ${thumbnailDiagnostics.pageErrors.slice(0, 2).join(' ')}`
          });
        }
      } catch (thumbnailError) {
        result.order.parseWarnings.push({
          id: `warning_${Date.now()}`,
          severity: 'warning',
          message: 'Thumbnail extraction failed for this PDF. Checklist still works.'
        });
        persistImportDiagnostic(setImportDiagnostic, createImportDiagnostic({
          file,
          outcome: 'thumbnail-warning',
          progress: lastProgress,
          error: thumbnailError,
          extra: { thumbnailDiagnostics }
        }));
      }
      trackProgress({ phase: 'done', current: 1, total: 1, message: 'Import ready to review' });
      persistImportDiagnostic(setImportDiagnostic, createImportDiagnostic({
        file,
        outcome: 'success',
        progress: lastProgress,
        extra: {
          parsedItems: result.order.items.length,
          subOrders: result.order.subOrders.length,
          thumbnailsGenerated: thumbnails.size,
          thumbnailDiagnostics,
          parseWarnings: result.order.parseWarnings.map((warning) => ({
            severity: warning.severity,
            message: warning.message,
            subOrderId: warning.subOrderId
          }))
        }
      }));
      setDraftImport({ order: result.order, thumbnails });
      setScreen('review');
      setMessage('');
    } catch (error) {
      importFailed = true;
      const diagnostic = createImportDiagnostic({
        file,
        outcome: 'failure',
        progress: lastProgress,
        error
      });
      persistImportDiagnostic(setImportDiagnostic, diagnostic);
      setMessage(`${error instanceof Error ? error.message : 'Import failed.'} Import diagnostics are shown below.`);
    } finally {
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      setBusy(false);
      if (!importFailed) {
        setTimeout(() => setImportProgress(null), 700);
      }
    }
  }

  async function rebuildThumbnails(file: File) {
    if (!selectedOrder) return;
    setBusy(true);
    setMessage('');
    setPhotoDiagnostic(`Photo rebuild started for ${selectedOrder.name}\nFile: ${file.name}`);
    setImportProgress({ phase: 'loading', current: 0, total: 1, message: 'Reading PDF for photo positions' });
    try {
      const savedWithCropBefore = selectedOrder.items.filter((item) => item.thumbnailCrop).length;
      const savedWithThumbBefore = selectedOrder.items.filter((item) => item.thumbnailBlobId).length;
      const storedThumbRowsBefore = await countOrderThumbnails(selectedOrder.id);
      const parsed = await parsePdfFile(file, setImportProgress);
      const itemsWithFreshCrops = mergeThumbnailCrops(selectedOrder.items, parsed.order.items);
      const itemsWithCropsCount = itemsWithFreshCrops.filter((item) => item.thumbnailCrop).length;
      const parsedCropsCount = parsed.order.items.filter((item) => item.thumbnailCrop).length;
      const preExtractDiagnostic = {
        fileName: file.name,
        savedOrderName: selectedOrder.name,
        savedSourcePdfName: selectedOrder.sourcePdfName,
        savedItems: selectedOrder.items.length,
        savedWithCropBefore,
        savedWithThumbIdBefore: savedWithThumbBefore,
        storedThumbRowsBefore,
        parsedOrderName: parsed.order.name,
        parsedItems: parsed.order.items.length,
        parsedWithCrop: parsedCropsCount,
        parsedWarnings: parsed.order.parseWarnings.map((warning) => warning.message),
        matchedWithCrop: itemsWithCropsCount
      };
      setPhotoDiagnostic(JSON.stringify(preExtractDiagnostic, null, 2));
      setImportProgress({ phase: 'thumbnails', current: 0, total: Math.max(itemsWithCropsCount, 1), message: `Rebuilding ${itemsWithCropsCount} photos` });
      const extractionDiagnostics = createThumbnailExtractionDiagnostics(itemsWithFreshCrops.length);
      const thumbnails = await extractThumbnailBlobs(file, itemsWithFreshCrops, setImportProgress, extractionDiagnostics);
      const updated = await replaceOrderThumbnails({ ...selectedOrder, items: itemsWithFreshCrops }, thumbnails);
      const storedThumbRowsAfter = await countOrderThumbnails(updated.id);
      setPhotoDiagnostic(JSON.stringify({
        ...preExtractDiagnostic,
        extractionDiagnostics,
        generatedThumbnailBlobs: thumbnails.size,
        updatedWithThumbIdAfter: updated.items.filter((item) => item.thumbnailBlobId).length,
        storedThumbRowsAfter,
        firstUpdatedItems: updated.items.slice(0, 5).map((item) => ({
          sku: item.sku,
          name: item.name,
          hasCrop: Boolean(item.thumbnailCrop),
          hasThumbId: Boolean(item.thumbnailBlobId)
        }))
      }, null, 2));
      await refreshOrders(updated.id);
      setImportProgress({ phase: 'done', current: 1, total: 1, message: `Rebuilt ${thumbnails.size} photos` });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Photo rebuild failed.';
      setMessage(errorMessage);
      setPhotoDiagnostic((current) => `${current}\n\nERROR: ${errorMessage}`.trim());
    } finally {
      setBusy(false);
      setTimeout(() => setImportProgress(null), 1200);
    }
  }

  async function commitDraft() {
    if (!draftImport) return;
    setBusy(true);
    setImportProgress({ phase: 'saving', current: 0, total: 1, message: 'Saving order locally' });
    const saved = await saveOrder(draftImport.order, draftImport.thumbnails);
    setDraftImport(null);
    await refreshOrders(saved.id);
    setImportProgress({ phase: 'done', current: 1, total: 1, message: 'Saved locally' });
    setBusy(false);
    setTimeout(() => setImportProgress(null), 700);
    setScreen('dashboard');
  }

  async function persistOrder(order: BrickCheckOrder) {
    setSelectedOrder(order);
    setOrders((current) => current.map((stored) => (stored.id === order.id ? order : stored)));
    await updateOrder(order);
  }

  async function setItemStatus(item: BrickCheckItem, status: BrickCheckItem['status'], quantityFound = item.quantityFound) {
    if (!selectedOrder) return;
    const next = updateItem(selectedOrder, item.id, (current) => ({
      ...current,
      status,
      quantityFound,
      notes: current.notes
    }));
    await persistOrder(next);
  }

  async function saveItem(item: BrickCheckItem) {
    if (!selectedOrder) return;
    const next = updateItem(selectedOrder, item.id, () => item);
    setEditingItem(null);
    await persistOrder(next);
  }

  async function removeSelectedOrder() {
    if (!selectedOrder) return;
    await deleteOrder(selectedOrder.id);
    setSelectedOrder(null);
    await refreshOrders();
    setScreen('home');
  }

  async function applyScoring(nextSettings: ScoringSettings) {
    setSettings(nextSettings);
    localStorage.setItem('brickcheck.scoring', JSON.stringify(nextSettings));
    if (!selectedOrder) return;
    const routeMode = normalizeChecklistSettings(selectedOrder.checklistSettings).routeMode;
    const next = { ...selectedOrder, items: rescoreItems(selectedOrder.items, routeMode, nextSettings) };
    await persistOrder(next);
  }

  async function updateChecklistSettings(patch: Partial<ChecklistSettings>) {
    if (!selectedOrder) return;
    const currentSettings = normalizeChecklistSettings(selectedOrder.checklistSettings);
    const nextSettings = { ...currentSettings, ...patch };
    const routeChanged = patch.routeMode && patch.routeMode !== currentSettings.routeMode;
    const nextItems = routeChanged ? rescoreItems(selectedOrder.items, nextSettings.routeMode, settings) : selectedOrder.items;
    await persistOrder({ ...selectedOrder, checklistSettings: nextSettings, items: nextItems });
  }

  async function setItemFoundQuantity(item: BrickCheckItem, quantityFound: number) {
    if (!selectedOrder) return;
    const nextQuantity = Math.min(item.quantityExpected, Math.max(0, quantityFound));
    const nextStatus: BrickCheckItem['status'] = nextQuantity >= item.quantityExpected ? 'found' : nextQuantity > 0 ? 'partial' : 'unchecked';
    const next = updateItem(selectedOrder, item.id, (current) => ({
      ...current,
      quantityFound: nextQuantity,
      status: nextStatus
    }));
    await persistOrder(next);
  }

  const activeOrder = selectedOrder ?? draftImport?.order ?? null;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <header className="sticky top-0 z-20 border-b border-slate-300 bg-yellow-400/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <button className="text-left" onClick={() => setScreen('home')}>
            <div className="text-2xl font-black tracking-normal">BrickCheck</div>
            <div className="text-xs font-semibold uppercase tracking-normal text-slate-800">Pick a Brick order checking app</div>
          </button>
          <nav className="flex gap-2">
            {selectedOrder && (
              <>
                <NavButton active={screen === 'dashboard'} onClick={() => setScreen('dashboard')}>
                  Order
                </NavButton>
                <NavButton active={screen === 'checklist'} onClick={() => setScreen('checklist')}>
                  Check
                </NavButton>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-4 pb-28">
        {screen === 'home' && (
          <HomeScreen orders={orders} busy={busy} message={message} importProgress={importProgress} importDiagnostic={importDiagnostic} onClearImportDiagnostic={() => clearImportDiagnostic(setImportDiagnostic)} onImport={handleImport} onOpen={(order) => { setSelectedOrder(order); setScreen('dashboard'); }} />
        )}

        {screen === 'review' && draftImport && <ReviewScreen draft={draftImport.order} busy={busy} onSave={commitDraft} onCancel={() => { setDraftImport(null); setScreen('home'); }} />}

        {screen === 'dashboard' && selectedOrder && (
          <DashboardScreen
            order={selectedOrder}
            busy={busy}
            importProgress={importProgress}
            photoDiagnostic={photoDiagnostic}
            onChecklist={() => setScreen('checklist')}
            onImportAnother={() => setScreen('home')}
            onRebuildThumbnails={rebuildThumbnails}
            onSettings={() => setScreen('settings')}
            onExport={() => setScreen('export')}
            onDelete={removeSelectedOrder}
          />
        )}

        {screen === 'checklist' && selectedOrder && (
          <ChecklistScreen
            order={selectedOrder}
            onSettingsChange={updateChecklistSettings}
            onIncrement={(item) => setItemFoundQuantity(item, item.quantityFound + 1)}
            onDecrement={(item) => setItemFoundQuantity(item, item.quantityFound - 1)}
            onFoundAll={(item) => setItemStatus(item, 'found', item.quantityExpected)}
            onPartial={(item) => setEditingItem({ ...item, status: 'partial' })}
            onMissing={(item) => setItemStatus(item, 'missing', 0)}
            onEdit={setEditingItem}
          />
        )}

        {screen === 'settings' && selectedOrder && <SettingsScreen settings={settings} onApply={applyScoring} />}

        {screen === 'export' && selectedOrder && <ExportScreen order={selectedOrder} />}
      </main>

      {activeOrder && editingItem && <ItemModal item={editingItem} onClose={() => setEditingItem(null)} onSave={saveItem} />}
    </div>
  );
}

function HomeScreen({
  orders,
  busy,
  message,
  importProgress,
  importDiagnostic,
  onClearImportDiagnostic,
  onImport,
  onOpen
}: {
  orders: BrickCheckOrder[];
  busy: boolean;
  message: string;
  importProgress: ImportProgress | null;
  importDiagnostic: string;
  onClearImportDiagnostic: () => void;
  onImport: (file: File) => Promise<void>;
  onOpen: (order: BrickCheckOrder) => void;
}) {
  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-slate-300 bg-white p-4 shadow-soft">
        <label className="block">
          <span className="mb-2 block text-sm font-bold uppercase text-slate-600">Import PDF</span>
          <input
            className="block w-full rounded-md border border-slate-300 bg-slate-50 p-3 text-base"
            type="file"
            accept="application/pdf"
            disabled={busy}
            onChange={(event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              if (!file) return;
              void onImport(file).finally(() => {
                window.setTimeout(() => {
                  input.value = '';
                }, 250);
              });
            }}
          />
        </label>
        {message && <p className="mt-3 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white">{message}</p>}
        {importProgress && <ImportProgressBar progress={importProgress} />}
      </div>

      {importDiagnostic && (
        <DiagnosticPanel
          diagnostic={importDiagnostic}
          title="Import diagnostics"
          onClear={onClearImportDiagnostic}
        />
      )}

      <div className="space-y-3">
        <h1 className="text-xl font-black">Orders</h1>
        {orders.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-400 bg-white p-5 text-sm font-semibold text-slate-600">No saved orders.</div>
        ) : (
          orders.map((order) => <OrderListItem key={order.id} order={order} onOpen={() => onOpen(order)} />)
        )}
      </div>
    </section>
  );
}

function ImportProgressBar({ progress }: { progress: ImportProgress }) {
  const percent = progress.total > 0 ? Math.max(4, Math.min(100, Math.round((progress.current / progress.total) * 100))) : 8;
  return (
    <div className="mt-4 rounded-lg border border-slate-300 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-sm font-black">
        <span>{progress.message}</span>
        <span>{percent}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-200">
        <div className="progress-stripes h-full rounded-full bg-red-700 transition-all duration-300" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 text-xs font-bold uppercase text-slate-500">{progress.phase}</div>
    </div>
  );
}

function ReviewScreen({ draft, busy, onSave, onCancel }: { draft: BrickCheckOrder; busy: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-black">Parse Review</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button onClick={onSave} disabled={busy}>Save</Button>
        </div>
      </div>
      <SummaryStrip order={draft} />
      <div className="rounded-lg border border-slate-300 bg-white">
        <div className="border-b border-slate-200 px-4 py-3 font-bold">Warnings</div>
        {draft.parseWarnings.length === 0 ? (
          <div className="px-4 py-4 text-sm font-semibold text-emerald-700">No parser warnings.</div>
        ) : (
          draft.parseWarnings.map((warning) => (
            <div key={warning.id} className="border-b border-slate-100 px-4 py-3 last:border-b-0">
              <div className={`text-sm font-black ${warning.severity === 'error' ? 'text-red-700' : 'text-amber-700'}`}>{warning.severity.toUpperCase()}</div>
              <div className="text-sm">{warning.message}</div>
              {warning.subOrderId && <div className="text-xs font-semibold text-slate-500">Sub-order {warning.subOrderId}</div>}
            </div>
          ))
        )}
      </div>
      <SubOrderTable order={draft} />
    </section>
  );
}

function DashboardScreen({
  order,
  busy,
  importProgress,
  photoDiagnostic,
  onChecklist,
  onImportAnother,
  onRebuildThumbnails,
  onSettings,
  onExport,
  onDelete
}: {
  order: BrickCheckOrder;
  busy: boolean;
  importProgress: ImportProgress | null;
  photoDiagnostic: string;
  onChecklist: () => void;
  onImportAnother: () => void;
  onRebuildThumbnails: (file: File) => void;
  onSettings: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const done = order.items.filter((item) => item.status === 'found').length;
  const totalMissing = buildMissingReportRows(order).reduce((sum, row) => sum + row.missingValue, 0);
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-2xl font-black">{order.name}</h1>
        <div className="text-sm font-semibold text-slate-600">{order.sourcePdfName}</div>
      </div>
      <SummaryStrip order={order} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Checked" value={`${done}/${order.items.length}`} />
        <Metric label="Warnings" value={String(order.parseWarnings.length)} />
        <Metric label="Missing Value" value={formatMoney(totalMissing)} />
        <Metric label="Sub-orders" value={String(order.subOrders.length)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Button onClick={onChecklist}>Open Checklist</Button>
        <Button variant="secondary" onClick={onImportAnother}>Import Another</Button>
        <label className={`grid min-h-11 cursor-pointer place-items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-center text-sm font-black text-slate-950 ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          Rebuild Photos
          <input
            className="hidden"
            type="file"
            accept="application/pdf"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) onRebuildThumbnails(file);
              event.currentTarget.value = '';
            }}
          />
        </label>
        <Button variant="secondary" onClick={onExport}>Export CSV</Button>
        <Button variant="secondary" onClick={onSettings}>Scoring</Button>
        <Button variant="danger" onClick={onDelete}>Delete</Button>
      </div>
      {importProgress && <ImportProgressBar progress={importProgress} />}
      {photoDiagnostic && <PhotoDiagnosticPanel diagnostic={photoDiagnostic} />}
      <SubOrderTable order={order} />
    </section>
  );
}

function PhotoDiagnosticPanel({ diagnostic }: { diagnostic: string }) {
  return <DiagnosticPanel diagnostic={diagnostic} title="Photo diagnostics" />;
}

function DiagnosticPanel({ diagnostic, title, onClear }: { diagnostic: string; title: string; onClear?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-black uppercase text-amber-900">{title}</h2>
        <div className="flex gap-2">
          {onClear && (
            <button className="rounded-md border border-amber-300 bg-white px-3 py-2 text-xs font-black text-amber-950" onClick={onClear}>
              Clear
            </button>
          )}
          <button
            className="rounded-md bg-slate-950 px-3 py-2 text-xs font-black text-white"
            onClick={async () => {
              const didCopy = await copyText(diagnostic);
              setCopied(didCopy);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <textarea className="h-52 w-full rounded-md border border-amber-200 bg-white p-2 font-mono text-xs" readOnly value={diagnostic} />
    </div>
  );
}

function ChecklistScreen({
  order,
  onSettingsChange,
  onIncrement,
  onDecrement,
  onFoundAll,
  onPartial,
  onMissing,
  onEdit
}: {
  order: BrickCheckOrder;
  onSettingsChange: (settings: Partial<ChecklistSettings>) => void;
  onIncrement: (item: BrickCheckItem) => void;
  onDecrement: (item: BrickCheckItem) => void;
  onFoundAll: (item: BrickCheckItem) => void;
  onPartial: (item: BrickCheckItem) => void;
  onMissing: (item: BrickCheckItem) => void;
  onEdit: (item: BrickCheckItem) => void;
}) {
  const checklistSettings = normalizeChecklistSettings(order.checklistSettings);
  const { active, done } = useMemo(() => splitChecklistItems(order.items, checklistSettings), [order.items, checklistSettings]);
  const families = useMemo(() => uniqueValues(order.items.map((item) => item.partFamily)), [order.items]);
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-black">Checklist</h1>
        <Segmented<RouteMode> value={checklistSettings.routeMode} options={[['hybrid', 'Hybrid'], ['treasure', 'Treasure'], ['bulk', 'Bulk']]} onChange={(routeMode) => onSettingsChange({ routeMode })} />
      </div>

      <ChecklistControls settings={checklistSettings} families={families} onChange={onSettingsChange} />

      <div className="space-y-3">
        {active.map((item) => (
          <ChecklistItem
            key={item.id}
            item={item}
            onIncrement={() => onIncrement(item)}
            onDecrement={() => onDecrement(item)}
            onFoundAll={() => onFoundAll(item)}
            onPartial={() => onPartial(item)}
            onMissing={() => onMissing(item)}
            onEdit={() => onEdit(item)}
          />
        ))}
        {active.length === 0 && <div className="rounded-lg border border-dashed border-slate-400 bg-white p-5 text-sm font-semibold text-slate-600">No pieces match the current filters.</div>}
      </div>

      {checklistSettings.moveFoundToDoneList && done.length > 0 && (
        <div className="space-y-3 pt-3">
          <h2 className="text-base font-black uppercase text-slate-500">Found</h2>
          {done.map((item) => (
            <ChecklistItem
              key={item.id}
              item={item}
              onIncrement={() => onIncrement(item)}
              onDecrement={() => onDecrement(item)}
              onFoundAll={() => onFoundAll(item)}
              onPartial={() => onPartial(item)}
              onMissing={() => onMissing(item)}
              onEdit={() => onEdit(item)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ChecklistControls({
  settings,
  families,
  onChange
}: {
  settings: ChecklistSettings;
  families: PartFamily[];
  onChange: (settings: Partial<ChecklistSettings>) => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-slate-300 bg-white p-3 shadow-sm">
      <label className="block">
        <span className="mb-1 block text-xs font-black uppercase text-slate-500">Search</span>
        <input
          className="w-full rounded-md border border-slate-300 bg-slate-50 p-3 text-base"
          value={settings.search}
          placeholder="Name, BrickLink-ish name, SKU, tag"
          onChange={(event) => onChange({ search: event.currentTarget.value })}
        />
      </label>
      <label className="flex items-center justify-between gap-3 rounded-md bg-slate-100 px-3 py-2">
        <span className="text-sm font-black">Move found pieces to bottom</span>
        <input
          className="h-6 w-6 accent-slate-950"
          type="checkbox"
          checked={settings.moveFoundToDoneList}
          onChange={(event) => onChange({ moveFoundToDoneList: event.currentTarget.checked })}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <SelectControl<ChecklistStatusFilter>
          label="State"
          value={settings.statusFilter}
          options={[
            ['open', 'Open'],
            ['all', 'All'],
            ['unchecked', 'Unchecked'],
            ['partial', 'Partial'],
            ['missing', 'Missing'],
            ['found', 'Found']
          ]}
          onChange={(statusFilter) => onChange({ statusFilter })}
        />
        <SelectControl<ChecklistSortKey>
          label="Sort"
          value={settings.sortKey}
          options={[
            ['route', 'Route'],
            ['priority', 'Priority'],
            ['quantity', 'Quantity'],
            ['lineTotal', 'Line value'],
            ['unitPrice', 'Unit price'],
            ['costDensity', 'Value density'],
            ['visualBulk', 'Bulk'],
            ['family', 'Piece type'],
            ['name', 'Name']
          ]}
          onChange={(sortKey) => onChange({ sortKey })}
        />
        <SelectControl<PartFamily | 'all'>
          label="Piece type"
          value={settings.familyFilter}
          options={[['all', 'All'], ...families.map((family): [PartFamily, string] => [family, familyLabel(family)])]}
          onChange={(familyFilter) => onChange({ familyFilter })}
        />
        <SelectControl<RouteGroup | 'all'>
          label="Route"
          value={settings.routeFilter}
          options={[
            ['all', 'All'],
            ['treasure', 'Treasure'],
            ['bulk', 'Bulk'],
            ['cleanup', 'Cleanup']
          ]}
          onChange={(routeFilter) => onChange({ routeFilter })}
        />
      </div>
    </div>
  );
}

function ChecklistItem({
  item,
  onIncrement,
  onDecrement,
  onFoundAll,
  onPartial,
  onMissing,
  onEdit
}: {
  item: BrickCheckItem;
  onIncrement: () => void;
  onDecrement: () => void;
  onFoundAll: () => void;
  onPartial: () => void;
  onMissing: () => void;
  onEdit: () => void;
}) {
  const canIncrement = item.quantityFound < item.quantityExpected;
  return (
    <article className="rounded-lg border border-slate-300 bg-white p-3 shadow-sm">
      <div className="grid grid-cols-[72px_1fr] gap-3">
        <Thumbnail item={item} />
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-2">
            <button className="min-w-0 text-left" onClick={onIncrement} disabled={!canIncrement}>
              <h2 className="break-words text-base font-black leading-tight">{item.name}</h2>
              <div className="mt-1 text-xs font-bold text-slate-500">SKU {item.sku} - Sub-order {item.subOrderId}</div>
            </button>
            <span className={`shrink-0 rounded px-2 py-1 text-xs font-black ${statusClass(item.status)}`}>{statusLabels[item.status]}</span>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs font-bold">
            <MiniStat label="Expected" value={String(item.quantityExpected)} />
            <MiniStat label="Found" value={String(item.quantityFound)} />
            <MiniStat label="Line" value={formatMoney(item.lineTotalPrice)} />
            <MiniStat label="Unit" value={formatMoney(item.unitPrice)} />
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            <Pill>{item.routeGroup}</Pill>
            <Pill>{familyLabel(item.partFamily)}</Pill>
            {item.riskTags.map((tag) => <Pill key={tag}>{tag}</Pill>)}
          </div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
        <button
          className="min-h-12 rounded-md bg-yellow-300 px-3 py-2 text-sm font-black text-slate-950 disabled:opacity-50"
          disabled={!canIncrement}
          onClick={onIncrement}
        >
          Tap +1 found
        </button>
        <SmallButton onClick={onDecrement}>-1</SmallButton>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <SmallButton onClick={onFoundAll}>Found all</SmallButton>
        <SmallButton onClick={onPartial}>Partial</SmallButton>
        <SmallButton onClick={onMissing}>Missing</SmallButton>
      </div>
      <div className="mt-2 flex justify-end">
        <button className="text-xs font-black text-slate-500 underline" onClick={onEdit}>Details / note</button>
      </div>
      {item.notes && <p className="mt-2 rounded-md bg-slate-100 p-2 text-sm">{item.notes}</p>}
    </article>
  );
}

function ItemModal({ item, onClose, onSave }: { item: BrickCheckItem; onClose: () => void; onSave: (item: BrickCheckItem) => void }) {
  const [draft, setDraft] = useState(item);
  return (
    <div className="fixed inset-0 z-40 bg-slate-950/60 p-4">
      <div className="mx-auto mt-8 max-w-lg rounded-lg bg-white shadow-soft">
        <div className="border-b border-slate-200 p-4">
          <h2 className="text-lg font-black">{item.name}</h2>
          <div className="text-sm font-bold text-slate-500">SKU {item.sku}</div>
        </div>
        <div className="space-y-4 p-4">
          <label className="block">
            <span className="mb-1 block text-sm font-bold">Found quantity</span>
            <input
              className="w-full rounded-md border border-slate-300 p-3 text-lg font-bold"
              type="number"
              min="0"
              max={draft.quantityExpected}
              value={draft.quantityFound}
              onChange={(event) => setDraft({ ...draft, quantityFound: Number(event.currentTarget.value), status: Number(event.currentTarget.value) >= draft.quantityExpected ? 'found' : 'partial' })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-bold">Status</span>
            <select
              className="w-full rounded-md border border-slate-300 p-3 text-base font-bold"
              value={draft.status}
              onChange={(event) => setDraft({ ...draft, status: event.currentTarget.value as BrickCheckItem['status'] })}
            >
              {(['unchecked', 'found', 'partial', 'missing'] as const).map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-bold">Note</span>
            <textarea
              className="min-h-28 w-full rounded-md border border-slate-300 p-3"
              value={draft.notes}
              onChange={(event) => setDraft({ ...draft, notes: event.currentTarget.value })}
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 p-4">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(draft)}>Save</Button>
        </div>
      </div>
    </div>
  );
}

function SettingsScreen({ settings, onApply }: { settings: ScoringSettings; onApply: (settings: ScoringSettings) => void }) {
  const [draft, setDraft] = useState(settings);
  const sliders: Array<[keyof ScoringSettings, string]> = [
    ['lineTotalWeight', 'Line total'],
    ['costDensityWeight', 'Cost density'],
    ['visualBulkWeight', 'Visual bulk'],
    ['quantityWeight', 'Quantity'],
    ['riskWeight', 'Risk'],
    ['ambiguityWeight', 'Ambiguity']
  ];
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-black">Scoring</h1>
        <Button onClick={() => onApply(draft)}>Apply</Button>
      </div>
      <div className="space-y-3 rounded-lg border border-slate-300 bg-white p-4">
        {sliders.map(([key, label]) => (
          <label key={key} className="block">
            <span className="mb-1 flex justify-between text-sm font-bold">
              <span>{label}</span>
              <span>{draft[key].toFixed(2)}</span>
            </span>
            <input
              className="w-full accent-red-700"
              type="range"
              min="0"
              max="0.6"
              step="0.01"
              value={draft[key]}
              onChange={(event) => setDraft({ ...draft, [key]: Number(event.currentTarget.value) })}
            />
          </label>
        ))}
        <Button variant="secondary" onClick={() => setDraft(defaultScoringSettings)}>Defaults</Button>
      </div>
      <div className="rounded-lg border border-slate-300 bg-white p-4 text-sm leading-6 text-slate-700">
        <p><strong>Line total</strong> favors rows with the most money at stake.</p>
        <p><strong>Cost density</strong> favors tiny or compact parts that are expensive for their size.</p>
        <p><strong>Visual bulk</strong> favors parts that should be easy to sweep up by volume.</p>
        <p><strong>Quantity</strong> favors rows with many copies to count.</p>
        <p><strong>Risk</strong> boosts single, tiny, printed/decorated, transparent, minifig, accessory, animal, plant, high-unit-price, and specialty variant pieces.</p>
        <p><strong>Ambiguity</strong> boosts rows where BrickCheck is less confident about size or family.</p>
      </div>
    </section>
  );
}

function ExportScreen({ order }: { order: BrickCheckOrder }) {
  const rows = buildMissingReportRows(order);
  const csv = generateMissingReportCsv(order);
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-black">Missing Report</h1>
        <Button onClick={() => downloadText(`${order.name}-missing.csv`, csv)}>Download</Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-300 bg-white">
        {rows.length === 0 ? (
          <div className="p-4 text-sm font-semibold text-emerald-700">No missing pieces.</div>
        ) : (
          rows.map((row) => (
            <div key={`${row.subOrderId}-${row.sku}`} className="border-b border-slate-100 p-3 last:border-b-0">
              <div className="font-black">{row.name}</div>
              <div className="text-sm font-bold text-slate-500">SKU {row.sku} - Missing {row.missing} - {formatMoney(row.missingValue)}</div>
              {row.notes && <div className="mt-1 text-sm">{row.notes}</div>}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function OrderListItem({ order, onOpen }: { order: BrickCheckOrder; onOpen: () => void }) {
  const complete = order.items.filter((item) => item.status === 'found').length;
  const total = order.items.length;
  return (
    <button className="block w-full rounded-lg border border-slate-300 bg-white p-4 text-left shadow-sm" onClick={onOpen}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-black">{order.name}</div>
          <div className="text-sm font-semibold text-slate-500">{new Date(order.createdAt).toLocaleString()}</div>
        </div>
        <div className="rounded-md bg-slate-900 px-2 py-1 text-sm font-black text-white">{complete}/{total}</div>
      </div>
    </button>
  );
}

function SummaryStrip({ order }: { order: BrickCheckOrder }) {
  const subtotal = order.subOrders.reduce((sum, subOrder) => sum + subOrder.subtotal, 0);
  const parsed = order.items.reduce((sum, item) => sum + item.lineTotalPrice, 0);
  return (
    <div className="grid grid-cols-3 gap-2">
      <Metric label="Lines" value={String(order.items.length)} />
      <Metric label="Subtotal" value={formatMoney(subtotal)} />
      <Metric label="Parsed" value={formatMoney(parsed)} />
    </div>
  );
}

function SubOrderTable({ order }: { order: BrickCheckOrder }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-300 bg-white">
      {order.subOrders.map((subOrder) => (
        <div key={subOrder.id} className="grid grid-cols-[1fr_auto] gap-3 border-b border-slate-100 p-3 last:border-b-0">
          <div>
            <div className="font-black">Sub-order {subOrder.legoItemNumber}</div>
            <div className="text-sm font-semibold text-slate-500">{subOrder.status}</div>
          </div>
          <div className="text-right text-sm font-bold">
            <div>{subOrder.parsedLineCount}/{subOrder.expectedLineCount || '?'}</div>
            <div>{formatMoney(subOrder.subtotal)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Thumbnail({ item }: { item: BrickCheckItem }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    getThumbnailUrl(item.thumbnailBlobId).then((nextUrl) => {
      if (active) setUrl(nextUrl);
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.thumbnailBlobId]);

  if (!url) {
    return <div className="grid h-18 w-18 place-items-center rounded-md bg-slate-200 text-xs font-black text-slate-500">SKU</div>;
  }
  return <img className="h-18 w-18 rounded-md border border-slate-200 object-cover" src={url} alt="" />;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-300 bg-white p-3 shadow-sm">
      <div className="text-xs font-black uppercase text-slate-500">{label}</div>
      <div className="mt-1 break-words text-lg font-black">{value}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-slate-100 p-2">
      <div className="text-[10px] uppercase text-slate-500">{label}</div>
      <div className="truncate">{value}</div>
    </div>
  );
}

function Pill({ children }: { children: string }) {
  return <span className="rounded bg-yellow-100 px-2 py-1 text-[11px] font-black text-slate-800">{children}</span>;
}

function Button({ children, variant = 'primary', disabled, onClick }: { children: string; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; onClick: () => void }) {
  const className =
    variant === 'danger'
      ? 'bg-red-700 text-white'
      : variant === 'secondary'
        ? 'border border-slate-300 bg-white text-slate-950'
        : 'bg-slate-950 text-white';
  return (
    <button className={`min-h-11 rounded-md px-4 py-2 text-sm font-black disabled:opacity-50 ${className}`} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function SmallButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button className="min-h-10 rounded-md border border-slate-300 bg-slate-50 px-2 py-2 text-xs font-black" onClick={onClick}>
      {children}
    </button>
  );
}

function NavButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return (
    <button className={`rounded-md px-3 py-2 text-sm font-black ${active ? 'bg-slate-950 text-white' : 'bg-yellow-200 text-slate-950'}`} onClick={onClick}>
      {children}
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return (
    <div className="grid grid-cols-3 overflow-hidden rounded-md border border-slate-300 bg-white">
      {options.map(([option, label]) => (
        <button key={option} className={`px-3 py-2 text-xs font-black ${value === option ? 'bg-slate-950 text-white' : 'text-slate-800'}`} onClick={() => onChange(option)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function SelectControl<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-black uppercase text-slate-500">{label}</span>
      <select
        className="w-full rounded-md border border-slate-300 bg-slate-50 p-2 text-sm font-bold"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as T)}
      >
        {options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}
      </select>
    </label>
  );
}

function uniqueValues<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((a, b) => familyLabel(a as PartFamily).localeCompare(familyLabel(b as PartFamily)));
}

function familyLabel(family: PartFamily): string {
  const labels: Record<PartFamily, string> = {
    bricks: 'Bricks',
    plates_tiles: 'Plates/Tiles',
    slopes_arches: 'Slopes/Arches',
    plants_foliage: 'Plants',
    minifig_parts: 'Minifig parts',
    minifig_accessories: 'Accessories',
    animals_food_objects: 'Objects',
    bars_tubes_connectors: 'Bars/Tubes',
    unknown: 'Unknown'
  };
  return labels[family];
}

function statusClass(status: BrickCheckItem['status']) {
  if (status === 'found') return 'bg-emerald-100 text-emerald-800';
  if (status === 'missing') return 'bg-red-100 text-red-800';
  if (status === 'partial') return 'bg-amber-100 text-amber-800';
  if (status === 'unsure') return 'bg-sky-100 text-sky-800';
  return 'bg-slate-100 text-slate-700';
}

function createImportDiagnostic({
  file,
  outcome,
  progress,
  error,
  extra
}: {
  file: File;
  outcome: string;
  progress: ImportProgress;
  error?: unknown;
  extra?: Record<string, unknown>;
}) {
  const navigatorDetails = navigator as Navigator & {
    standalone?: boolean;
    userAgentData?: {
      mobile?: boolean;
      platform?: string;
      brands?: Array<{ brand: string; version: string }>;
    };
  };
  const errorDetails = describeError(error);
  const nodeListIterator = typeof NodeList !== 'undefined' && typeof NodeList.prototype[Symbol.iterator] === 'function';
  const typedArrayAt = typeof Uint8Array.prototype.at === 'function';
  const fileArrayBuffer = typeof (File.prototype as File & { arrayBuffer?: unknown }).arrayBuffer === 'function';
  const blobArrayBuffer = typeof (Blob.prototype as Blob & { arrayBuffer?: unknown }).arrayBuffer === 'function';

  return {
    timestamp: new Date().toISOString(),
    app: {
      name: 'BrickCheck',
      version: '0.1.0',
      mode: import.meta.env.MODE,
      baseUrl: import.meta.env.BASE_URL,
      pageUrl: window.location.href
    },
    outcome,
    progress,
    file: {
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      lastModifiedIso: Number.isFinite(file.lastModified) ? new Date(file.lastModified).toISOString() : null
    },
    browser: {
      userAgent: navigator.userAgent,
      vendor: navigator.vendor,
      platform: navigator.platform,
      language: navigator.language,
      languages: Array.from(navigator.languages ?? []),
      maxTouchPoints: navigator.maxTouchPoints,
      online: navigator.onLine,
      standalone: Boolean(navigatorDetails.standalone),
      userAgentData: navigatorDetails.userAgentData ?? null,
      secureContext: window.isSecureContext,
      visibilityState: document.visibilityState,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      screen: {
        width: window.screen.width,
        height: window.screen.height,
        availableWidth: window.screen.availWidth,
        availableHeight: window.screen.availHeight
      }
    },
    capabilities: {
      fileReader: typeof FileReader === 'function',
      fileArrayBuffer,
      blobArrayBuffer,
      promiseWithResolvers: 'withResolvers' in Promise,
      structuredClone: typeof globalThis.structuredClone === 'function',
      arrayAt: typeof Array.prototype.at === 'function',
      arrayFindLast: typeof Array.prototype.findLast === 'function',
      typedArrayAt,
      arrayIterator: typeof Array.prototype[Symbol.iterator] === 'function',
      nodeListIterator,
      mapGetOrInsert: typeof Map.prototype.getOrInsert === 'function',
      mapGetOrInsertComputed: typeof Map.prototype.getOrInsertComputed === 'function',
      mathSumPrecise: typeof Math.sumPrecise === 'function',
      worker: typeof Worker === 'function',
      offscreenCanvas: typeof OffscreenCanvas === 'function',
      canvasToBlob: typeof HTMLCanvasElement.prototype.toBlob === 'function',
      indexedDb: typeof indexedDB !== 'undefined',
      serviceWorker: 'serviceWorker' in navigator,
      storagePersist: typeof navigator.storage?.persist === 'function',
      pdfWorkerModuleLoaded: Boolean((globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker)
    },
    error: errorDetails,
    ...extra
  };
}

function describeError(error: unknown) {
  if (error === undefined) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      cause: error.cause === undefined ? null : safeDiagnosticValue(error.cause),
      stringValue: String(error)
    };
  }
  if (typeof error === 'object' && error !== null) {
    const errorRecord = error as Record<string, unknown>;
    return {
      name: typeof errorRecord.name === 'string' ? errorRecord.name : null,
      message: typeof errorRecord.message === 'string' ? errorRecord.message : null,
      stack: typeof errorRecord.stack === 'string' ? errorRecord.stack : null,
      value: safeDiagnosticValue(error)
    };
  }
  return { value: String(error) };
}

function safeDiagnosticValue(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function persistImportDiagnostic(setDiagnostic: (diagnostic: string) => void, diagnostic: unknown) {
  const text = JSON.stringify(diagnostic, null, 2);
  setDiagnostic(text);
  try {
    localStorage.setItem(IMPORT_DIAGNOSTIC_KEY, text);
  } catch {
    // The on-screen diagnostic remains available if storage is unavailable.
  }
}

function loadImportDiagnostic(): string {
  try {
    return localStorage.getItem(IMPORT_DIAGNOSTIC_KEY) ?? '';
  } catch {
    return '';
  }
}

function clearImportDiagnostic(setDiagnostic: (diagnostic: string) => void) {
  setDiagnostic('');
  try {
    localStorage.removeItem(IMPORT_DIAGNOSTIC_KEY);
  } catch {
    // Clearing the visible diagnostic is still useful if storage is unavailable.
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to the older copy command below.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

function loadSettings(): ScoringSettings {
  const raw = localStorage.getItem('brickcheck.scoring');
  if (!raw) return defaultScoringSettings;
  try {
    return { ...defaultScoringSettings, ...JSON.parse(raw) };
  } catch {
    return defaultScoringSettings;
  }
}
