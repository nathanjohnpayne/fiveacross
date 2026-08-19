// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, 'registryWorker.ts');
const CONTROL_SOURCE = resolve(HERE, 'controlService.ts');
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

  it('retains recovery history before atomically deleting consumed probe evidence and expiry indexes', async () => {
    const source = await readFile(SOURCE, 'utf8');
    const recover = source.slice(source.indexOf('async recover('), source.indexOf('async issueProbeChallenge('));
    expect(recover).toContain('this.ctx.storage.transaction');
    const stateWrite = recover.indexOf('transaction.put(STATE_KEY, result.state)');
    const historyWrite = recover.search(
      /transaction\.put\(\s*decimalKey\(HISTORY_PREFIX, result\.record\.sequence\),\s*result\.record,?\s*\)/,
    );
    const evidenceDelete = recover.indexOf(
      'transaction.delete([...consumedAttestationKeys, ...consumedAttestationExpiryKeys])',
    );
    expect(stateWrite).toBeGreaterThan(0);
    expect(historyWrite).toBeGreaterThan(stateWrite);
    expect(evidenceDelete).toBeGreaterThan(historyWrite);
    expect(recover).toMatch(
      /consumedAttestationExpiryKeys = .*\.map\([\s\S]*?probeExpiryKey\(probeAttestationExpiresAt\(attestation\), keys\[index\]\)/,
    );
  });

  it('owns one SQLite-backed per-host namespace, fixed placement, rate limiting, and no KV', async () => {
    const [source, config] = await Promise.all([readFile(SOURCE, 'utf8'), readFile(CONFIG, 'utf8')]);
    expect(source).toContain('locationHint: REGISTRY_LOCATION_HINT');
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

  it('never treats omitted replacement evidence as proof of publisher integrity', async () => {
    const source = await readFile(CONTROL_SOURCE, 'utf8');
    expect(source).toContain('publisherIntegrityProven: false');
    expect(source).toContain('activePublisherMappings: publisherVerificationMappings');
    expect(source).not.toMatch(/publisherIntegrityProven:[^\n]*publisherReplacement\s*===\s*null/);
  });
});
