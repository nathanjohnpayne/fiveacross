import { configForTarget } from './build-target.mjs';

/** Selects the immutable server-side scope for bug-report operator commands. */
export function bugReportFirebaseConfig(target) {
  const targetConfig = configForTarget(target);
  return Object.freeze({
    projectId: targetConfig.firebaseProject,
    storageBucket: targetConfig.identity.VITE_FIREBASE_STORAGE_BUCKET,
  });
}
