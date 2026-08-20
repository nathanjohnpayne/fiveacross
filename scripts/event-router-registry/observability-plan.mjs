#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY_R0_CONTRACT, validateRegistryR0Contract } from './r0-contract.mjs';

export const OBSERVABILITY_PLAN_USAGE =
  'node scripts/event-router-registry/observability-plan.mjs --input=<path|->';

const CLOUDFLARE_ID = /^[0-9a-f]{32}$/;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BILLING_PRODUCT = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const NAMESPACES = Object.freeze(['fiveacross.app', 'vacaybingo.com']);
const NOTIFICATION_MECHANISMS = new Set(['email', 'pagerduty', 'webhooks']);

function assertExactObject(value, fields, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields must exactly match ${expected.join(', ')}`);
  }
}

function notificationIdIsValid(notification) {
  if (notification.mechanism === 'email') {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notification.id);
  }
  return CLOUDFLARE_ID.test(notification.id);
}

export function parseRegistryObservabilityPlanInput(input) {
  assertExactObject(
    input,
    [
      'schemaVersion',
      'accountId',
      'registryScriptName',
      'zones',
      'logExplorerRetentionDays',
      'monthlyCostLimitUsd',
      'billingProductFilter',
      'notification',
    ],
    'observability plan input',
  );
  if (input.schemaVersion !== 1) throw new Error('unsupported observability plan schema');
  if (typeof input.accountId !== 'string' || !CLOUDFLARE_ID.test(input.accountId)) {
    throw new Error('invalid Cloudflare account ID');
  }
  if (typeof input.registryScriptName !== 'string' || !WORKER_NAME.test(input.registryScriptName)) {
    throw new Error('invalid registry Worker name');
  }
  assertExactObject(input.zones, NAMESPACES, 'observability zone mapping');
  for (const namespace of NAMESPACES) {
    if (typeof input.zones[namespace] !== 'string' || !CLOUDFLARE_ID.test(input.zones[namespace])) {
      throw new Error(`invalid Cloudflare zone ID for ${namespace}`);
    }
  }
  if (
    !Number.isSafeInteger(input.logExplorerRetentionDays) ||
    input.logExplorerRetentionDays < 1 ||
    input.logExplorerRetentionDays > 730
  ) {
    throw new Error('invalid reviewed Log Explorer retention');
  }
  if (
    !Number.isSafeInteger(input.monthlyCostLimitUsd) ||
    input.monthlyCostLimitUsd < 1 ||
    input.monthlyCostLimitUsd > 1_000_000
  ) {
    throw new Error('invalid monthly cost limit');
  }
  if (
    typeof input.billingProductFilter !== 'string' ||
    !BILLING_PRODUCT.test(input.billingProductFilter) ||
    input.billingProductFilter !== 'log-explorer'
  ) {
    throw new Error('invalid billing product filter');
  }
  assertExactObject(input.notification, ['mechanism', 'id'], 'notification destination');
  if (
    !NOTIFICATION_MECHANISMS.has(input.notification.mechanism) ||
    typeof input.notification.id !== 'string' ||
    !notificationIdIsValid(input.notification)
  ) {
    throw new Error('invalid notification destination');
  }
  return structuredClone(input);
}

function datasetPlans(input, contract) {
  return NAMESPACES.flatMap((namespace) =>
    contract.cloudflare.logExplorer.datasets.map((dataset) => ({
      scope: namespace,
      zoneId: input.zones[namespace],
      dataset,
      create: {
        method: 'POST',
        path: `/zones/${input.zones[namespace]}/logs/explorer/datasets`,
        body: { dataset },
      },
      readback: {
        method: 'GET',
        path: `/zones/${input.zones[namespace]}/logs/explorer/datasets`,
        requireUniqueDataset: dataset,
      },
      expected: {
        enabled: true,
        sampled: contract.cloudflare.logExplorer.sampled,
        objectType: 'zone',
        objectId: input.zones[namespace],
      },
    })),
  );
}

function semanticAlertShape(policy) {
  if (Object.hasOwn(policy, 'countGreaterThan')) {
    return {
      requiredKeys: [],
      filters: [],
      calculations: [{ operator: 'count', alias: 'matchedEvents' }],
      trigger: {
        aggregateAlias: 'matchedEvents',
        operation: 'gt',
        value: policy.countGreaterThan,
      },
    };
  }
  if (Object.hasOwn(policy, 'gapAgeMsGreaterThan')) {
    return {
      requiredKeys: ['gapAgeMs'],
      filters: [
        {
          key: 'gapAgeMs',
          operation: 'gt',
          type: 'number',
          value: policy.gapAgeMsGreaterThan,
        },
      ],
      calculations: [{ operator: 'count', alias: 'matchedEvents' }],
      trigger: { aggregateAlias: 'matchedEvents', operation: 'gt', value: 0 },
    };
  }
  if (Object.hasOwn(policy, 'distinctHostsGreaterThan')) {
    return {
      requiredKeys: [],
      filters: [],
      calculations: [
        {
          operator: 'uniq',
          alias: 'distinctHosts',
          key: 'host',
          keyType: 'string',
        },
      ],
      trigger: {
        aggregateAlias: 'distinctHosts',
        operation: 'gt',
        value: policy.distinctHostsGreaterThan,
      },
    };
  }
  throw new Error(`alert policy ${policy.id} has no supported exact threshold`);
}

function semanticPlans(input, contract) {
  const observability = contract.cloudflare.observability;
  return observability.alertPolicies.map((policy) => {
    const shape = semanticAlertShape(policy);
    return {
      id: policy.id,
      outcome: policy.outcome,
      excludedFields: [...observability.excludedFields],
      keyReadback: {
        method: 'POST',
        path: `/accounts/${input.accountId}/workers/observability/telemetry/keys`,
        bodyTemplate: {
          timeframe: { from: '{window-start-unix-ms}', to: '{window-end-unix-ms}' },
          datasets: [],
          filters: [
            {
              key: '$metadata.service',
              operation: 'eq',
              type: 'string',
              value: input.registryScriptName,
            },
          ],
        },
        required: [...observability.requiredFields, ...shape.requiredKeys],
        requireTypes: {
          event: 'string',
          outcome: 'string',
          registryVersion: 'string',
          host: 'string',
          revision: 'string',
          latencyMs: 'number',
          ...(shape.requiredKeys.includes('gapAgeMs') ? { gapAgeMs: 'number' } : {}),
        },
        rejectPresent: [...observability.excludedFields],
      },
      query: {
        method: 'POST',
        path: `/accounts/${input.accountId}/workers/observability/telemetry/query`,
        bodyTemplate: {
          queryId: `event-router-registry-${policy.id}`,
          timeframe: { from: '{window-start-unix-ms}', to: '{window-end-unix-ms}' },
          chart: false,
          chartType: 'aggregate',
          dry: true,
          ignoreSeries: true,
          parameters: {
            calculations: shape.calculations,
            datasets: [],
            filterCombination: 'and',
            filters: [
              {
                key: '$metadata.service',
                operation: 'eq',
                type: 'string',
                value: input.registryScriptName,
              },
              {
                key: 'event',
                operation: 'eq',
                type: 'string',
                value: observability.semanticEvent,
              },
              { key: 'outcome', operation: 'eq', type: 'string', value: policy.outcome },
              ...shape.filters,
            ],
          },
        },
      },
      evaluation: {
        windowSeconds: policy.windowSeconds,
        trigger: shape.trigger,
        destination: structuredClone(input.notification),
        providerNativeScheduledQueryAvailable: false,
        requiredExecutor: 'reviewed-scheduled-read-only-query-runner',
        failClosedUnlessReadbackMatches: true,
      },
    };
  });
}

export function renderRegistryObservabilityPlan(rawInput, contract = REGISTRY_R0_CONTRACT) {
  const input = parseRegistryObservabilityPlanInput(rawInput);
  validateRegistryR0Contract(contract);
  const observability = contract.cloudflare.observability;
  const contractSha256 = createHash('sha256').update(JSON.stringify(contract)).digest('hex');
  return {
    schemaVersion: 1,
    mode: 'render-only',
    providerWritesExecuted: false,
    credentialsIncluded: false,
    accountId: input.accountId,
    registryScriptName: input.registryScriptName,
    r0ContractSha256: contractSha256,
    workersLogs: {
      enabled: observability.workersLogs.enabled,
      headSamplingRate: observability.workersLogs.headSamplingRate,
      requiredReadback: {
        service: input.registryScriptName,
        requireExact: true,
      },
    },
    logExplorer: {
      datasets: datasetPlans(input, contract),
      retention: {
        minimumDays: input.logExplorerRetentionDays,
        providerApiSupported: false,
        requiredReviewedReadback: true,
        gate: 'block-until-account-contract-readback-confirms-retention',
      },
    },
    costAlert: {
      preflight: {
        method: 'GET',
        path: `/accounts/${input.accountId}/alerting/v3/available_alerts`,
        requireAlertType: 'billing_usage_alert',
        requireProductFilter: input.billingProductFilter,
      },
      create: {
        method: 'POST',
        path: `/accounts/${input.accountId}/alerting/v3/policies`,
        body: {
          alert_type: 'billing_usage_alert',
          enabled: true,
          mechanisms: {
            [input.notification.mechanism]: [{ id: input.notification.id }],
          },
          name: 'Event router registry Log Explorer usage',
          description: 'Page before Log Explorer registry evidence exceeds its reviewed monthly limit.',
          filters: {
            limit: [String(input.monthlyCostLimitUsd)],
            product: [input.billingProductFilter],
          },
        },
      },
      readback: {
        method: 'GET',
        path: `/accounts/${input.accountId}/alerting/v3/policies/{created-policy-id}`,
        requireExactBody: true,
      },
    },
    semanticAlerts: semanticPlans(input, contract),
    executionGate: {
      exactR0ContractRequired: true,
      exactProviderReadbacksRequired: true,
      noDeploymentOrRouteMutation: true,
      noProviderCredentialFields: true,
    },
  };
}

async function defaultReadText(path) {
  return readFile(path === '-' ? 0 : path, 'utf8');
}

export async function runRegistryObservabilityPlanCli(args, deps = {}) {
  if (args.length !== 1 || !args[0].startsWith('--input=')) {
    const unknown = args.find((argument) => !argument.startsWith('--input='));
    if (unknown !== undefined) throw new Error(`unknown argument: ${unknown.split('=')[0]}`);
    throw new Error('exactly one --input=<path|-> argument is required');
  }
  const path = args[0].slice('--input='.length);
  if (path.length === 0 || /[\r\n\0]/.test(path)) throw new Error('invalid observability plan input path');
  const readText = deps.readText ?? defaultReadText;
  const writeStdout = deps.writeStdout ?? ((text) => process.stdout.write(text));
  let input;
  try {
    input = JSON.parse(await readText(path));
  } catch (error) {
    throw new Error('observability plan input must be valid JSON', { cause: error });
  }
  const plan = renderRegistryObservabilityPlan(input);
  writeStdout(`${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

const isMain =
  typeof process.argv[1] === 'string' && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write(`${OBSERVABILITY_PLAN_USAGE}\n`);
  } else {
    runRegistryObservabilityPlanCli(process.argv.slice(2)).catch((error) => {
      process.stderr.write(`${error.message}\n${OBSERVABILITY_PLAN_USAGE}\n`);
      process.exitCode = 1;
    });
  }
}
