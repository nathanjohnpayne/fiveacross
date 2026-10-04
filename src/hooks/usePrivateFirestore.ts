import { useSyncExternalStore } from 'react';
import { privateFirestoreSessions } from '../privateFirestore';

export function usePrivateFirestore() {
  const sessions = privateFirestoreSessions();
  return useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
}
