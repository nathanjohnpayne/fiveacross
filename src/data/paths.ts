import { collection, doc } from 'firebase/firestore';
import { db, EVENT_ID } from '../firebase';
import {
  eventConverter,
  itemConverter,
  boardConverter,
  playerConverter,
  userConverter,
  proofConverter,
  claimConverter,
  tallyMarkerConverter,
  momentConverter,
  noticeConverter,
  doubtConverter,
  heartConverter,
  dayMetaConverter,
} from './converters';

// Typed, converter-attached references for reads.
export const eventRef = () => doc(db, 'events', EVENT_ID).withConverter(eventConverter);
export const itemsCol = () =>
  collection(db, 'events', EVENT_ID, 'items').withConverter(itemConverter);
export const boardRef = (uid: string, eventId: string = EVENT_ID) =>
  doc(db, 'events', eventId, 'boards', uid).withConverter(boardConverter);
// A Player's Day Card: the day-scoped Board at
// events/{EVENT_ID}/days/{dayIndex}/boards/{uid} (daily-cards-spec § "Data
// model"; firestore.rules day-scoped board gate, #201). The `{dayIndex}` path
// segment must be the CANONICAL decimal form the rules accept — `String(0)` is
// '0', never a zero-padded '00' alias (the rules reject non-canonical aliases
// that would mint a parallel Day-0 board at a distinct path).
export const dayBoardRef = (dayIndex: number, uid: string, eventId: string = EVENT_ID) =>
  doc(db, 'events', eventId, 'days', String(dayIndex), 'boards', uid).withConverter(
    boardConverter,
  );
// One meta doc per Day (doc id IS the dayIndex): the write-once per-Day First
// to BINGO honor (#212/#264). Same canonical-decimal segment rule as boards.
export const dayMetaRef = (dayIndex: number, eventId: string = EVENT_ID) =>
  doc(db, 'events', eventId, 'days', String(dayIndex), 'meta', String(dayIndex)).withConverter(
    dayMetaConverter,
  );
export const playersCol = () =>
  collection(db, 'events', EVENT_ID, 'players').withConverter(playerConverter);
export const playerRef = (uid: string) =>
  doc(db, 'events', EVENT_ID, 'players', uid).withConverter(playerConverter);
export const userRef = (uid: string) => doc(db, 'users', uid).withConverter(userConverter);
export const proofsCol = () =>
  collection(db, 'events', EVENT_ID, 'proofs').withConverter(proofConverter);
export const proofRef = (id: string) =>
  doc(db, 'events', EVENT_ID, 'proofs', id).withConverter(proofConverter);
export const claimsCol = () =>
  collection(db, 'events', EVENT_ID, 'claims').withConverter(claimConverter);
export const claimRef = (id: string) =>
  doc(db, 'events', EVENT_ID, 'claims', id).withConverter(claimConverter);
// A Prompt's Tally markers: events/{EVENT_ID}/tally/{itemId}/markers/{uid} (ADR
// 0002). The count + tap-to-see-who list read from here; the aggregate parent
// tally/{itemId} doc is public-read but admin/Cloud-Function-maintained (Phase
// 1), so in Phase 0 the count is derived from this subcollection's size.
export const tallyMarkersCol = (itemId: string) =>
  collection(db, 'events', EVENT_ID, 'tally', itemId, 'markers').withConverter(tallyMarkerConverter);
// Feed Moments: events/{EVENT_ID}/moments (ADR 0002) — broadcast BINGO / Blackout
// / First-to-BINGO beats that merge newest-first with Proofs into the one Feed.
// Mirrors the proofs helpers; the write path (src/data/moments.ts) uses raw refs.
export const momentsCol = () =>
  collection(db, 'events', EVENT_ID, 'moments').withConverter(momentConverter);
export const momentRef = (id: string) =>
  doc(db, 'events', EVENT_ID, 'moments', id).withConverter(momentConverter);
// Notices: events/{EVENT_ID}/notices (specs/admin-messages.md) — admin-authored
// broadcasts that merge into the one Feed (pinned first, then newest-first with
// Proofs/Moments). Mirrors the proofs/moments helpers; the write path
// (src/data/notices.ts) uses raw refs.
export const noticesCol = () =>
  collection(db, 'events', EVENT_ID, 'notices').withConverter(noticeConverter);
export const noticeRef = (id: string) =>
  doc(db, 'events', EVENT_ID, 'notices', id).withConverter(noticeConverter);
// Doubts: events/{EVENT_ID}/doubts (ADR 0001) — a Player publicly asking another
// to back up a marked Prompt ("pics or it didn't happen"). Mirrors the proofs/
// moments helpers; the read hook (useDoubts) filters by itemId, and the write
// path (src/data/doubts.ts) uses a raw ref. Satisfaction is DERIVED from Proofs,
// never gated (ADR 0001) — a Doubt never blocks, unmarks, or discounts a Mark.
export const doubtsCol = () =>
  collection(db, 'events', EVENT_ID, 'doubts').withConverter(doubtConverter);
export const doubtRef = (id: string) =>
  doc(db, 'events', EVENT_ID, 'doubts', id).withConverter(doubtConverter);
// Hearts: events/{EVENT_ID}/hearts (specs/feed-hearts.md) — one Player's like
// on a Feed post (Proof or Moment). Flat like doubts/moments, one live stream
// (useAllHearts) feeding every card's count; the write path (src/data/hearts.ts)
// uses the deterministic `${uid}_${kind}_${targetId}` slot id.
export const heartsCol = () =>
  collection(db, 'events', EVENT_ID, 'hearts').withConverter(heartConverter);
export const heartRef = (id: string, eventId: string = EVENT_ID) =>
  doc(db, 'events', eventId, 'hearts', id).withConverter(heartConverter);
