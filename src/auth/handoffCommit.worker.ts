/// <reference lib="webworker" />
import { parseHandoffPageMessage } from './handoffCommitProtocol';
import { createHandoffCommitWorkerController } from './handoffCommitWorker';
import { createFirebaseHandoffCommitWorkerAdapter } from './firebaseHandoffCommitWorkerAdapter';

declare const self: DedicatedWorkerGlobalScope;

const controller = createHandoffCommitWorkerController({
  adapter: createFirebaseHandoffCommitWorkerAdapter(self.indexedDB),
  post: (message) => self.postMessage(message),
});

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = parseHandoffPageMessage(event.data);
  // An unparseable first message has no trustworthy owner to answer. Ignoring
  // it makes the page deadline terminate this Worker without reflecting any
  // attacker-selected fields. Once initialized, malformed sequence messages
  // are handled as protocol failures by the controller itself.
  if (message !== null) void controller.receive(message);
});
