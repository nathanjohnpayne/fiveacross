// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture({ failUpload = false, strayMap = false, visibleAppMap = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'private-maps-build-')); roots.push(root);
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  for (const name of readdirSync(join(repo, 'node_modules'))) {
    if (name !== '.bin') symlinkSync(join(repo, 'node_modules', name), join(root, 'node_modules', name));
  }
  for (const name of ['src', 'functions']) symlinkSync(join(repo, name), join(root, name));
  for (const name of ['package.json', 'tsconfig.json']) copyFileSync(join(repo, name), join(root, name));
  let config = readFileSync(join(repo, 'vite.config.ts'), 'utf8').replace("srcDir: 'src'", "srcDir: 'fixture-src'");
  if (visibleAppMap) config = config.replace('...(maps ? [mapInjection(maps)] : []),', '...(maps ? [mapInjection(maps, true)] : []),');
  writeFileSync(join(root, 'vite.config.ts'), config);
  writeFileSync(join(root, 'index.html'), readFileSync(join(repo, 'index.html'), 'utf8').replace('/src/entry.tsx', '/entry.ts'));
  writeFileSync(join(root, 'entry.ts'), "import {registerSW} from 'virtual:pwa-register'; registerSW(); new Worker(new URL('./fixture-worker.ts', import.meta.url), {type:'module'}); console.log('fixture app');");
  writeFileSync(join(root, 'fixture-worker.ts'), "self.onmessage=()=>{throw new Error('fixture worker');};");
  mkdirSync(join(root, 'fixture-src'));
  writeFileSync(join(root, 'fixture-src', 'sw.ts'), "self.addEventListener('install',()=>console.log(self.__WB_MANIFEST)); self.addEventListener('fetch',()=>{throw new Error('fixture sw');});");
  mkdirSync(join(root, 'public'));
  if (strayMap) writeFileSync(join(root, 'public', 'leaked.map'), '{"sourcesContent":["private source"]}');
  const cli = join(root, 'node_modules', '.bin', 'posthog-cli');
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('fs');
const paths=fs.readFileSync(0,'utf8').trim().split('\\n');
for(const path of paths){
 const code=fs.readFileSync(path,'utf8'); const map=JSON.parse(fs.readFileSync(path+'.map','utf8'));
 if(!code.includes('//# chunkId=')||code.includes('sourceMappingURL=')||!map.sourcesContent?.some(Boolean)) process.exit(9);
}
fs.writeFileSync('upload.json',JSON.stringify({paths:paths.map(p=>p.slice(p.indexOf('/dist/')+6)),args:process.argv.slice(2),project:process.env.POSTHOG_CLI_PROJECT_ID,host:process.env.POSTHOG_CLI_HOST}));
process.exit(${failUpload ? 23 : 0});
`); chmodSync(cli, 0o755);
  const result = spawnSync(process.execPath, [join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_SHA: 'a'.repeat(40), POSTHOG_SOURCE_MAP_UPLOAD: '1', POSTHOG_UPLOAD_API_KEY: 'fixture-private-key', VERCEL: '', VERCEL_ENV: '' },
  });
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  return { root, result, files: () => files(join(root, 'dist')) };
}
describe('private production source-map pipeline', () => {
  it('uploads final app, worker and Workbox-injected SW maps, then removes every map', () => {
    const f = fixture(); expect(f.result.status, f.result.stdout + f.result.stderr).toBe(0);
    const upload = JSON.parse(readFileSync(join(f.root, 'upload.json')));
    expect(upload.paths.some(p => p.includes('fixture-worker-'))).toBe(true);
    expect(upload.paths).toContain('sw.js');
    expect(upload.paths.some(p => p.startsWith('assets/entry-') || p.startsWith('assets/index-'))).toBe(true);
    expect(upload).toMatchObject({ project: '503790', host: 'https://us.posthog.com', args: ['sourcemap', 'upload', '--stdin', '--release-name', 'fiveacross', '--release-version', 'a'.repeat(40)] });
    expect(f.files().filter(p => /\.map(?:\.(gz|br))?$/.test(p))).toEqual([]);
    expect(readFileSync(join(f.root, 'dist', 'sw.js'), 'utf8')).not.toContain('__WB_MANIFEST');
    expect(f.result.stdout + f.result.stderr).not.toContain('fixture-private-key');
  }, 40_000);
  it('fails the build on upload failure and retains maps for diagnosis, preventing publication', () => {
    const f = fixture({ failUpload: true }); expect(f.result.status).not.toBe(0);
    expect(f.result.stderr).toContain('PostHog upload failed (23)');
    expect(f.files().some(p => p.endsWith('.map'))).toBe(true);
  }, 40_000);
  it('refuses a visible map URL rather than rewriting an already-hashed asset', () => {
    const f = fixture({ visibleAppMap: true }); expect(f.result.status).not.toBe(0);
    expect(f.result.stderr).toContain('Unexpected source-map URL in a hashed asset');
    expect(() => readFileSync(join(f.root, 'upload.json'))).toThrow();
  }, 40_000);
  it('refuses a public map before uploading any artifact', () => {
    const f = fixture({ strayMap: true }); expect(f.result.status).not.toBe(0);
    expect(f.result.stderr).toContain('unpaired or uninstrumented');
    expect(() => readFileSync(join(f.root, 'upload.json'))).toThrow();
  }, 40_000);
});
