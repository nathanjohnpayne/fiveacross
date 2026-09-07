import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts/worker-deploy.sh');

/**
 * A throwaway repository root the wrapper can be run from.
 *
 * `scripts/worker-deploy.sh` derives REPO_ROOT from its OWN location and reads
 * `worker/` beneath it, so every other case here exercises the real checkout —
 * which is what makes them honest about the committed configuration, and what
 * makes them the wrong place to plant a fixture dotenv file. A gitignored
 * `worker/.env.local` written into the live tree is invisible to `git status`,
 * outlives a failed assertion, and is observable by any other test (or
 * parallel Vitest worker) that shells out to Wrangler. So the dotenv cases get
 * a staged copy instead: the script, the guard it sources, the two validator
 * modules it runs, and the two `worker/` files those read.
 *
 * `node_modules` is SYMLINKED rather than copied — the validator parses the
 * configuration with `smol-toml`, a root devDependency, and Node resolves the
 * link to the real directory the same way it would in the checkout.
 *
 * `git` is stubbed for this root alone, because it is a directory and not a
 * checkout: the source guard's questions are answered in
 * `scripts/deploy-main-guard.test.mjs`, and answering them here as a clean,
 * up-to-date `main` is what leaves the dotenv guard as the thing each case
 * turns on.
 */
function stageRepoRoot(dir, dotenvFiles, bin) {
  const root = join(dir, 'root');
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'event-router-registry'), { recursive: true });
  mkdirSync(join(root, 'worker'), { recursive: true });
  for (const relative of [
    'scripts/worker-deploy.sh',
    'scripts/lib/deploy-main-guard.sh',
    'scripts/event-router-registry/check-router-binding.mjs',
    'scripts/event-router-registry/harness-config.mjs',
    'worker/wrangler.toml',
    'worker/package.json',
  ]) {
    copyFileSync(resolve(process.cwd(), relative), join(root, relative));
  }
  symlinkSync(resolve(process.cwd(), 'node_modules'), join(root, 'node_modules'));

  const stubbedGit = join(bin, 'git');
  writeFileSync(
    stubbedGit,
    [
      '#!/usr/bin/env bash',
      'case "$*" in',
      "  'rev-parse --abbrev-ref HEAD') echo main ;;",
      `  'rev-parse HEAD'|'rev-parse origin/main') echo ${'0'.repeat(40)} ;;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(stubbedGit, 0o755);

  for (const name of dotenvFiles) {
    // The value is the override the two ambient-variable refusals already
    // catch in the shell, written where they cannot see it.
    writeFileSync(join(root, 'worker', name), 'WRANGLER_CI_OVERRIDE_NAME=shadow-router\n', 'utf8');
  }
  return root;
}

/**
 * Run the guard with a stubbed `npm` (and optionally `node` and `grep`) on PATH.
 *
 * The verification is shell, and every finding it has drawn was a shell bug —
 * an unanchored match, a swallowed failure, an unconditional message. Stubbing
 * the commands it shells out to is what makes those assertable instead of
 * reasoned about.
 *
 * There is deliberately no test hook inside the wrapper itself. A deploy guard
 * with an environment-variable bypass is the thing a deploy guard exists to not
 * have, so the negative path is forced by replacing `node` on PATH rather than
 * by teaching the checker to fail on request; the checker's own decision table
 * is proved in `worker/src/routerBinding.test.ts`.
 *
 * `workerDotenvFiles` is the one option that changes WHERE the guard runs: any
 * array (the empty one included) stages a repository root and runs the copy
 * there, so a fixture dotenv file never lands in the live checkout.
 */
function runWithStubbedNpm({
  secretListJson = null,
  secretListFails = false,
  bindingCheckFails = false,
  bindingCheckExit = 1,
  silentBindingCheck = false,
  routeBearing = false,
  workerDotenvFiles = null,
  extraEnv = {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-deploy-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const npm = join(bin, 'npm');
  const npmCallLog = join(dir, 'npm-calls.log');
  writeFileSync(npmCallLog, '', 'utf8');
  writeFileSync(
    npm,
    `#!/usr/bin/env bash
# Stub: only the secret listing matters; ci/deploy are no-ops.
printf '%s\\n' "$*" >> "$NPM_CALL_LOG"
for arg in "$@"; do
  if [[ "$arg" == "secret" ]]; then
    ${secretListFails ? 'exit 1' : `cat <<'JSON'
${secretListJson ?? '[]'}
JSON
exit 0`}
  fi
done
exit 0
`,
    'utf8',
  );
  chmodSync(npm, 0o755);

  if (bindingCheckFails) {
    const node = join(bin, 'node');
    writeFileSync(node, `#!/usr/bin/env bash\nexit ${String(bindingCheckExit)}\n`, 'utf8');
    chmodSync(node, 0o755);
  }

  if (silentBindingCheck) {
    const node = join(bin, 'node');
    writeFileSync(node, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
    chmodSync(node, 0o755);
  }

  if (routeBearing) {
    // Route-bearing is now read off the PARSED configuration by the binding
    // check, which prints its answer, rather than grepped for a line. Stubbing
    // `node` is therefore how a route-bearing config is simulated — and it is
    // the same seam `bindingCheckFails` uses, so the two are exclusive.
    const node = join(bin, 'node');
    writeFileSync(node, '#!/usr/bin/env bash\necho "routes=true"\nexit 0\n', 'utf8');
    chmodSync(node, 0o755);
  }

  // `--force` waives the branch/freshness guards; the clean-tree guard has its
  // own override. Both are needed to exercise the verification logic from a
  // working checkout — without DEPLOY_ALLOW_DIRTY the script exits 1 on a dirty
  // tree, which silently looks like a verification failure and lets a broken
  // assertion pass for the wrong reason.
  //
  // The dotenv cases need a REPO ROOT of their own. The wrapper derives its
  // root from its own location and reads `worker/` under it, so planting a
  // fixture `.env.local` in the live checkout would be a real, gitignored
  // dotenv file in the tree every other test — and every parallel worker — is
  // running against. That is the same hazard the redirect probe was moved out
  // of the live root for (Codex P2 on #1120); a staged copy is the fix there
  // and here.
  const stagedRoot = workerDotenvFiles === null ? null : stageRepoRoot(dir, workerDotenvFiles, bin);
  const entry = stagedRoot === null ? script : join(stagedRoot, 'scripts/worker-deploy.sh');
  const result = spawnSync('bash', [entry, '--force'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DEPLOY_ALLOW_DIRTY: '1',
      NPM_CALL_LOG: npmCallLog,
      ...extraEnv,
    },
  });
  return {
    ...result,
    npmCalls: readFileSync(npmCallLog, 'utf8').trim().split('\n').filter(Boolean),
  };
}

