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
  const ready = !!session.db && !session.failed
    && !!session.uid && (viewerUid === undefined || viewerUid === session.uid);
  useEffect(() => {
    if (!ready) return;
    let current = true;
    const urls = new Map<string, string>();
    const reads = (JSON.parse(pathKey) as string[]).map(path =>
      loadProofMediaBlob(path).then(blob => {
        if (!current) return;
        const url = URL.createObjectURL(blob);
        urls.set(path, url);
      }).catch(() => { /* Missing, denied or unavailable: withhold media. */ }));
    // Publish the selected group atomically. Pending winner reads must not
    // briefly become a highlights fallback or an incomplete co-winner award.
    void Promise.all(reads).then(() => { if (current) setResult({ key, urls: new Map(urls) }); });
    return () => {
      current = false;
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, [key, pathKey, ready]);
  return { scope, urls: ready && result?.key === key ? result.urls : new Map<string, string>() };
}
