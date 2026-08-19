# `router-publisher/` — private registry publisher

This directory is a separate Google Cloud Functions (2nd gen) codebase for the Event-router registry contract in [`specs/event-router-registry.md`](../specs/event-router-registry.md). It registers a raw CloudEvent handler with the Google Functions Framework, decodes only Firestore `written` events for `routerReplicas/{host}`, obtains an exact-audience Google identity token from the metadata server, and asks its dedicated Cloud KMS key version to sign the exact request digest. It deliberately has no `firebase-admin`, `firebase-functions`, Firestore client, Secret Manager, downloaded key, or Cloudflare credential.

The separation is a capability boundary, not packaging style: the main `functions/` dependency graph includes the Admin SDK, while this codebase's complete locked and installed runtime graph cannot contain it. The repository's Firebase configuration does not name this codebase, so ordinary Firebase deployment commands cannot discover or deploy it.

[`deployment.json`](deployment.json) pins the function name, Node runtime, region, retry policy, runtime service account, capacity/time bounds, Firestore event type, database, and exact document path pattern. `npm run deploy:plan -- --trigger-location=<reviewed-database-location>` builds the code and renders the corresponding `gcloud functions deploy` command for review; the script never executes that command. It refuses a missing or malformed location because the Eventarc trigger location must come from provisioning-time Firestore database readback, not an assumed default. Provisioning and deployment remain a separate reviewed operator action.

## Validation

```bash
npm ci --prefix router-publisher
npm run check:no-admin --prefix router-publisher
npm run typecheck:router-publisher
npx vitest run --config vitest.functions.config.ts \
  tests/functions/routerReplicaPublisher.test.ts \
  tests/functions/routerReplicaPublisherRuntime.test.ts
```

The App CI installs, dependency-checks, and builds this codebase independently. Provisioning and deployment require the reviewed publisher service account, exact KMS version, immutable public-key record, audience, publisher epoch, and matching Eventarc trigger location from the registry runbook; building or rendering the plan never provisions or deploys them.