describe('worker deploy guard — ambient Wrangler environment', () => {
  it('refuses an ambient WRANGLER_CI_OVERRIDE_NAME before certifying the binding', () => {
    // Wrangler deploys under that name while the secret readback still reads
    // the configured one, so the published Worker would go unverified.
    const result = runWithStubbedNpm({ extraEnv: { WRANGLER_CI_OVERRIDE_NAME: 'shadow-router' } });
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('WRANGLER_CI_OVERRIDE_NAME is set');
    expect(result.stderr).toContain('unset WRANGLER_CI_OVERRIDE_NAME');
  });

  it('refuses a set CLOUDFLARE_ENV before certifying the binding', () => {
    // Wrangler selects an environment from the variable with no flag, and this
    // wrapper forwards the operator's environment to every Wrangler command it
    // runs. worker/wrangler.toml declares no `[env.<name>]`, and a MISSING
    // section is a warning rather than an error: Wrangler reuses the top-level
    // configuration under the name five-across-event-router-<env>. So the
    // guarded command would publish or inspect a different Worker while every
    // message reported on the production router.
    const result = runWithStubbedNpm({ extraEnv: { CLOUDFLARE_ENV: 'staging' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CLOUDFLARE_ENV is set');
    expect(result.stderr).toContain('five-across-event-router-staging');
    expect(result.stderr).toContain('unset CLOUDFLARE_ENV');
    // Refused BEFORE the binding is certified, so no install or Wrangler call
    // runs against the wrong environment.
    expect(result.npmCalls).toEqual([]);
  });

  it('proceeds when it is empty or unset, which is the ordinary case', () => {
    for (const extraEnv of [{}, { CLOUDFLARE_ENV: '' }]) {
      const result = runWithStubbedNpm({ extraEnv });
      expect(result.stderr).not.toContain('CLOUDFLARE_ENV is set');
    }
  });
});

describe('worker deploy guard — dotenv files Wrangler would load', () => {
  // The two refusals above read the SHELL. Wrangler 4.129 reads more than
  // that: its yargs `.check()` resolves `.env`, `.env.local` and
  // `.env.<env>*` against the working directory and merges them into
  // `process.env` — after this guard has run, and before the command it guards
  // does anything. So the same WRANGLER_CI_OVERRIDE_NAME those refusals exist
  // to catch, written into a gitignored `worker/.env.local`, would publish
  // over a Worker this deploy never verified, past a guard that saw a clean
  // shell (Codex P1 on #1120). The PRESENCE of the file is the refusal:
  // nothing here parses one, because a parser is a second definition of what
  // Wrangler would have loaded that can disagree with Wrangler's.
  it.each([
    ['.env.local'],
    ['.env'],
    ['.env.production'],
    ['.env.production.local'],
    ['.dev.vars'],
    ['.dev.vars.staging'],
  ])('refuses a deploy from a tree carrying worker/%s', (name) => {
    const result = runWithStubbedNpm({ workerDotenvFiles: [name] });
    expect(result.status).toBe(65);
    expect(result.stderr).toContain(`A dotenv file is present under worker/: worker/${name}`);
    // Refused before anything is installed, published or inspected — the
    // same ordering the ambient-variable refusals get, and for the same
    // reason.
    expect(result.npmCalls).toEqual([]);
  });

  it('names every offending file, not just the first', () => {
    const result = runWithStubbedNpm({ workerDotenvFiles: ['.env', '.env.local', '.dev.vars'] });
    expect(result.status).toBe(65);
    for (const name of ['worker/.env', 'worker/.env.local', 'worker/.dev.vars']) {
      expect(result.stderr).toContain(name);
    }
  });

  it('proceeds normally in the ordinary tree, which carries none', () => {
    // The staged root without a planted file is the SAME root the refusal
    // cases run in, so a passing case here is what proves the refusals turn
    // on the dotenv file rather than on the staging.
    const result = runWithStubbedNpm({ workerDotenvFiles: [], secretListJson: '[]' });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('A dotenv file is present');
    expect(result.stderr).toContain('REGISTRY is bound explicitly to RegistryLookupEntrypoint');
    expect(result.stderr).toContain('No FIREBASE_* binding on the deployed Worker');
  });

  it('loads no dotenv file on either Wrangler command, wherever one sits', () => {
    // The presence check covers `worker/`, which is where `npm run deploy`
    // resolves its dotenv files. It deliberately does NOT cover the
    // repository root, where `.env.local` is the app build's own required
    // input — and where `npm exec` (which keeps the caller's working
    // directory) resolves the secret readback's. `--env-file` REPLACES
    // Wrangler's default list rather than adding to it, so passing
    // `/dev/null` is what closes that half.
    const result = runWithStubbedNpm({ routeBearing: true, secretListJson: '[]' });
    expect(result.status).toBe(0);
    expect(result.npmCalls).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^--prefix worker exec -- wrangler secret list --format json --config \S+\/worker\/wrangler\.toml --env-file \/dev\/null$/),
      ]),
    );
    expect(result.npmCalls).toContain('--prefix worker run deploy -- --env-file /dev/null');
  });
});

