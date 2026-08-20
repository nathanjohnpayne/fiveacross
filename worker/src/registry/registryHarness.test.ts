// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { lookupSyntheticHost } from './registryHarnessCore';
import { validateHarnessServiceBinding } from '../../../scripts/event-router-registry/harness-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = resolve(HERE, '../../wrangler.registry-harness.toml');
const GENERATED_TYPES = resolve(HERE, '../../registry-harness-configuration.d.ts');
const SOURCE = resolve(HERE, 'registryHarness.ts');

describe('private synthetic lookup harness', () => {
  it.each([
    'r2-abcdefghijklmnopqrstuvwxyz.fiveacross.app',
    'r2-root-abcdefghijklmnopqrst.vacaybingo.com',
  ])('point-looks up the manifest-safe host %s', async (host) => {
    const lookup = vi.fn(async () => ({ kind: 'unknown-host' as const }));
    await expect(lookupSyntheticHost(host, lookup)).resolves.toEqual({ kind: 'unknown-host' });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(host);
  });

  it.each([
    '*.fiveacross.app',
    'fiveacross.app',
    'bodega-bay.fiveacross.app',
    'r2-ABCDEFGHIJKLMNOPQRSTUVWXYZ.fiveacross.app',
    'r2-short.fiveacross.app',
  ])('rejects non-synthetic host %s without touching the registry', async (host) => {
    const lookup = vi.fn();
    await expect(lookupSyntheticHost(host, lookup)).rejects.toThrow('synthetic host rejected');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('binds explicitly to RegistryLookupEntrypoint and has no default-fetch or DO capability', async () => {
    const [config, generatedTypes, source] = await Promise.all([
      readFile(CONFIG, 'utf8'),
      readFile(GENERATED_TYPES, 'utf8'),
      readFile(SOURCE, 'utf8'),
    ]);
    expect(validateHarnessServiceBinding(config)).toEqual({
      binding: 'REGISTRY',
      service: 'five-across-event-registry',
      entrypoint: 'RegistryLookupEntrypoint',
    });
    expect(config).not.toContain('durable_objects');
    expect(config).not.toMatch(/^routes\s*=/m);
    expect(config).toContain('workers_dev = false');
    expect(generatedTypes).toContain(
      'REGISTRY: Service<typeof import("./src/registry/registryWorker").RegistryLookupEntrypoint>;',
    );
    expect(generatedTypes).not.toMatch(/REGISTRY:\s*Service\s*(?:\/\*|;)/);
    expect(generatedTypes).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain('interface RegistryHarnessEnv');
    expect(source).not.toMatch(/\.fetch\s*\(/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it.each([
    ['omitted entrypoint', '[[services]]\nbinding="REGISTRY"\nservice="five-across-event-registry"'],
    ['default entrypoint', '[[services]]\nbinding="REGISTRY"\nservice="five-across-event-registry"\nentrypoint="default"'],
    ['wrong entrypoint', '[[services]]\nbinding="REGISTRY"\nservice="five-across-event-registry"\nentrypoint="Other"'],
  ])('rejects %s', (_label, config) => {
    expect(() => validateHarnessServiceBinding(config)).toThrow('RegistryLookupEntrypoint');
  });
});
