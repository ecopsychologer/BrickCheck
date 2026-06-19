import './polyfills';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { BrickCheckItem } from './types';
import type { PdfTextRun } from './parser';
import { parseOrderFromTextRuns } from './parser';

export interface ImportProgress {
  phase: 'loading' | 'text' | 'parsing' | 'thumbnails' | 'saving' | 'done';
  current: number;
  total: number;
  message: string;
}

export type ImportProgressCallback = (progress: ImportProgress) => void;

export interface ThumbnailExtractionDiagnostics {
  totalItems: number;
  pagesAttempted: number;
  pagesRendered: number;
  pageErrors: string[];
  itemsAttempted: number;
  itemsWithoutCrop: number;
  itemsSkippedForSize: number;
  itemsWithoutContext: number;
  blobNulls: number;
  blobsCreated: number;
  itemErrors: string[];
}

export async function parsePdfFile(file: File, onProgress?: ImportProgressCallback) {
  onProgress?.({ phase: 'loading', current: 0, total: 1, message: 'Loading PDF' });
  const buffer = await file.arrayBuffer();
  const pdfDocument = await getPdfDocument(buffer);
  const runs: PdfTextRun[] = [];
  let orderIndex = 0;

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    onProgress?.({ phase: 'text', current: pageNumber - 1, total: pdfDocument.numPages, message: `Reading page ${pageNumber} of ${pdfDocument.numPages}` });
    const page = await pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!isTextItem(item) || !item.str.trim()) continue;
      const [, , , fontHeight, x, y] = item.transform;
      runs.push({
        page: pageNumber,
        text: item.str,
        x,
        y,
        width: item.width,
        height: Math.abs(fontHeight) || item.height || 10,
        orderIndex: orderIndex++
      });
    }
    page.cleanup();
    onProgress?.({ phase: 'text', current: pageNumber, total: pdfDocument.numPages, message: `Read page ${pageNumber} of ${pdfDocument.numPages}` });
  }

  onProgress?.({ phase: 'parsing', current: 1, total: 1, message: 'Building checklist' });
  return parseOrderFromTextRuns(runs, file.name);
}

export async function extractThumbnailBlobs(
  file: File,
  items: BrickCheckItem[],
  onProgress?: ImportProgressCallback,
  diagnostics?: ThumbnailExtractionDiagnostics
): Promise<Map<string, Blob>> {
  const buffer = await file.arrayBuffer();
  const pdfDocument = await getPdfDocument(buffer);
  const byPage = new Map<number, BrickCheckItem[]>();
  for (const item of items) {
    if (!item.thumbnailCrop) {
      if (diagnostics) diagnostics.itemsWithoutCrop += 1;
      continue;
    }
    byPage.set(item.thumbnailCrop.page, [...(byPage.get(item.thumbnailCrop.page) ?? []), item]);
  }

  const blobs = new Map<string, Blob>();
  const pages = [...byPage.entries()].sort((a, b) => a[0] - b[0]);
  let processedItems = 0;
  const totalItems = items.filter((item) => item.thumbnailCrop).length;
  onProgress?.({ phase: 'thumbnails', current: 0, total: Math.max(totalItems, 1), message: 'Finding thumbnails' });

  for (const [pageNumber, pageItems] of pages) {
    if (diagnostics) diagnostics.pagesAttempted += 1;
    try {
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = globalThis.document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) {
        if (diagnostics) diagnostics.pageErrors.push(`page ${pageNumber}: missing page canvas context`);
        continue;
      }
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await renderPageToCanvas(page, canvas, context, viewport);
      if (diagnostics) diagnostics.pagesRendered += 1;

      for (const item of pageItems) {
        if (diagnostics) diagnostics.itemsAttempted += 1;
        try {
          const crop = item.thumbnailCrop;
          if (!crop) {
            if (diagnostics) diagnostics.itemsWithoutCrop += 1;
            continue;
          }
          const scale = 2;
          const detectedCrop = detectThumbnailRect(canvas, crop, scale);
          const sourceX = detectedCrop.x;
          const sourceY = detectedCrop.y;
          const sourceWidth = detectedCrop.width;
          const sourceHeight = detectedCrop.height;
          if (sourceWidth <= 1 || sourceHeight <= 1) {
            if (diagnostics) diagnostics.itemsSkippedForSize += 1;
            continue;
          }
          const thumbCanvas = globalThis.document.createElement('canvas');
          thumbCanvas.width = Math.floor(sourceWidth);
          thumbCanvas.height = Math.floor(sourceHeight);
          const thumbContext = thumbCanvas.getContext('2d');
          if (!thumbContext) {
            if (diagnostics) diagnostics.itemsWithoutContext += 1;
            continue;
          }
          thumbContext.drawImage(canvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
          const blob = await canvasToBlob(normalizeThumbnailCanvas(thumbCanvas));
          if (blob) {
            blobs.set(item.id, blob);
            if (diagnostics) diagnostics.blobsCreated += 1;
          } else if (diagnostics) {
            diagnostics.blobNulls += 1;
          }
        } catch (error) {
          if (diagnostics && diagnostics.itemErrors.length < 20) diagnostics.itemErrors.push(`${item.sku}: ${errorMessage(error)}`);
          // A thumbnail is nice to have; a failed crop should not block order import.
        } finally {
          processedItems += 1;
          onProgress?.({
            phase: 'thumbnails',
            current: processedItems,
            total: Math.max(totalItems, 1),
            message: `Cropping thumbnail ${processedItems} of ${totalItems}`
          });
        }
      }
      page.cleanup();
    } catch (error) {
      if (diagnostics) diagnostics.pageErrors.push(`page ${pageNumber}: ${errorMessage(error)}`);
      // Continue importing the checklist even if a page cannot be rendered.
    }
  }

  return blobs;
}

