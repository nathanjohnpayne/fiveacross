import { vi } from 'vitest';

// Shared by witness and actual data-API tests. Independent document modules
// share this origin lock manager, while retaining their own revocation sets.
export function installMockWebLocks() {
  const queues = new Map<string, Promise<void>>();
  const request = vi.fn(async <T>(name: string, options: { signal?: AbortSignal }, work: () => T | Promise<T>) => {
    const previous = queues.get(name) ?? Promise.resolve();
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    queues.set(name, previous.then(() => held));
    try {
      await previous;
      if (options.signal?.aborted) throw new Error('Lock request aborted.');
      return await work();
    } finally { release(); }
  });
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { locks: { request } }));
  return request;
}
