import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { publishRouterReplica } from './publisher';
import { createPublisherRuntimeDeps, replicaPayloadFromEvent } from './runtime';

const PUBLISHER_SERVICE_ACCOUNT =
  'event-router-replica-publisher@fiveacross.iam.gserviceaccount.com';
const REGISTRY_ORIGIN =
  'https://five-across-event-registry.nathanpayne.workers.dev';
const PUBLISHER_EPOCH = '1';
const PUBLISHER_KEY_VERSION =
  'projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/replica-publisher/cryptoKeyVersions/1';

export const publishRouterReplicaDesired = onDocumentWritten(
  {
    document: 'routerReplicas/{host}',
    region: 'us-central1',
    retry: true,
    maxInstances: 10,
    timeoutSeconds: 60,
    serviceAccount: PUBLISHER_SERVICE_ACCOUNT,
  },
  async (event) => {
    const host = event.params.host;
    const data = event.data?.after.data();
    const payload = replicaPayloadFromEvent(host, data);
    await publishRouterReplica(
      payload,
      {
        registryOrigin: REGISTRY_ORIGIN,
        publisherEpoch: PUBLISHER_EPOCH,
        keyVersion: PUBLISHER_KEY_VERSION,
      },
      createPublisherRuntimeDeps(fetch, () => Date.now()),
    );
  },
);