export function createThumbnailExtractionDiagnostics(totalItems: number): ThumbnailExtractionDiagnostics {
  return {
    totalItems,
    pagesAttempted: 0,
    pagesRendered: 0,
    pageErrors: [],
    itemsAttempted: 0,
    itemsWithoutCrop: 0,
    itemsSkippedForSize: 0,
    itemsWithoutContext: 0,
    blobNulls: 0,
    blobsCreated: 0,
    itemErrors: []
  };
}

function getPdfDocument(buffer: ArrayBuffer) {
  const documentParams = { data: buffer, disableWorker: true } as unknown as Parameters<typeof pdfjs.getDocument>[0];
  return pdfjs.getDocument(documentParams).promise;
}

async function renderPageToCanvas(page: unknown, canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, viewport: unknown) {
  const renderablePage = page as { render: (params: Record<string, unknown>) => { promise: Promise<unknown> } };
  try {
    await renderablePage.render({ canvas, canvasContext: context, viewport }).promise;
  } catch (firstError) {
    try {
      await renderablePage.render({ canvasContext: context, viewport }).promise;
    } catch {
      throw firstError;
    }
  }
}

function isTextItem(item: unknown): item is { str: string; transform: number[]; width: number; height: number } {
  return typeof item === 'object' && item !== null && 'str' in item && 'transform' in item;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      try {
        resolve(dataUrlToBlob(canvas.toDataURL('image/png')));
      } catch {
        resolve(null);
      }
    }, 'image/png', 0.9);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, payload] = dataUrl.split(',');
  const mimeType = header.match(/data:(.*?);/)?.[1] ?? 'image/png';
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detectThumbnailRect(canvas: HTMLCanvasElement, crop: { x: number; y: number; width: number; height: number }, scale: number) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return fallbackCanvasCrop(canvas, crop, scale);

  const inferredRowCenter = crop.y + 64;
  const expectedY = clamp(canvas.height - inferredRowCenter * scale, 0, canvas.height - 1);
  const search = {
    x: 0,
    y: Math.floor(clamp(expectedY - 92 * scale, 0, canvas.height - 1)),
    width: Math.floor(Math.min(170 * scale, canvas.width)),
    height: Math.floor(Math.min(184 * scale, canvas.height))
  };
  search.height = Math.min(search.height, canvas.height - search.y);

  try {
    const image = context.getImageData(search.x, search.y, search.width, search.height);
    const yCounts = new Array(search.height).fill(0);
    const xCounts = new Array(search.width).fill(0);
    const stride = 2;

    for (let y = 0; y < search.height; y += stride) {
      for (let x = 0; x < search.width; x += stride) {
        const index = (y * search.width + x) * 4;
        if (isNonWhitePixel(image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3])) {
          yCounts[y] += 1;
          xCounts[x] += 1;
        }
      }
    }

    const localExpectedY = expectedY - search.y;
    const yBand = chooseBand(findBands(yCounts, 3), localExpectedY);
    if (!yBand) return fallbackCanvasCrop(canvas, crop, scale);

    const xBand = chooseUsefulXBand(findBands(xCounts, 3));
    if (!xBand) return fallbackCanvasCrop(canvas, crop, scale);

    const pad = 8 * scale;
    const minBox = 58 * scale;
    const maxBox = 104 * scale;
    const centerX = search.x + (xBand.start + xBand.end) / 2;
    const centerY = search.y + (yBand.start + yBand.end) / 2;
    const size = clamp(Math.max(xBand.end - xBand.start, yBand.end - yBand.start) + pad * 2, minBox, maxBox);

    return {
      x: Math.floor(clamp(centerX - size / 2, 0, canvas.width - size)),
      y: Math.floor(clamp(centerY - size / 2, 0, canvas.height - size)),
      width: Math.floor(size),
      height: Math.floor(size)
    };
  } catch {
    return fallbackCanvasCrop(canvas, crop, scale);
  }
}

