// Exact required service-agent ceiling for the checked-in Five Across Gen2
// publisher (router-publisher/deployment.json), project number 5297095641.
// Members denote effective getAccessToken/getOpenIdToken authority from ANY
// direct/inherited predefined/custom role, not just a role named Token Creator.
// The trusted source attestor must establish that enumeration's completeness.
// This is an admission ceiling, never an instruction to grant Token Creator.
// Exact agent/role necessity is recorded in specs/event-router-registry.md.
const PUBLISHER_TOKEN_CREATORS = new Set([
  'serviceAccount:service-5297095641@gcp-sa-pubsub.iam.gserviceaccount.com',
  'serviceAccount:service-5297095641@gcp-sa-eventarc.iam.gserviceaccount.com',
  'serviceAccount:service-5297095641@gcf-admin-robot.iam.gserviceaccount.com',
  'serviceAccount:service-5297095641@serverless-robot-prod.iam.gserviceaccount.com',
  'serviceAccount:service-5297095641@gcp-sa-cloudbuild.iam.gserviceaccount.com',
]);

export function isAllowedPublisherReplacementAccount(serviceAccountEmail) {
  return serviceAccountEmail.endsWith('@fiveacross.iam.gserviceaccount.com');
}

export function isAllowedPublisherTokenCreator(serviceAccountEmail, member) {
  return isAllowedPublisherReplacementAccount(serviceAccountEmail) && PUBLISHER_TOKEN_CREATORS.has(member);
}
