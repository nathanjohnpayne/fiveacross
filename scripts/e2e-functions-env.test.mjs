// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// The dotenv reader these files are actually written for. Asserting against it
// rather than against a hand-rolled parser is the point: both of the Codex P2
// findings on PR #730 were cases where a plausible-looking regex disagreed with
// this module. It is a devDependency, so it is present wherever `npm test` runs.
import { parse } from 'firebase-tools/lib/functions/env.js';
import {
  E2E_SECRET_VALUES,
  FUNCTIONS_EMULATOR_PORT,
  declaredParamNames,
  e2eFunctionsEnv,
  e2eParamValues,
  formatAssignment,
  unassignedNames,
} from './e2e-functions-env.mjs';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const PARAMS_SOURCE = read('../functions/src/params.ts');
const PROJECT_ID = 'demo-gaycruisebingo-e2e';

// The regression this file exists for (#724). `npm run test:e2e` is a local
// smoke runner that app-ci deliberately does not execute, so nothing in CI ever
// starts the emulator — a param added to functions/src/params.ts without a
// matching value would otherwise reach main unnoticed and hang the suite for
// whoever ran it next on a checkout with no functions/.env.local.
describe('e2e functions dotenv generation', () => {
  it('has a value for every param functions/src/params.ts declares', () => {
    expect(() => e2eFunctionsEnv(PARAMS_SOURCE, PROJECT_ID)).not.toThrow();
  });

  it('assigns each declared param exactly one line in the file the emulator loads', () => {
    const { params, secrets } = declaredParamNames(PARAMS_SOURCE);
    const { env, secret } = e2eFunctionsEnv(PARAMS_SOURCE, PROJECT_ID);

    expect(unassignedNames(env, params)).toEqual([]);
    expect(unassignedNames(secret, secrets)).toEqual([]);
    expect(env.trimEnd().split('\n')).toHaveLength(params.length);
  });

  it('names the uncovered param rather than generating a file that hangs the emulator', () => {
    const withNewParam = `${PARAMS_SOURCE}\nexport const SMTP_BRIDGE_URL = defineString('SMTP_BRIDGE_URL', { default: '' });\n`;

    expect(() => e2eFunctionsEnv(withNewParam, PROJECT_ID)).toThrow('SMTP_BRIDGE_URL');
  });

  it('refuses to emit an empty file set when the declarations stop parsing', () => {
    expect(() => declaredParamNames('export const nothing = 1;\n')).toThrow(/DEFINE_RE/);
  });

  // Codex P2 on PR #730: an enumerated list of constructors fails silently —
  // the omitted one is skipped, the existing declarations keep the zero-match
  // guard quiet, and every assertion still passes.
  it('catches every param constructor, including ones this repo does not use yet', () => {
    const exotic = [
      "defineFloat('SAMPLE_RATE', { default: 0.5 })",
      "defineInt('BATCH_SIZE', { default: 10 })",
      "defineList('ALLOWED_HOSTS', { default: [] })",
      // Not an SDK export today. A constructor a future firebase-functions adds
      // must be caught without an edit to DEFINE_RE.
      "defineDuration('RETRY_BACKOFF')",
    ].join('\n');

    expect(declaredParamNames(exotic).params).toEqual([
      'SAMPLE_RATE',
      'BATCH_SIZE',
      'ALLOWED_HOSTS',
      'RETRY_BACKOFF',
    ]);
  });

  it('ignores a prose reference to a constructor in a doc comment', () => {
    const withProse = `${PARAMS_SOURCE}\n// equally a defineBoolean(...) read, which is not a declaration\n`;

    expect(declaredParamNames(withProse)).toEqual(declaredParamNames(PARAMS_SOURCE));
  });

  it('separates secrets from plain params', () => {
    const { params, secrets } = declaredParamNames(PARAMS_SOURCE);

    expect(secrets).toEqual(['RESEND_API_KEY']);
    expect(params).not.toContain('RESEND_API_KEY');
  });

  it('keeps every value hermetic, so no e2e run can address a live host', () => {
    const { env } = e2eFunctionsEnv(PARAMS_SOURCE, PROJECT_ID);

    expect(env).toContain(
      `EMAIL_UNSUBSCRIBE_URL=http://127.0.0.1:${FUNCTIONS_EMULATOR_PORT}/${PROJECT_ID}/us-central1/emailUnsubscribe`,
    );
    expect(env).not.toMatch(/=https:\/\//);
    expect(env).not.toContain('gaycruisebingo.com');
  });

  it('addresses the unsubscribe endpoint on the port firebase.json emulates', () => {
    const firebaseJson = JSON.parse(read('../firebase.json'));

    expect(firebaseJson.emulators.functions.port).toBe(FUNCTIONS_EMULATOR_PORT);
  });

  it('reports the missing keys in a stale file a developer already had', () => {
    const stale = 'EMAIL_FROM=Gay Cruise Bingo <e2e@example.invalid>\nAPP_BASE_URL=http://127.0.0.1:4173\n';

    expect(unassignedNames(stale, declaredParamNames(PARAMS_SOURCE).params)).toContain(
      'EMAIL_UNSUBSCRIBE_URL',
    );
  });

  // Codex P2 on PR #730: this check aborts someone else's run, so it must not
  // be stricter than the parser it is standing in for.
  it('accepts every assignment form the emulator itself accepts', () => {
    const emulatorLegal = 'export EMAIL_FROM=a\nEMAIL_REPLY_TO = b\n  APP_BASE_URL=c\n';

    expect(parse(emulatorLegal).envs).toEqual({
      EMAIL_FROM: 'a',
      EMAIL_REPLY_TO: 'b',
      APP_BASE_URL: 'c',
    });
    expect(unassignedNames(emulatorLegal, ['EMAIL_FROM', 'EMAIL_REPLY_TO', 'APP_BASE_URL'])).toEqual(
      [],
    );
  });

  it('does not count a commented-out key as assigned', () => {
    expect(unassignedNames('# EMAIL_FROM=a\n', ['EMAIL_FROM'])).toEqual(['EMAIL_FROM']);
  });
});

// Codex P2 on PR #730. firebase-tools' own writer escapes only what its parser
// unescapes, which still round-trips lossily through its reader for an unquoted
// `#` or untrimmed value — silently, and invisibly to a test that only counts
// assignment lines.
describe('dotenv value round trip', () => {
  it('reads back every generated value exactly as configured', () => {
    const { params, secrets } = declaredParamNames(PARAMS_SOURCE);
    const { env, secret } = e2eFunctionsEnv(PARAMS_SOURCE, PROJECT_ID);
    const values = e2eParamValues(PROJECT_ID);

    for (const name of params) {
      expect(parse(env).envs[name]).toBe(values[name]);
    }
    for (const name of secrets) {
      expect(parse(secret).envs[name]).toBe(E2E_SECRET_VALUES[name]);
    }
  });

  it('survives values that would otherwise be truncated or trimmed', () => {
    const hostile = ['QA #1', 'a\nb', ' padded ', 'quote"and\'apostrophe', 'back\\slash', ''];

    for (const value of hostile) {
      expect(parse(formatAssignment('SOME_PARAM', value)).envs.SOME_PARAM).toBe(value);
    }
  });

  it('leaves an ordinary value unquoted, so the file stays readable', () => {
    expect(formatAssignment('APP_BASE_URL', 'http://127.0.0.1:4173')).toBe(
      'APP_BASE_URL=http://127.0.0.1:4173',
    );
  });
});

// The deploy-side twin of the same failure. `firebase deploy` resolves the same
// params, so a param missing from the committed template stops a non-interactive
// deploy at parameter resolution — the reason functions/.env.example declares
// BUG_REPORT_APP_CHECK explicitly rather than leaning on its default (#158).
describe('functions/.env.example', () => {
  it('declares every param, so a non-interactive deploy never stops to prompt', () => {
    const template = read('../functions/.env.example');
    const { params } = declaredParamNames(PARAMS_SOURCE);

    expect(unassignedNames(template, params)).toEqual([]);
  });

  it('keeps RESEND_API_KEY out, since a secret is not a dotenv value', () => {
    expect(read('../functions/.env.example')).not.toMatch(/^\s*RESEND_API_KEY=/m);
  });
});
