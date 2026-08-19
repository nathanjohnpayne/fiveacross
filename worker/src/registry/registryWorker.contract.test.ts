// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, 'registryWorker.ts');
const CONFIG = resolve(HERE, '../../wrangler.registry.toml');
const ROUTER_CONFIG = resolve(HERE, '../../wrangler.toml');

describe('registry Worker capability/configuration contract', () => {
  it('exports one named lookup-only entrypoint with no fetch/list/mutation method', async () => {
    const source = await readFile(SOURCE, 'utf8');
    const entrypoint = source.slice(
      source.indexOf('export class RegistryLookupEntrypoint'),
      source.indexOf('\n}\n\nlet jwks'),
    );
    expect(entrypoint).toContain('extends WorkerEntrypoint');
    expect(entrypoint).toContain('async lookup(');
    expect(entrypoint).not.toMatch(/\bfetch\s*\(/);
    expect(entrypoint).not.toMatch(/\blist\s*\(/);
    expect(entrypoint).not.toMatch(/\b(sync|recover|audit)\s*\(/);
  });

  it('owns one SQLite-backed per-host namespace, fixed placement, rate limiting, and no KV', async () => {
    const [source, config] = await Promise.all([readFile(SOURCE, 'utf8'), readFile(CONFIG, 'utf8')]);
    expect(source).toContain("locationHint: REGISTRY_LOCATION_HINT");
    expect(config).toContain('new_sqlite_classes = ["HostRegistryObject"]');
    expect(config).toContain('[[ratelimits]]');
    expect(config).not.toMatch(/\[\[kv_namespaces\]\]/);
    expect(config).not.toMatch(/^routes\s*=/m);
  });

  it('does not alter or attach the public Event router', async () => {
    const routerConfig = await readFile(ROUTER_CONFIG, 'utf8');
    expect(routerConfig).toContain('# routes = [');
    expect(routerConfig).not.toMatch(/^routes\s*=/m);
    expect(routerConfig).not.toContain('HOST_REGISTRY');
  });
});