describe('worker deploy guard — argument handling', () => {
  it.each(['--route', '--config', '--cwd', '--domain', '--'])(
    'refuses forwarded Wrangler argument %s',
    (argument) => {
      const result = spawnSync('bash', [script, '--force', argument], { encoding: 'utf8' });
      expect(result.status).toBe(64);
      expect(result.stderr).toContain('does not accept Wrangler arguments');
    },
  );
});

describe('worker deploy guard — registry lookup binding', () => {
  it('verifies the committed binding before installing or publishing anything', () => {
    const result = runWithStubbedNpm();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('REGISTRY is bound explicitly to RegistryLookupEntrypoint');
  });

  it('stops before any npm command when the binding check fails', () => {
    // An omitted or `default` entrypoint binds the registry's control-plane
    // fetch. Publishing that and then noticing is the wrong order, so the
    // check runs while nothing has been installed or uploaded.
    const result = runWithStubbedNpm({ bindingCheckFails: true });
    expect(result.status).toBe(65);
    expect(result.stderr).toContain('does not bind REGISTRY explicitly');
    expect(result.npmCalls).toEqual([]);
  });

  it('distinguishes a check that could not RUN from a binding that is wrong', () => {
    // The validator parses the configuration with a ROOT devDependency, and
    // this guard runs before any install. Reporting that as a binding problem
    // would send the operator to edit the one block that is correct, so the
    // "could not run" exit gets its own code and its own instruction.
    const result = runWithStubbedNpm({ bindingCheckFails: true, bindingCheckExit: 69 });
    expect(result.status).toBe(69);
    expect(result.stderr).toContain('Could not run the registry binding check');
    // And the instruction has to be the one that WORKS. `smol-toml` is a root
    // devDependency, so a shell carrying NODE_ENV=production or
    // NPM_CONFIG_OMIT=dev omits it — `npm config get omit` reports `dev` under
    // either — and a bare `npm ci` would land the operator back on this exact
    // exit with nothing to show for the install.
    expect(result.stderr).toContain('npm ci --include=dev');
    expect(result.stderr).not.toContain('does not bind REGISTRY explicitly');
    expect(result.npmCalls).toEqual([]);
  });

  it.each([
    // A missing `node`, and one that will not execute. Neither is a verdict
    // about the binding, and only exit 1 is.
    ['a missing interpreter', 127],
    ['an interpreter that cannot run', 126],
  ])('does not report %s as a wrong binding', (_label, exitCode) => {
    const result = runWithStubbedNpm({ bindingCheckFails: true, bindingCheckExit: exitCode });
    expect(result.status).toBe(69);
    expect(result.stderr).toContain('Could not run the registry binding check');
    expect(result.stderr).not.toContain('does not bind REGISTRY explicitly');
    expect(result.npmCalls).toEqual([]);
  });

  it('assumes a cutover when the check passes without answering about routes', () => {
    // Fail-closed in the direction that matters: a route-bearing deploy that
    // announced "changes nothing the public sees" is the reassurance this
    // variable exists to withhold.
    const result = runWithStubbedNpm({ silentBindingCheck: true, secretListJson: '[]' });
    expect(result.stderr).toContain('ROUTES CONFIGURED');
    expect(result.stderr).not.toContain('no routes configured');
  });
});

