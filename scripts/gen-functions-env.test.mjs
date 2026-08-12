// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyParams, envFileLines, secretFileLines } from './gen-functions-env.mjs';

// Fixtures shaped like the real firebase-functions/params `Param` instances
// (see the duck-typing note in gen-functions-env.mjs): value params carry
// `name` + `options`, secret params carry only `name`.
const STRING_PARAM_WITH_DEFAULT = { name: 'EMAIL_REPLY_TO', options: { default: '' } };
const BOOLEAN_PARAM_WITH_DEFAULT = { name: 'BUG_REPORT_APP_CHECK', options: { default: false } };
const STRING_PARAM_NO_DEFAULT = { name: 'SOME_NEW_PARAM', options: {} };
const SECRET_PARAM = { name: 'RESEND_API_KEY' };
const UNREGISTERED_SECRET_PARAM = { name: 'SOME_NEW_SECRET' };

describe('classifyParams', () => {
  it('separates value params (which carry `options`) from secret params (which do not)', () => {
    const { valueParams, secretParams } = classifyParams({
      EMAIL_REPLY_TO: STRING_PARAM_WITH_DEFAULT,
      RESEND_API_KEY: SECRET_PARAM,
    });
    expect(valueParams).toEqual([STRING_PARAM_WITH_DEFAULT]);
    expect(secretParams).toEqual([SECRET_PARAM]);
  });

  it('ignores non-param exports so the params module can carry other helpers', () => {
    const { valueParams, secretParams } = classifyParams({
      EMAIL_REPLY_TO: STRING_PARAM_WITH_DEFAULT,
      helperFn: () => {},
      someConstant: 42,
    });
    expect(valueParams).toEqual([STRING_PARAM_WITH_DEFAULT]);
    expect(secretParams).toEqual([]);
  });
});

describe('envFileLines', () => {
  it('derives NAME=default for every value param, regression-covering the #724 omissions', () => {
    const lines = envFileLines([STRING_PARAM_WITH_DEFAULT, BOOLEAN_PARAM_WITH_DEFAULT]);
    expect(lines).toBe('BUG_REPORT_APP_CHECK=false\nEMAIL_REPLY_TO=');
  });

  it('applies a registered e2e override instead of the code default', () => {
    const lines = envFileLines([{ name: 'EMAIL_FROM', options: { default: 'prod@example.com' } }], {
      EMAIL_FROM: 'e2e@example.invalid',
    });
    expect(lines).toBe('EMAIL_FROM=e2e@example.invalid');
  });

  it('fails loudly instead of silently omitting a param with no default and no override', () => {
    expect(() => envFileLines([STRING_PARAM_NO_DEFAULT])).toThrow(/SOME_NEW_PARAM/);
    expect(() => envFileLines([STRING_PARAM_NO_DEFAULT])).toThrow(/without a default/);
  });

  it('lets a registered override stand in for a param with no code default', () => {
    const lines = envFileLines([STRING_PARAM_NO_DEFAULT], { SOME_NEW_PARAM: 'overridden' });
    expect(lines).toBe('SOME_NEW_PARAM=overridden');
  });
});

describe('secretFileLines', () => {
  it('derives NAME=value for every registered secret param', () => {
    const lines = secretFileLines([SECRET_PARAM], { RESEND_API_KEY: 'e2e-not-used' });
    expect(lines).toBe('RESEND_API_KEY=e2e-not-used');
  });

  it('fails loudly instead of silently omitting an unregistered secret param', () => {
    expect(() => secretFileLines([UNREGISTERED_SECRET_PARAM], { RESEND_API_KEY: 'e2e-not-used' })).toThrow(
      /SOME_NEW_SECRET/,
    );
  });
});
