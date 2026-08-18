import { describe, expect, it } from 'vitest';
import { OCCASIONS } from './occasions';
import { promptPoolIssues } from './draftValidation';
import { createEventDraft } from './eventDraft';
import {
  STARTER_PACKS,
  packPromptCount,
  seedPromptsFromPack,
  starterPackById,
  starterPackForOccasion,
  type StarterPack,
} from './starterPacks';

const pack: StarterPack = {
  id: 'coastal',
  label: 'Coastal weekend pack',
  emoji: '🌊',
  prompts: {
    main: [
      { text: 'Walk to a Chimney Rock viewpoint', spicy: false },
      { text: 'Original suspense-movie still', spicy: true },
    ],
    easy: [{ text: 'Windblown group selfie' }],
    closing: [{ text: "Say the thing you'll actually miss" }],
  },
};

describe('the registry', () => {
  // Not a placeholder assertion: it pins the deliberate state the spec
  // records. Content ownership is open (#786 Decision 2), so no pack is
  // authored, and Step 3 must render its honest empty state rather than a
  // seed button with nothing behind it. When a pack IS authored this test is
  // the one that has to change, alongside the occasion's `starterPackId`.
  it('is empty until content ownership is decided, and every occasion agrees', () => {
    expect(STARTER_PACKS).toEqual([]);
    for (const occasion of OCCASIONS) {
      expect(occasion.starterPackId).toBeNull();
      expect(starterPackForOccasion(occasion.id)).toBeNull();
    }
  });

  it('reads an absent, unknown or non-string id as no pack, never as a throw', () => {
    expect(starterPackById(null)).toBeNull();
    expect(starterPackById(undefined)).toBeNull();
    expect(starterPackById('nothing-answers-to-this')).toBeNull();
    expect(starterPackForOccasion(null)).toBeNull();
  });
});

describe('seedPromptsFromPack', () => {
  it('counts the pack as a total for display only', () => {
    expect(packPromptCount(pack)).toBe(4);
  });

  it('produces fresh objects at every level, never a reference into the shared table', () => {
    const seeded = seedPromptsFromPack(pack);
    expect(seeded.main).not.toBe(pack.prompts.main);
    expect(seeded.main[0]).not.toBe(pack.prompts.main[0]);

    // The failure this guards: an inline edit in one draft rewriting the
    // module-level table, and with it every other draft on the device.
    seeded.main[0]!.text = 'edited in a draft';
    seeded.easy[0]!.text = 'edited in a draft';
    expect(pack.prompts.main[0]!.text).toBe('Walk to a Chimney Rock viewpoint');
    expect(pack.prompts.easy[0]!.text).toBe('Windblown group selfie');
    expect(seedPromptsFromPack(pack).main[0]!.text).toBe('Walk to a Chimney Rock viewpoint');
  });

  it('carries main-pool spicy through verbatim', () => {
    const seeded = seedPromptsFromPack(pack);
    expect(seeded.main).toEqual([
      { text: 'Walk to a Chimney Rock viewpoint', spicy: false },
      { text: 'Original suspense-movie still', spicy: true },
    ]);
  });

  it('cannot smuggle a spicy flag into a curated pool, even from an untyped pack', () => {
    // The path a type cannot reach: a future imported or fixture pack whose
    // easy entry carries `spicy`. Rebuilding field by field — rather than
    // spreading — is what stops it reaching an item document, where the 18+
    // derivation would ignore it and serve an explicit Square with no gate.
    const smuggler = {
      ...pack,
      prompts: {
        ...pack.prompts,
        easy: [{ text: 'Explicit inside joke', spicy: true }],
        closing: [{ text: 'Also explicit', spicy: true }],
      },
    } as unknown as StarterPack;
    const seeded = seedPromptsFromPack(smuggler);
    expect(seeded.easy).toEqual([{ text: 'Explicit inside joke' }]);
    expect('spicy' in seeded.easy[0]!).toBe(false);
    expect('spicy' in seeded.closing[0]!).toBe(false);
    expect(promptPoolIssues({ ...createEventDraft(), prompts: seeded })).toEqual([]);
  });

  it('does NOT coerce a non-boolean main spicy — the gate reports it instead', () => {
    // Defaulting it here would decide an Event's 18+ posture silently. The
    // draft carries the pack's own value and `promptPoolIssues` blocks Step 3.
    const untyped = {
      ...pack,
      prompts: { ...pack.prompts, main: [{ text: 'Ambiguous', spicy: 'true' }] },
    } as unknown as StarterPack;
    const seeded = seedPromptsFromPack(untyped);
    expect(seeded.main[0]).toEqual({ text: 'Ambiguous', spicy: 'true' });
    expect(promptPoolIssues({ ...createEventDraft(), prompts: seeded }).map((i) => i.code)).toEqual([
      'main-prompt-spicy-not-boolean',
    ]);
  });
});
