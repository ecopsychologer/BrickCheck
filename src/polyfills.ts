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
    value: function sumPrecise(numbers: Iterable<number>): number {
      let total = 0;
      for (const number of numbers) total += number;
      return total;
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
