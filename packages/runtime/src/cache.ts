export interface RuntimeCache<T> {
  get(key: string): T | null;
  set(key: string, value: T, ttlMs?: number): void;
  delete(key: string): void;
  clear(): void;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export interface RuntimeCacheOptions {
  defaultTtlMs?: number;
  now?: () => number;
}

export function createRuntimeMemoryCache<T>(options: RuntimeCacheOptions = {}): RuntimeCache<T> {
  const defaultTtlMs = Math.max(options.defaultTtlMs ?? 60_000, 1);
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, CacheEntry<T>>();

  return {
    get(key: string): T | null {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key: string, value: T, ttlMs?: number): void {
      const effectiveTtlMs = Math.max(ttlMs ?? defaultTtlMs, 1);
      entries.set(key, {
        expiresAt: now() + effectiveTtlMs,
        value,
      });
    },
    delete(key: string): void {
      entries.delete(key);
    },
    clear(): void {
      entries.clear();
    },
  };
}