function fallbackCanvasCrop(canvas: HTMLCanvasElement, crop: { x: number; y: number; width: number; height: number }, scale: number) {
  const sourceX = clamp((crop.x - 18) * scale, 0, canvas.width - 1);
  const sourceY = clamp(canvas.height - (crop.y + crop.height + 8) * scale, 0, canvas.height - 1);
  const sourceWidth = Math.min((crop.width + 18) * scale, canvas.width - sourceX);
  const sourceHeight = Math.min((crop.height + 18) * scale, canvas.height - sourceY);
  return { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight };
}

function isNonWhitePixel(red: number, green: number, blue: number, alpha: number): boolean {
  if (alpha < 16) return false;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const saturation = max - min;
  return max < 242 || saturation > 18;
}

function normalizeThumbnailCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const bounds = findThumbnailSubjectBounds(canvas);
  if (!bounds) return canvas;

  const subjectWidth = bounds.maxX - bounds.minX + 1;
  const subjectHeight = bounds.maxY - bounds.minY + 1;
  if (subjectWidth < 8 || subjectHeight < 8) return canvas;

  const sourcePad = Math.ceil(Math.max(subjectWidth, subjectHeight) * 0.08);
  const sourceX = Math.floor(clamp(bounds.minX - sourcePad, 0, canvas.width - 1));
  const sourceY = Math.floor(clamp(bounds.minY - sourcePad, 0, canvas.height - 1));
  const sourceRight = Math.ceil(clamp(bounds.maxX + sourcePad, sourceX + 1, canvas.width));
  const sourceBottom = Math.ceil(clamp(bounds.maxY + sourcePad, sourceY + 1, canvas.height));
  const sourceWidth = sourceRight - sourceX;
  const sourceHeight = sourceBottom - sourceY;

  const outputSize = 180;
  const output = globalThis.document.createElement('canvas');
  output.width = outputSize;
  output.height = outputSize;
  const context = output.getContext('2d');
  if (!context) return canvas;

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, outputSize, outputSize);

  const targetMax = outputSize * 0.9;
  const scale = Math.min(targetMax / sourceWidth, targetMax / sourceHeight);
  const targetWidth = sourceWidth * scale;
  const targetHeight = sourceHeight * scale;
  const targetX = (outputSize - targetWidth) / 2;
  const targetY = (outputSize - targetHeight) / 2;

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(canvas, sourceX, sourceY, sourceWidth, sourceHeight, targetX, targetY, targetWidth, targetHeight);
  return output;
}

function findThumbnailSubjectBounds(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;

  try {
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = (y * canvas.width + x) * 4;
        if (!isThumbnailSubjectPixel(image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3])) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    if (maxX < minX || maxY < minY) return undefined;
    return { minX, minY, maxX, maxY };
  } catch {
    return undefined;
  }
}

function isThumbnailSubjectPixel(red: number, green: number, blue: number, alpha: number): boolean {
  if (alpha < 16) return false;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const saturation = max - min;
  if (max < 205) return true;
  if (saturation > 24 && max < 252) return true;
  if (min < 230 && saturation > 6) return true;
  return false;
}

function findBands(counts: number[], minimumCount: number) {
  const bands: Array<{ start: number; end: number; score: number }> = [];
  let start: number | null = null;
  let score = 0;
  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] >= minimumCount) {
      start ??= index;
      score += counts[index];
    } else if (start !== null) {
      if (index - start > 4) bands.push({ start, end: index, score });
      start = null;
      score = 0;
    }
  }
  if (start !== null && counts.length - start > 4) bands.push({ start, end: counts.length - 1, score });
  return bands;
}

function chooseBand(bands: Array<{ start: number; end: number; score: number }>, expected: number) {
  return bands
    .filter((band) => band.end - band.start >= 16)
    .sort((a, b) => distanceToBand(a, expected) - distanceToBand(b, expected) || b.score - a.score)[0];
}

function chooseUsefulXBand(bands: Array<{ start: number; end: number; score: number }>) {
  return bands
    .filter((band) => {
      const width = band.end - band.start;
      return width >= 16 && width <= 150;
    })
    .sort((a, b) => b.score - a.score || a.start - b.start)[0];
}

function distanceToBand(band: { start: number; end: number }, value: number) {
  if (value >= band.start && value <= band.end) return 0;
  return Math.min(Math.abs(value - band.start), Math.abs(value - band.end));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
