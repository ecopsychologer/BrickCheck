export interface PdfTextContentChunk {
  items: unknown[];
  styles: Record<string, unknown>;
  lang: string | null;
}

interface PdfTextContentStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: PdfTextContentChunk }>;
    releaseLock?(): void;
  };
}

interface TextReadablePdfPage {
  streamTextContent(params?: Record<string, unknown>): PdfTextContentStream;
}

export async function getTextContentWithoutAsyncIteration(page: TextReadablePdfPage): Promise<PdfTextContentChunk> {
  const reader = page.streamTextContent().getReader();
  const textContent: PdfTextContentChunk = {
    items: [],
    styles: Object.create(null) as Record<string, unknown>,
    lang: null
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (!chunk) continue;
      textContent.lang ??= chunk.lang;
      Object.assign(textContent.styles, chunk.styles);
      textContent.items.push(...chunk.items);
    }
  } finally {
    reader.releaseLock?.();
  }

  return textContent;
}
