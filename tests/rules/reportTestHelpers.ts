import { doc, getDoc, increment, serverTimestamp, writeBatch, type Firestore } from 'firebase/firestore';

/** Exercise the real paired boundary in membership/freeze fixtures. */
export async function submitReportForTest(fs: Firestore, eventId: string, uid: string, kind: string, id: string): Promise<void> {
  const prefix = `events/${eventId}`;
  const target = doc(fs, `${prefix}/${kind}/${id}`);
  const snap = await getDoc(target);
  const rate = doc(fs, `${prefix}/reportRateLimits/${uid}`);
  const priorRate = await getDoc(rate);
  const previousMs = priorRate.exists() ? priorRate.data().submittedAt.toMillis() as number : 0;
  // The report admission cadence itself has a dedicated no-sleep adversarial
  // suite. These broad inventories preserve their original allow/deny purpose.
  const wait = previousMs + 3_050 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const batch = writeBatch(fs);
  batch.update(target, { reportCount: increment(1) });
  batch.set(doc(fs, `${prefix}/${kind}/${id}/reports/${uid}`), { uid, targetCreatedAt: snap.data()?.createdAt, submittedAt: serverTimestamp() });
  batch.set(rate, { kind, targetId: id, submittedAt: serverTimestamp() });
  await batch.commit();
}
