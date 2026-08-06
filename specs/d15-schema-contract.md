---
spec_id: d15-schema-contract
status: accepted
---

# Phase 1.5 schema & type contract (`d15-schema-contract`)

Owns the shared Phase 1.5 domain type contract in `src/types.ts` and its read-side defaults in `src/data/converters.ts`, so every downstream daily-cards ticket imports these types and converters instead of colliding on the same two HOT files. This implements `plans/daily-cards-spec.md` § "Data model" (the `DayDef` shape, the `EventDoc`/`ItemDoc`/`BoardDoc`/`PlayerDoc`/`TallyDoc`/`ProofDoc`/`DoubtDoc`/`MomentDoc` additions, the two new tutorial `ThemeId`s, the finale `MomentKind`s, and the per-day `DayMetaDoc`), plus the `description` field on `ThemeMeta` from § "Theme reference" and the `pool`/`status` additions from § "Item pools and the approval flow." It is a types-and-converter-defaults ticket only: no rules, no UI, no scheduler logic, and no path/route wiring (the day-scoped Board and day-meta path helpers are added by the consuming tickets #204 and #212). Guarded by `src/data/d15-schema-contract.test.ts` (Vitest unit) and `scripts/ci/check_spec_test_alignment`.

## Contract

- `src/types.ts` — the shared domain contract, extended per the spec's data model:
  - `ThemeId` gains `'welcome-aboard' | 'so-long-farewell'` (the two tutorial-day themes). Their `ThemeMeta` entries and `themes.css` token blocks land in #206; the union reserves the ids here so `DayDef.theme` and day chrome can name them.
  - `DayDef` (new) — `{ index, date, port, portEmoji, theme: ThemeId, pool: 'main' | 'embark' | 'farewell', tutorial, unlockAt }` plus optional `freeText?` (per-day free-space override) and `snapshotItemIds?` (the Day Snapshot the scheduler #202 stamps at `unlockAt`; optional because it is absent until that function runs).
  - `EventDoc` gains `timezone: string`, `days: DayDef[]`, `frozenAt?: number` (finale freeze stamp), and the `settings` additions `photoProofSource?: 'camera_or_library' | 'camera_only'`, `stripPhotoExif?: boolean`, `visionGate?: boolean` — all optional, read defensively at their runtime call sites, with the event-level defaults applied by #211 rather than baked into the type.
  - `ItemDoc` gains `pool: 'main' | 'embark' | 'farewell'` and widens `status` to `'active' | 'hidden' | 'pending' | 'rejected'`, plus optional `approvedBy?`/`approvedAt?`. The type only adds the approval states; it migrates no data (every existing `active` item stays `active`).
  - `BoardDoc` gains `dayIndex: number` — one Board per Player per Day; the field is what lets the dealer look up a Player's earlier Day Cards to exclude repeats.
  - `PlayerDoc` gains `dayStats?: Record<number, { bingoCount, squaresMarked, firstBingoAt }>`; the existing `bingoCount`/`squaresMarked`/`firstBingoAt` stay the Event-wide totals.
  - `TallyDoc` gains `lastMarkedAt?`/`dayIndex?`; `ProofDoc` gains `source?: 'camera' | 'library'`/`dayIndex?`; `DoubtDoc` gains `dayIndex?`; `MomentDoc` gains `dayIndex?`; `MomentKind` gains `'last_call' | 'podium'` (the two finale beats). All the day-scoped fields are optional until their day-aware writers stamp them.
  - `DayMetaDoc` (new) — `{ firstBingo?: { uid, displayName, at } }` for `events/{eventId}/days/{dayIndex}/meta/{dayIndex}` (a `meta` subcollection holding one document whose id IS the encoded dayIndex — a valid document path). No `id` field: the doc id IS the dayIndex, encoded in the path.
  - **Frozen, untouched:** the 5×5 `Cell` contract, `ClaimMode`, `UserDoc`, `ClaimDoc`.
- `src/data/converters.ts` — read-side defaults for a not-yet-migrated doc (daily-cards-spec § "Migration"; the precedent is the existing `bannedUids` default):
  - `itemConverter.fromFirestore` defaults a missing `pool` to `'main'` while still pinning `id` to `snap.id`.
  - `eventConverter.fromFirestore` defaults a missing/malformed `days` to `[]` and a missing/malformed `timezone` to `'Europe/Rome'`, alongside the existing `claimMode`/`bannedUids` handling.
  - `dayMetaConverter` (new) — a passthrough `FirestoreDataConverter<DayMetaDoc>` (no id to pin; the id is the path-encoded dayIndex).
- `src/theme/themes.ts` — `ThemeMeta` gains `description: string`, populated verbatim from daily-cards-spec § "Theme reference" for the eight existing entries. #206 adds the two new entries with their own descriptions and does not re-touch the eight.
- `src/components/ProofFeed.tsx` — `MOMENT_COPY` (the exhaustive `Record<MomentKind, …>`) gains `last_call` and `podium` entries so the Feed keeps compiling and rendering the finale beats; #207 refines the finale presentation.

## Acceptance criteria

- **Given** an `ItemDoc` snapshot written before this ships (no `pool` key), **when** it is read through `itemConverter`, **then** it resolves to `pool: 'main'`. (Test: "defaults a missing pool (legacy Item doc, pre-Phase-1.5) to main".)
- **Given** an `EventDoc` snapshot written before this ships (no `days`/`timezone`), **when** it is read through `eventConverter`, **then** it resolves to `days: []` / `timezone: 'Europe/Rome'` rather than throwing downstream, and a malformed value coerces to the same defaults while a present schedule/zone passes through. (Tests: "defaults a missing days/timezone (legacy Event doc) rather than throwing"; "coerces a malformed days to [] and preserves a present schedule/zone".)
- **Given** the `ThemeMeta` contract, **when** `npm test` runs, **then** every `THEMES` entry has a non-empty `description` and typecheck passes with the two new `ThemeId`s reserved. (Test: "every THEMES entry carries a non-empty description".)
- **Given** the extended type contract, **when** `npm run typecheck` runs, **then** every downstream call site (fixtures, `ProofFeed`'s exhaustive `MomentKind` map) compiles with no removed-field references.

## Test coverage

`src/data/d15-schema-contract.test.ts` (Vitest, pure-logic unit — no Firebase, no emulator): the `itemConverter` pool default and passthrough, the `eventConverter` days/timezone defaults and malformed-value coercion, and the `ThemeMeta.description` presence check across every `THEMES` entry.
