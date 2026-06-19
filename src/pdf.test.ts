import { describe, expect, it, vi } from 'vitest';
import { getTextContentWithoutAsyncIteration } from './pdfTextContent';

describe('getTextContentWithoutAsyncIteration', () => {
  it('reads all text chunks without requiring a stream async iterator', async () => {
    const chunks = [
      { items: [{ str: 'BRICK 2X4' }], styles: { first: { fontFamily: 'sans-serif' } }, lang: null },
      { items: [{ str: '6508680' }], styles: { second: { fontFamily: 'sans-serif' } }, lang: 'en' }
    ];
    const releaseLock = vi.fn();
    let index = 0;
    const stream = {
      getReader: () => ({
        read: async () => index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true },
        releaseLock
      })
    };
    const page = { streamTextContent: () => stream };

    const content = await getTextContentWithoutAsyncIteration(page);

    expect(content.items).toEqual([{ str: 'BRICK 2X4' }, { str: '6508680' }]);
    expect(content.styles).toEqual({
      first: { fontFamily: 'sans-serif' },
      second: { fontFamily: 'sans-serif' }
    });
    expect(content.lang).toBe('en');
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(Symbol.asyncIterator in stream).toBe(false);
  });
});
