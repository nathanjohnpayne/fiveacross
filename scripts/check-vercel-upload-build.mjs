#!/usr/bin/env node
// Compile the tracked .vercelignore admission set; this never invokes Vercel.
import ignore from 'ignore';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function trackedEntries(root) {
  return execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).map(record => {
      const match = /^(\d+) [\da-f]+ (\d)\t([\s\S]+)$/.exec(record);
      if (!match || match[2] !== '0') throw new Error('Cannot stage an unresolved or malformed Git index entry');
      return { mode: match[1], path: match[3] };
    });
}

export function selectUploadEntries(entries, rules) {
  if (!rules.split(/\r?\n/).some(line => line.trim() && !line.startsWith('#'))) {
    throw new Error('.vercelignore must contain upload selection rules');
  }
  const matcher = ignore().add(rules);
  const admitted = entries.filter(entry => {
    if (!entry.path || entry.path.includes('\\') || entry.path.startsWith('/') ||
        entry.path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe tracked path: ${JSON.stringify(entry.path)}`);
    }
    return !matcher.ignores(entry.path);
  });
  if (!admitted.length) throw new Error('.vercelignore admits no tracked build inputs');
  for (const entry of admitted) {
    if (!['100644', '100755'].includes(entry.mode)) {
      throw new Error(`Refusing admitted symlink, gitlink or special entry: ${JSON.stringify(entry.path)}`);
    }
    if (entry.path.split('/').some(part => /^\.env/i.test(part) ||
        /^serviceAccountKey\.json$/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part))) {
      throw new Error(`Refusing secret-shaped upload input: ${JSON.stringify(entry.path)}`);
    }
  }
  return admitted;
}

function copyEntry(root, stage, entry) {
  // Check every component: a regular indexed file can have a symlink ancestor
  // or have been replaced by a symlink in the working tree since git add.
  const parts = entry.path.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const stat = lstatSync(join(root, ...parts.slice(0, i + 1)));
    if (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`Refusing non-regular upload input: ${JSON.stringify(entry.path)}`);
    }
  }
  const destination = join(stage, entry.path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, entry.path), destination);
  chmodSync(destination, entry.mode === '100755' ? 0o755 : 0o644);
}

export function checkUploadBuild(root = process.cwd()) {
  root = resolve(root);
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
  if (root !== resolve(gitRoot)) throw new Error('Run the upload build check from the repository root');
  const entries = selectUploadEntries(trackedEntries(root), readFileSync(join(root, '.vercelignore'), 'utf8'));
  console.log(`Vercel upload build: ${entries.length} tracked inputs; admissions outside src/ and public/:`);
  for (const entry of entries) {
    if (!entry.path.startsWith('src/') && !entry.path.startsWith('public/')) console.log(JSON.stringify(entry.path));
  }
  // Always app-ci's generic compile-only build, wherever this runs: the
  // blank-key guard exempts it via GITHUB_ACTIONS, and stripping the target
  // variables keeps a deploy-shaped target build from being selected instead.
  const env = { ...process.env, GITHUB_ACTIONS: 'true' };
  delete env.DEPLOY_TARGET_BUILD;
  delete env.DEPLOY_TARGET_STATIC_EDITION;
  const stage = mkdtempSync(join(tmpdir(), 'fiveacross-upload-build-'));
  try {
    for (const entry of entries) copyEntry(root, stage, entry);
    for (const args of [['ci'], ['run', 'build']]) {
      const child = spawnSync('npm', args, { cwd: stage, env, stdio: 'inherit' });
      if (child.error) throw child.error;
      if (child.status !== 0) {
        console.error(`Vercel upload build: npm ${args.join(' ')} failed (${child.signal ?? child.status})`);
        return child.status || 1;
      }
    }
    return 0;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = checkUploadBuild();
  } catch (error) {
    console.error(`Vercel upload build: ${error.message}`);
    process.exitCode = 1;
  }
}
