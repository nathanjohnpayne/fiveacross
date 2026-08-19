#!/usr/bin/env node

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { checkValidTargetFilters } = require('firebase-tools/lib/checkValidTargetFilters');
const { extract, filterExcept, filterOnly } = require('firebase-tools/lib/hosting/config');

const [only = '', except = '', project = '', configPath = 'firebase.json'] = process.argv.slice(2);

try {
  await checkValidTargetFilters({
    only: only || undefined,
    except: except || undefined,
  });

  const configSource = JSON.parse(await readFile(configPath, 'utf8'));
  const options = {
    config: { src: configSource },
    site: project || undefined,
  };
  let hostingConfigs = extract(options);
  hostingConfigs = filterOnly(hostingConfigs, only || undefined);
  hostingConfigs = filterExcept(hostingConfigs, except || undefined);
  console.log(hostingConfigs.length > 0 ? 'hosting-selected' : 'hosting-not-selected');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`✗ Invalid Firebase deploy target filters: ${message}.`);
  console.error('  NOTHING HAS BEEN BUILT OR PUBLISHED.');
  process.exitCode = 1;
}
