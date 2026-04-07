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
  maxSize?: number;
  now?: () => number;
}

export function createRuntimeMemoryCache<T>(options: RuntimeCacheOptions = {}): RuntimeCache<T> {
  const defaultTtlMs = Math.max(options.defaultTtlMs ?? 60_000, 1);
  const maxSize = Math.max(options.maxSize ?? 1000, 1);
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, CacheEntry<T>>();

  function evictExpired(): void {
    const timestamp = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(key);
    }
  }

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
      if (entries.size >= maxSize) {
        evictExpired();
      }
      if (entries.size >= maxSize) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
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
