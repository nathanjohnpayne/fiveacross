import { readFileSync } from 'node:fs';

const config = JSON.parse(
  readFileSync(new URL('../deployment.json', import.meta.url), 'utf8'),
);
const args = process.argv.slice(2);
const triggerLocationMatch =
  args.length === 1
    ? /^--trigger-location=([a-z][a-z0-9-]{1,62})$/.exec(args[0])
    : null;
if (triggerLocationMatch === null) {
  throw new Error(
    'explicit reviewed --trigger-location=<database-location> is required',
  );
}
const triggerLocation = triggerLocationMatch[1];

const command = [
  'gcloud',
  'functions',
  'deploy',
  config.name,
  '--gen2',
  `--project=${config.project}`,
  `--region=${config.region}`,
  `--runtime=${config.runtime}`,
  `--source=${config.source}`,
  `--entry-point=${config.entryPoint}`,
  `--service-account=${config.serviceAccount}`,
  `--max-instances=${config.maxInstances}`,
  `--timeout=${config.timeout}`,
  `--trigger-location=${triggerLocation}`,
  '--retry',
  `--trigger-event-filters=type=${config.eventType},database=${config.database}`,
  `--trigger-event-filters-path-pattern=document=${config.documentPathPattern}`,
];

console.log(command.map((part) => JSON.stringify(part)).join(' '));
console.log('plan only: no deployment command was executed');
