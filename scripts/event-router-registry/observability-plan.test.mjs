import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { REGISTRY_R0_CONTRACT } from './r0-contract.mjs';
import {
  parseRegistryObservabilityPlanInput,
  renderRegistryObservabilityPlan,
  runRegistryObservabilityPlanCli,
} from './observability-plan.mjs';

const INPUT = {
  schemaVersion: 1,
  accountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  registryScriptName: 'five-across-event-registry',
  zones: {
    'fiveacross.app': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'vacaybingo.com': 'cccccccccccccccccccccccccccccccc',
  },
  logExplorerRetentionDays: 30,
  monthlyCostLimitUsd: 50,
  billingProductFilter: 'log-explorer',
  notification: {
    mechanism: 'webhooks',
    id: 'dddddddddddddddddddddddddddddddd',
  },
};

describe('R0 registry observability provisioning plan', () => {
  it('renders only provider plans/readbacks for both nonsampled Log Explorer datasets', () => {
    const plan = renderRegistryObservabilityPlan(INPUT);
    expect(plan).toMatchObject({
      schemaVersion: 1,
      mode: 'render-only',
      providerWritesExecuted: false,
      credentialsIncluded: false,
      accountId: INPUT.accountId,
      registryScriptName: INPUT.registryScriptName,
      workersLogs: {
        enabled: true,
        headSamplingRate: 1,
      },
    });
    expect(plan.logExplorer.datasets).toHaveLength(4);
    expect(
      plan.logExplorer.datasets.map(({ scope, dataset, create }) => ({
        scope,
        dataset,
        create,
      })),
    ).toEqual([
      {
        scope: 'fiveacross.app',
        dataset: 'http_requests',
        create: {
          method: 'POST',
          path: `/zones/${INPUT.zones['fiveacross.app']}/logs/explorer/datasets`,
          body: { dataset: 'http_requests' },
        },
      },
      {
        scope: 'fiveacross.app',
        dataset: 'firewall_events',
        create: {
          method: 'POST',
          path: `/zones/${INPUT.zones['fiveacross.app']}/logs/explorer/datasets`,
          body: { dataset: 'firewall_events' },
        },
      },
      {
        scope: 'vacaybingo.com',
        dataset: 'http_requests',
        create: {
          method: 'POST',
          path: `/zones/${INPUT.zones['vacaybingo.com']}/logs/explorer/datasets`,
          body: { dataset: 'http_requests' },
        },
      },
      {
        scope: 'vacaybingo.com',
        dataset: 'firewall_events',
        create: {
          method: 'POST',
          path: `/zones/${INPUT.zones['vacaybingo.com']}/logs/explorer/datasets`,
          body: { dataset: 'firewall_events' },
        },
      },
    ]);
    expect(plan.logExplorer.datasets.every(({ expected }) => expected.enabled === true)).toBe(true);
    expect(plan.logExplorer.datasets.every(({ expected }) => expected.sampled === false)).toBe(true);
    expect(plan.logExplorer.retention).toEqual({
      minimumDays: 30,
      providerApiSupported: false,
      requiredReviewedReadback: true,
      gate: 'block-until-account-contract-readback-confirms-retention',
    });
  });

  it('binds cost and semantic monitors to the R0 contract with executable API shapes', () => {
    const plan = renderRegistryObservabilityPlan(INPUT);
    expect(plan.costAlert).toEqual({
      preflight: {
        method: 'GET',
        path: `/accounts/${INPUT.accountId}/alerting/v3/available_alerts`,
        requireAlertType: 'billing_usage_alert',
        requireProductFilter: 'log-explorer',
      },
      create: {
        method: 'POST',
        path: `/accounts/${INPUT.accountId}/alerting/v3/policies`,
        body: {
          alert_type: 'billing_usage_alert',
          enabled: true,
          mechanisms: { webhooks: [{ id: INPUT.notification.id }] },
          name: 'Event router registry Log Explorer usage',
          description: 'Page before Log Explorer registry evidence exceeds its reviewed monthly limit.',
          filters: { limit: ['50'], product: ['log-explorer'] },
        },
      },
      readback: {
        method: 'GET',
        path: `/accounts/${INPUT.accountId}/alerting/v3/policies/{created-policy-id}`,
        requireExactBody: true,
      },
    });
    expect(plan.semanticAlerts.map(({ id }) => id)).toEqual(
      REGISTRY_R0_CONTRACT.cloudflare.observability.alertPolicies.map(({ id }) => id),
    );
    for (const monitor of plan.semanticAlerts) {
      expect(monitor.query).toMatchObject({
        method: 'POST',
        path: `/accounts/${INPUT.accountId}/workers/observability/telemetry/query`,
        bodyTemplate: {
          queryId: `event-router-registry-${monitor.id}`,
          chart: false,
          chartType: 'aggregate',
          dry: true,
          ignoreSeries: true,
          parameters: {
            datasets: [],
            filterCombination: 'and',
            filters: expect.arrayContaining([
              { key: '$metadata.service', operation: 'eq', type: 'string', value: INPUT.registryScriptName },
              {
                key: 'event',
                operation: 'eq',
                type: 'string',
                value: REGISTRY_R0_CONTRACT.cloudflare.observability.semanticEvent,
              },
              {
                key: 'outcome',
                operation: 'eq',
                type: 'string',
                value: monitor.outcome,
              },
            ]),
          },
        },
      });
      expect(monitor.keyReadback.required).toEqual(
        monitor.id === 'aged-revision-gap'
          ? [...REGISTRY_R0_CONTRACT.cloudflare.observability.requiredFields, 'gapAgeMs']
          : REGISTRY_R0_CONTRACT.cloudflare.observability.requiredFields,
      );
      expect(monitor.excludedFields).toEqual(
        REGISTRY_R0_CONTRACT.cloudflare.observability.excludedFields,
      );
      if (monitor.id === 'empty-object-cardinality') {
        expect(monitor.query.bodyTemplate.parameters.calculations).toEqual([
          {
            operator: 'uniq',
            alias: 'distinctHosts',
            key: 'host',
            keyType: 'string',
          },
        ]);
        expect(monitor.evaluation.trigger).toEqual({
          aggregateAlias: 'distinctHosts',
          operation: 'gt',
          value: 64,
        });
      } else {
        expect(monitor.query.bodyTemplate.parameters.calculations).toEqual([
          { operator: 'count', alias: 'matchedEvents' },
        ]);
      }
    }
    expect(plan.semanticAlerts.find(({ id }) => id === 'aged-revision-gap')).toMatchObject({
      evaluation: {
        trigger: { aggregateAlias: 'matchedEvents', operation: 'gt', value: 0 },
      },
      query: {
        bodyTemplate: {
          parameters: {
            filters: expect.arrayContaining([
              { key: 'gapAgeMs', operation: 'gt', type: 'number', value: 300_000 },
            ]),
          },
        },
      },
    });
  });

  it('names the unavoidable telemetry permission and contains it to fixed nonmutating requests', () => {
    const plan = renderRegistryObservabilityPlan(INPUT);
    expect(plan.telemetryAuthorization).toEqual({
      requiredProviderPermission: 'Workers Observability Write',
      readOnlyProviderPermissionAvailable: false,
      providerPermissionExceedsOperationalNeed: true,
      scope: {
        accountId: INPUT.accountId,
        serviceFilter: INPUT.registryScriptName,
      },
      allowedRequests: [
        {
          operation: 'key-discovery',
          method: 'POST',
          path: `/accounts/${INPUT.accountId}/workers/observability/telemetry/keys`,
          fixedRenderedBodyRequired: true,
        },
        {
          operation: 'dry-query',
          method: 'POST',
          path: `/accounts/${INPUT.accountId}/workers/observability/telemetry/query`,
          fixedRenderedBodyRequired: true,
          inlineParametersRequired: true,
          dryRequired: true,
        },
      ],
      forbiddenOperations: [
        'saved-query-create-update-delete',
        'telemetry-values',
        'live-tail',
        'provider-resource-mutation',
      ],
      providerMutationAllowed: false,
    });
    for (const monitor of plan.semanticAlerts) {
      expect(monitor.keyReadback).toMatchObject({
        method: 'POST',
        path: plan.telemetryAuthorization.allowedRequests[0].path,
      });
      expect(monitor.query).toMatchObject({
        method: 'POST',
        path: plan.telemetryAuthorization.allowedRequests[1].path,
        bodyTemplate: {
          dry: true,
          parameters: expect.any(Object),
        },
      });
      expect(monitor.evaluation.requiredExecutor).toBe(
        'reviewed-scheduled-contained-telemetry-runner',
      );
    }
    expect(plan.executionGate).toMatchObject({
      telemetryRequestsMustMatchAllowlist: true,
      telemetryQueryDryMustRemainTrue: true,
      providerMutationForbidden: true,
    });
  });

  it('documents the broader provider permission without promising a read-only token', async () => {
    const readme = await readFile('scripts/event-router-registry/README.md', 'utf8');
    expect(readme).toContain(
      'Cloudflare currently requires the exact `Workers Observability Write` permission for both telemetry operations',
    );
    expect(readme).toContain(
      'There is no narrower read-only Cloudflare permission for these endpoints.',
    );
    expect(readme).toContain(
      'The runner must accept only the artifact\'s fixed key-discovery body and fixed inline `dry: true` query bodies',
    );
    expect(readme).not.toContain('scheduled read-only query runner');
  });

  it('renders the plan through a credential-free CLI input seam', async () => {
    const writes = [];
    await runRegistryObservabilityPlanCli(['--input=-'], {
      readText: async (path) => {
        expect(path).toBe('-');
        return JSON.stringify(INPUT);
      },
      writeStdout: (text) => writes.push(text),
    });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({
      mode: 'render-only',
      providerWritesExecuted: false,
      credentialsIncluded: false,
    });
    await expect(
      runRegistryObservabilityPlanCli(['--input=-', '--api-token=secret'], {
        readText: async () => JSON.stringify(INPUT),
      }),
    ).rejects.toThrow('unknown argument');
  });

  it.each([
    ['unknown field', { extra: true }],
    ['bad account', { accountId: 'not-an-account' }],
    ['sampleable cost', { monthlyCostLimitUsd: 0 }],
    ['wrong billing product', { billingProductFilter: 'workers' }],
    ['missing zone', { zones: { 'fiveacross.app': INPUT.zones['fiveacross.app'] } }],
    ['credential-shaped input', { apiToken: 'secret' }],
  ])('fails closed on %s', (_label, override) => {
    const candidate = structuredClone(INPUT);
    Object.assign(candidate, override);
    expect(() => parseRegistryObservabilityPlanInput(candidate)).toThrow();
  });
});
