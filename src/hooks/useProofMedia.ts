import { useEffect, useState } from 'react';
import { EVENT_ID } from '../firebase';
import { loadProofMediaBlob } from '../data/proofMedia';
import { usePrivateFirestore } from './usePrivateFirestore';

/** Object URLs belong to one mounted, account/transport/Event-scoped view. */
export function useProofMediaUrls(paths: readonly (string | null | undefined)[], viewerUid?: string | null) {
  const session = usePrivateFirestore();
  const scope = JSON.stringify([EVENT_ID, session.uid, session.generation, !!session.db, session.recoveryRequired, session.failed, viewerUid]);
  const pathKey = JSON.stringify([...new Set(paths.filter((path): path is string => !!path))]);
  const key = JSON.stringify([scope, pathKey]);
  const [result, setResult] = useState<{ key: string; urls: ReadonlyMap<string, string> }>();
  const ready = !!session.db && !session.recoveryRequired && !session.failed
    && !!session.uid && (viewerUid === undefined || viewerUid === session.uid);
  useEffect(() => {
    if (!ready) return;
    let current = true;
    const urls = new Map<string, string>();
    for (const path of JSON.parse(pathKey) as string[]) {
      void loadProofMediaBlob(path).then(blob => {
        if (!current) return;
        const url = URL.createObjectURL(blob);
        urls.set(path, url);
        setResult({ key, urls: new Map(urls) });
      }).catch(() => { /* Missing, denied or unavailable: withhold media. */ });
    }
    return () => {
      current = false;
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, [key, pathKey, ready]);
  return { scope, urls: ready && result?.key === key ? result.urls : new Map<string, string>() };
}