describe('worker deploy guard — no surviving Firebase credential', () => {
  it('names worker/wrangler.toml explicitly on the secret readback', () => {
    // `npm exec` keeps the repository-root cwd, so without `--config` Wrangler
    // finds no configuration here (exit 75 on every deploy) or, given an
    // ancestor wrangler.toml, inspects the wrong Worker (Phase 4b P1, #1120).
    const result = runWithStubbedNpm({ secretListJson: '[]' });
    expect(result.status).toBe(0);
    const readback = result.npmCalls.find((call) => call.includes('secret list'));
    expect(readback).toBeDefined();
    expect(readback).toMatch(/--config \S*worker\/wrangler\.toml/);
    expect(readback).toContain('--env-file /dev/null');
  });

  it('passes when the deployed Worker carries no secrets at all', () => {
    // The App Check-compatible router reads no Firebase resource, so the
    // absence of the binding is the expected steady state (#972).
    const result = runWithStubbedNpm({ secretListJson: '[]' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('No FIREBASE_* binding on the deployed Worker');
  });

  it('refuses a deploy that leaves the old edge credential bound', () => {
    const result = runWithStubbedNpm({
      secretListJson: '[{"name":"FIREBASE_API_KEY","type":"secret_text"}]',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is STILL bound on the deployed Worker: FIREBASE_API_KEY');
    expect(result.stderr).toContain('wrangler secret delete');
  });

  it.each([
    ['a service account', 'FIREBASE_SERVICE_ACCOUNT'],
    ['the project id', 'FIREBASE_PROJECT_ID'],
    ['a near-miss of the api key name', 'FIREBASE_API_KEY_BACKUP'],
  ])('refuses every other Firebase-prefixed secret too (%s)', (_label, name) => {
    // R0 claims the public router carries no Firebase credential of ANY kind,
    // and this readback is the same prefix policy the binding validator
    // applies to plain-text [vars] — the two cannot disagree about what a
    // Firebase credential is.
    const result = runWithStubbedNpm({
      secretListJson: `[{"name":"${name}","type":"secret_text"}]`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`is STILL bound on the deployed Worker: ${name}`);
  });

  it.each([
    ['an entry with no name', '[{}]'],
    ['an entry whose name is not a string', '[{"name":123,"type":"secret_text"}]'],
    ['a non-object entry', '["FIREBASE_API_KEY"]'],
  ])('fails closed when the listing carries %s', (_label, listing) => {
    // The command documents its output as the complete secret list; an element
    // the check cannot read is evidence of nothing, like a non-array listing.
    const result = runWithStubbedNpm({ secretListJson: listing });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unreadable listing');
  });

  it('anchors the prefix at the start of the name rather than matching a substring', () => {
    // An unanchored match would refuse a deploy over an unrelated leftover
    // that merely CONTAINS the prefix.
    const result = runWithStubbedNpm({
      secretListJson:
        '[{"name":"OLD_FIREBASE_API_KEY","type":"secret_text"},{"name":"NOT_A_FIREBASE_THING","type":"secret_text"}]',
    });
    expect(result.status).toBe(0);
  });

  it('treats an uninspectable Worker as a FAILED verification, not a skipped one', () => {
    // Exiting 0 with a warning let automation record an unverified deploy as
    // verified, while the README presents this as artifact verification.
    const result = runWithStubbedNpm({ secretListFails: true });
    expect(result.status).toBe(75);
    expect(result.stderr).toContain('FAILED verification');
  });

  it.each([
    ['is not the array it should be', '{"unexpected":"shape"}'],
    ['is not JSON at all', 'wrangler: unexpected diagnostic output'],
    ['is empty', ''],
  ])('fails closed when the secret listing %s', (_label, secretListJson) => {
    // Inverting a check inverts its failure mode. Under the old presence test
    // an unparseable listing made `jq` exit non-zero and the deploy failed
    // closed by accident; under the absence test the same accident would read
    // as proof that no credential is bound.
    const result = runWithStubbedNpm({ secretListJson });
    expect(result.status).toBe(1);
  });
});

describe('worker deploy guard — route-bearing deploys', () => {
  it('installs the locked Wrangler before the pre-publish verification', () => {
    const result = runWithStubbedNpm({
      routeBearing: true,
      secretListJson: '[]',
      extraEnv: { NPM_CONFIG_OMIT: 'dev', NODE_ENV: 'production' },
    });
    expect(result.status).toBe(0);
    expect(result.npmCalls.slice(0, 2)).toEqual([
      '--prefix worker ci --include=dev',
      expect.stringMatching(/^--prefix worker exec -- wrangler secret list --format json --config \S+\/worker\/wrangler\.toml --env-file \/dev\/null$/),
    ]);
  });

  it('does not claim routes are unattached when none are configured', () => {
    // The shipped wrangler.toml keeps `routes` commented out.
    const result = runWithStubbedNpm({ secretListJson: '[]' });
    expect(result.stderr).toContain('no routes configured');
    expect(result.stderr).not.toContain('CHANGES LIVE TRAFFIC');
  });
});
