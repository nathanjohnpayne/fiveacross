// Exact transport exception for the checked-in Five Across Gen2 Firestore
// publisher (router-publisher/deployment.json), project number 5297095641.
// This is an admission ceiling, never an instruction to grant Token Creator.
// Other projects/agents require separately verified contract evidence (#1427).
const PUBSUB_TOKEN_CREATOR = 'serviceAccount:service-5297095641@gcp-sa-pubsub.iam.gserviceaccount.com';

export function isAllowedPublisherTokenCreator(serviceAccountEmail, member) {
  return serviceAccountEmail.endsWith('@fiveacross.iam.gserviceaccount.com') && member === PUBSUB_TOKEN_CREATOR;
}
