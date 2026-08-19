import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const dependencyPaths = Object.keys(lock.packages ?? {});
const dependencyNames = Object.values(lock.packages ?? {})
  .map((entry) => entry?.name)
  .filter((name) => typeof name === 'string');

for (const forbidden of ['firebase-admin', 'firebase-functions']) {
  if (
    dependencyNames.includes(forbidden) ||
    dependencyPaths.some((path) => path.split('node_modules/').at(-1) === forbidden) ||
    existsSync(`${packageRoot}node_modules/${forbidden}/package.json`)
  ) {
    throw new Error(`forbidden runtime dependency: ${forbidden}`);
  }
}

console.log('publisher dependency graph contains no Firebase Admin or Functions SDK');
