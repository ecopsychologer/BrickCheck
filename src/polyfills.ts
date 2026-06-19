declare global {
  interface Map<K, V> {
    getOrInsert?(key: K, value: V): V;
    getOrInsertComputed?(key: K, callbackFn: (key: K) => V): V;
  }

  interface Math {
    sumPrecise?(numbers: Iterable<number>): number;
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

export {};
