declare global {
  interface Map<K, V> {
    getOrInsert?(key: K, value: V): V;
    getOrInsertComputed?(key: K, callbackFn: (key: K) => V): V;
  }

  interface Math {
    sumPrecise?(numbers: Iterable<number>): number;
  }
}

if (typeof Array.prototype.at !== 'function') {
  Object.defineProperty(Array.prototype, 'at', {
    configurable: true,
    writable: true,
    value: function at<T>(this: ArrayLike<T>, index: number): T | undefined {
      const length = this.length >>> 0;
      const relativeIndex = Math.trunc(index) || 0;
      const actualIndex = relativeIndex < 0 ? length + relativeIndex : relativeIndex;
      return actualIndex >= 0 && actualIndex < length ? this[actualIndex] : undefined;
    }
  });
}

if (typeof Array.prototype.findLast !== 'function') {
  Object.defineProperty(Array.prototype, 'findLast', {
    configurable: true,
    writable: true,
    value: function findLast<T>(this: ArrayLike<T>, predicate: (value: T, index: number, object: ArrayLike<T>) => unknown, thisArg?: unknown): T | undefined {
      for (let index = this.length - 1; index >= 0; index -= 1) {
        const value = this[index];
        if (predicate.call(thisArg, value, index, this)) return value;
      }
      return undefined;
    }
  });
}

for (const TypedArrayConstructor of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]) {
  if (typeof TypedArrayConstructor.prototype.at !== 'function') {
    Object.defineProperty(TypedArrayConstructor.prototype, 'at', {
      configurable: true,
      writable: true,
      value: Array.prototype.at
    });
  }
}

if (typeof Map.prototype.getOrInsert !== 'function') {
  Object.defineProperty(Map.prototype, 'getOrInsert', {
    configurable: true,
    writable: true,
    value: function getOrInsert<K, V>(this: Map<K, V>, key: K, value: V): V {
      if (!this.has(key)) this.set(key, value);
      return this.get(key)!;
    }
  });
}

if (typeof Map.prototype.getOrInsertComputed !== 'function') {
  Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
    configurable: true,
    writable: true,
    value: function getOrInsertComputed<K, V>(this: Map<K, V>, key: K, callbackFn: (key: K) => V): V {
      if (!this.has(key)) this.set(key, callbackFn(key));
      return this.get(key)!;
    }
  });
}

if (typeof Math.sumPrecise !== 'function') {
  Object.defineProperty(Math, 'sumPrecise', {
    configurable: true,
    writable: true,
    value: function sumPrecise(numbers: ArrayLike<number> | Iterable<number> | undefined): number {
      if (!numbers) return 0;
      const arrayLike = numbers as ArrayLike<number>;
      if (typeof arrayLike.length === 'number') {
        let total = 0;
        for (let index = 0; index < arrayLike.length; index += 1) total += arrayLike[index] ?? 0;
        return total;
      }
      return Array.from(numbers as Iterable<number>).reduce((total, number) => total + number, 0);
    }
  });
}

if (typeof Promise.withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
      });
      return { promise, resolve, reject };
    }
  });
}

if (typeof globalThis.structuredClone !== 'function') {
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    writable: true,
    value: function structuredCloneFallback<T>(value: T): T {
      if (value instanceof ArrayBuffer) return value.slice(0) as T;
      if (ArrayBuffer.isView(value)) {
        if (value instanceof DataView) return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength) as T;
        return new (value.constructor as { new (arrayLike: ArrayLike<number>): T })(value as unknown as ArrayLike<number>);
      }
      if (value instanceof Map) return new Map(value) as T;
      if (value instanceof Set) return new Set(value) as T;
      if (Array.isArray(value)) return value.map((item) => structuredCloneFallback(item)) as T;
      if (value && typeof value === 'object') return { ...(value as Record<string, unknown>) } as T;
      return value;
    }
  });
}

export {};
