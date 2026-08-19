/**
 * Starter packs — the Prompt content Step 3 seeds in one tap (#791,
 * specs/event-setup-wizard.md § "Squares").
 *
 * THE REGISTRY IS EMPTY, AND THAT IS THE CONTRACT, NOT AN OVERSIGHT. Every
 * `OccasionDef.starterPackId` is `null` (`src/data/occasions.ts`, and the spec
 * § "The occasion matrix" states why): content ownership is open (#786
 * Decision 2), and the one pack the frames name — "🌊 Coastal weekend pack",
 * 86 squares — does not exist in this repo. Inventing prompts here to make the
 * button light up would be authoring product content under a UI ticket, and
 * would bind whichever voice this file happened to use to every self-served
 * Event. What ships instead is the whole SEAM: resolution, the deep copy, and
 * the counts — so that "when a pack is authored, flipping its `starterPackId`
 * from `null` is the whole change" (spec) is literally true rather than
 * aspirational.
 *
 * Notably NOT reused as a pack: `SEED_ITEMS` / `EASY_ITEMS` / `CLOSING_ITEMS`
 * in `src/data/seed.ts`. That is Gay Cruise Bingo's own adults-only cruise
 * voice ("Complain about circuit music"), and handing it to a wedding or a
 * conference is the same wrong-by-default move #785 rejects when it binds the
 * Cruise occasion to `vacay` rather than `gcb`.
 *
 * `StarterPack` is deliberately declared HERE rather than in
 * `src/domainTypes.d.ts` alongside `OccasionDef`. The domain contract is the
 * shape the Cloud Functions project and the launch provisioner (#793) also
 * consume, and neither ever sees a pack: seeding copies prompts INTO the
 * draft, and the provisioner reads the draft. A pack is this module's private
 * table, so it stays out of the shared contract.
 */

import type { DraftCuratedPrompt, DraftMainPrompt, DraftPromptPools, OccasionId } from '../types';
import { occasionById } from './occasions';

/** One seedable pack. `prompts` is `readonly` at every level because the table
 *  is module-level shared state — see `seedPromptsFromPack`. */
export interface StarterPack {
  id: string;
  /** Row label, as the pack row renders it. */
  label: string;
  emoji: string;
  prompts: {
    readonly main: readonly DraftMainPrompt[];
    readonly easy: readonly DraftCuratedPrompt[];
    readonly closing: readonly DraftCuratedPrompt[];
  };
}

/** Every authored pack. Empty until content ownership is decided (#786
 *  Decision 2) — see the module note above. */
export const STARTER_PACKS: readonly StarterPack[] = [];

export function starterPackById(id: string | null | undefined): StarterPack | null {
  if (typeof id !== 'string') return null;
  return STARTER_PACKS.find((pack) => pack.id === id) ?? null;
}

/**
 * The pack an occasion proposes, or `null`.
 *
 * Two distinct `null`s collapse here on purpose: the occasion binds no pack,
 * and the occasion binds a pack id nothing answers to. Both mean the same
 * thing to the caller — there is nothing to seed — and neither is repairable
 * from the wizard, so the step renders one honest empty state rather than two.
 */
export function starterPackForOccasion(occasion: OccasionId | null | undefined): StarterPack | null {
  return starterPackById(occasionById(occasion)?.starterPackId);
}

/** How many Prompts a pack holds in total. Display only — the LAUNCH GATE is
 *  per assigned pool and never a total (#785); see `poolCounts`. */
export function packPromptCount(pack: StarterPack): number {
  return pack.prompts.main.length + pack.prompts.easy.length + pack.prompts.closing.length;
}

/**
 * A draft's own `prompts` block, copied out of a pack.
 *
 * FRESH OBJECTS AT EVERY LEVEL, never a reference into `STARTER_PACKS`. The
 * table is a module-level constant shared by every draft on the device, so
 * aliasing its arrays would make an inline text edit in one draft rewrite the
 * pack itself — and with it every other draft seeded from it, plus every
 * future seed for the lifetime of the tab. Same posture `applyOccasionDefaults`
 * takes with the shared `settings` block.
 *
 * Each entry is rebuilt FIELD BY FIELD rather than spread. A pack that reached
 * memory through an untyped path (a future import, a fixture) can carry keys
 * the draft contract has no home for, and a spread would smuggle them into the
 * item documents the provisioner writes. In particular a curated entry gets
 * `{ text }` and nothing else, so a stray `spicy` on an easy- or closing-pool
 * Prompt cannot survive seeding — that flag is main-pool only, and one that
 * reached a card would be silently dropped by the 18+ derivation (#785).
 *
 * What this does NOT do is COERCE. A main-pool entry's `spicy` is copied
 * exactly as the pack states it, including a non-boolean: defaulting it would
 * decide an Event's 18+ posture on the organizer's behalf, silently. That is
 * `promptPoolIssues`' report to make (`main-prompt-spicy-not-boolean`), and it
 * blocks this very step.
 */
export function seedPromptsFromPack(pack: StarterPack): DraftPromptPools {
  return {
    main: pack.prompts.main.map((prompt) => ({ text: prompt.text, spicy: prompt.spicy })),
    easy: pack.prompts.easy.map((prompt) => ({ text: prompt.text })),
    closing: pack.prompts.closing.map((prompt) => ({ text: prompt.text })),
  };
}
