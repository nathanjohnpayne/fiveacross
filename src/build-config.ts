export type AppVersionEnv = {
  GITHUB_SHA?: string;
  // Set on Vercel's own Git-integration builds (#665) — never on `vercel
  // deploy` from a laptop, which is how the mirrors are actually published
  // (docs/app/deploy-targets.md § Deploying a mirror passes GITHUB_SHA
  // explicitly via --build-env instead).
  VERCEL_GIT_COMMIT_SHA?: string;
};

/**
 * Resolve the commit `__APP_VERSION__` bakes into the bundle.
 *
 * `resolveGitHead` is injected (rather than shelling out here) so this stays a
 * pure function to unit-test: the CI/target-build case never reaches it
 * because GITHUB_SHA is already set, and the local-dev case that does reach
 * it depends on the checkout's actual git state, which a unit test should not
 * have to fake.
 */
export function resolveAppVersion(env: AppVersionEnv, resolveGitHead: () => string): string {
  if (env.GITHUB_SHA) return env.GITHUB_SHA.slice(0, 40);
  if (env.VERCEL_GIT_COMMIT_SHA) return env.VERCEL_GIT_COMMIT_SHA.slice(0, 40);
  try {
    return resolveGitHead().trim();
  } catch {
    return 'unknown';
  }
}

export type FirebaseDeployBuild = {
  command: string;
  mode: string;
  githubActions?: string;
  targetBuild?: boolean;
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
export function assertDeployFirebaseApiKey({
  command,
  mode,
  githubActions,
  targetBuild,
  apiKey,
  projectId,
}: FirebaseDeployBuild): void {
  // GitHub's generic compile-only build intentionally has no Firebase config.
  // A named target build does, however, publish deploy-shaped output, so it
  // must fail closed on an empty web key even when started by Actions.
  if (command !== 'build' || mode !== 'production' || (githubActions && !targetBuild)) return;
  if (apiKey?.trim()) return;

  const envFile = targetBuild
    ? projectId ? `.env.${projectId}` : 'the selected target env file'
    : '.env.local';
  throw new Error(
    'Refusing to build: VITE_FIREBASE_API_KEY is empty, which would publish a ' +
      'blank Firebase config and crash the app on load with `auth/invalid-api-key`. ' +
      `Populate ${envFile} before building or deploying. ` +
      '(These web identifiers are client-safe, not secret.)',
  );
}
