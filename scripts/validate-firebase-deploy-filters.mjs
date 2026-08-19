#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkValidTargetFilters } = require('firebase-tools/lib/checkValidTargetFilters');

const [only = '', except = ''] = process.argv.slice(2);

try {
  await checkValidTargetFilters({
    only: only || undefined,
    except: except || undefined,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`✗ Invalid Firebase deploy target filters: ${message}.`);
  console.error('  NOTHING HAS BEEN BUILT OR PUBLISHED.');
  process.exitCode = 1;
}
