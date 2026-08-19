# `router-publisher/` — private registry publisher

This directory is a separate Firebase Functions codebase for the Event-router registry contract in [`specs/event-router-registry.md`](../specs/event-router-registry.md). It watches only `routerReplicas/{host}`, obtains an exact-audience Google identity token from the metadata server, and asks its dedicated Cloud KMS key version to sign the exact request digest. It deliberately has no `firebase-admin`, Firestore client, Secret Manager, downloaded key, or Cloudflare credential.

The separation is a capability boundary, not packaging style: the main `functions/` dependency graph includes the Admin SDK, while this codebase cannot import it transitively. [`firebase.registry.json`](../firebase.registry.json) is an explicit alternate Firebase configuration, so the repository's ordinary deployment commands do not discover or deploy this publisher.

## Validation

```bash
npm ci --prefix router-publisher
npm run typecheck:router-publisher
npx vitest run --config vitest.functions.config.ts \
  tests/functions/routerReplicaPublisher.test.ts \
  tests/functions/routerReplicaPublisherRuntime.test.ts
```

The App CI installs and builds this codebase independently. Provisioning and deployment require the reviewed publisher service account, exact KMS version, immutable public-key record, audience, and publisher epoch from the registry runbook; building this directory never provisions or deploys them.
