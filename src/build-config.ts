export type FirebaseDeployBuild = {
  command: string;
  mode: string;
  githubActions?: string;
  apiKey?: string;
  projectId?: string;
};

/**
 * Refuse a local production build with an empty Firebase web config.
 *
 * The target build wrapper always invokes Vite in `production` mode, whether it
 * loads `.env.gaycruisebingo` or `.env.fiveacross`. Keeping this check here
 * protects both deploy paths from the `auth/invalid-api-key` blank-page outage.
 */
export function assertDeployFirebaseApiKey({ command, mode, githubActions, apiKey, projectId }: FirebaseDeployBuild): void {
  if (command !== 'build' || mode !== 'production' || githubActions) return;
  if (apiKey?.trim()) return;

  const envFile = projectId ? `.env.${projectId}` : 'the selected target env file';
  throw new Error(
    'Refusing to build: VITE_FIREBASE_API_KEY is empty, which would publish a ' +
      'blank Firebase config and crash the app on load with `auth/invalid-api-key`. ' +
      `Populate ${envFile} before building or deploying. ` +
      '(These web identifiers are client-safe, not secret.)',
  );
}
