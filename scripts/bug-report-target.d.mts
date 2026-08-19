export interface BugReportFirebaseConfig {
  readonly projectId: string;
  readonly storageBucket: string;
}

export function bugReportFirebaseConfig(target: string): Readonly<BugReportFirebaseConfig>;
