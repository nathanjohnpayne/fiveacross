import {
  cloudEvent,
  type CloudEvent,
} from '@google-cloud/functions-framework';
import { publishRouterReplica } from './publisher';
import {
  createPublisherRuntimeDeps,
  replicaPayloadFromFirestoreEvent,
} from './runtime';

const REGISTRY_ORIGIN =
  'https://five-across-event-registry.nathanpayne.workers.dev';
const PUBLISHER_EPOCH = '1';
const PUBLISHER_KEY_VERSION =
  'projects/fiveacross/locations/us-central1/keyRings/event-router-registry/cryptoKeys/replica-publisher/cryptoKeyVersions/1';

cloudEvent('publishRouterReplicaDesired', async (event: CloudEvent<unknown>) => {
  const payload = replicaPayloadFromFirestoreEvent(event);
  await publishRouterReplica(
    payload,
    {
      registryOrigin: REGISTRY_ORIGIN,
      publisherEpoch: PUBLISHER_EPOCH,
      keyVersion: PUBLISHER_KEY_VERSION,
    },
    createPublisherRuntimeDeps(fetch, () => Date.now()),
  );
});
