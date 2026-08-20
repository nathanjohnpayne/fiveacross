# Private registry provisioning renderers

These commands render reviewed R0 artifacts only. They do not authenticate to Google or Cloudflare, create or update provider resources, deploy Workers or Functions, or attach routes. A human provisioning session supplies provider responses through files or standard input and separately applies a reviewed plan with least-privilege provider tooling.

## Pin one Cloud KMS public key

Obtain the exact JSON response from Cloud KMS `projects.locations.keyRings.cryptoKeys.cryptoKeyVersions.getPublicKey` for one explicit version through the separately authenticated provisioning identity. Preserve the response fields `name`, `algorithm`, `pem`, and `pemCrc32c` exactly. The renderer also accepts the provider's optional `protectionLevel` and PEM `publicKeyFormat` metadata, while rejecting missing, unknown, or alternate public-key payload fields.

```sh
node scripts/event-router-registry/pin-public-key.mjs \
  --role=publisher \
  --subject=1001 \
  --epoch-or-slot=1 \
  --key-version=projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/replica-publisher/cryptoKeyVersions/1 \
  --kms-response=kms-get-public-key.json
```

The command checks the exact resource name, `RSA_SIGN_PKCS1_2048_SHA256` algorithm, provider CRC32C, RSA-2048 SubjectPublicKeyInfo, and lowercase SHA-256 SPKI fingerprint. Its only output is one public `VerificationRecord` JSON object for review and source pinning. `--kms-response=-` reads the provider response from standard input. The command accepts no token, credential, private-key, write, deployment, or route flag.

## Render the R0 observability plan

Prepare an input document with this exact schema. Cloudflare account and zone IDs are lowercase 32-character hexadecimal IDs. The notification ID is an email address for `email`, or a 32-character integration ID for `pagerduty` or `webhooks`.

```json
{
  "schemaVersion": 1,
  "accountId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "registryScriptName": "five-across-event-registry",
  "zones": {
    "fiveacross.app": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "vacaybingo.com": "cccccccccccccccccccccccccccccccc"
  },
  "logExplorerRetentionDays": 30,
  "monthlyCostLimitUsd": 50,
  "billingProductFilter": "log-explorer",
  "notification": {
    "mechanism": "webhooks",
    "id": "dddddddddddddddddddddddddddddddd"
  }
}
```

```sh
node scripts/event-router-registry/observability-plan.mjs --input=registry-observability-input.json
```

The output renders the desired nonsampled `http_requests` and `firewall_events` ingestion for both Namespace zones, Workers Logs at sampling rate 1, the current provider billing-alert preflight and desired policy, the R0 semantic query/readback definitions, and the reviewed retention gate. Cloudflare does not expose Log Explorer retention selection or native scheduling for arbitrary Workers telemetry queries through the APIs represented here, so the plan blocks on a reviewed account-contract retention readback and names the required scheduled contained telemetry runner rather than claiming those controls were provisioned. Applying requests, wiring the runner, and verifying every exact readback remain separate reviewed operations.

Cloudflare currently requires the exact `Workers Observability Write` permission for both telemetry operations used here: `POST /workers/observability/telemetry/keys` and `POST /workers/observability/telemetry/query`, including a query with `dry: true`. There is no narrower read-only Cloudflare permission for these endpoints. The permission name is therefore broader than the runner's intended behavior and must not be described or provisioned as a read-only token.

The runner must accept only the artifact's fixed key-discovery body and fixed inline `dry: true` query bodies, scoped to the exact account and registry service filter. It must reject saved-query create/update/delete, telemetry-values, live-tail, and every other provider operation. It must not persist query results, mutate provider resources, deploy code, or attach routes. The rendered artifact contains no credential; credential creation and runner enforcement remain separate reviewed operations.
