import { describe, expect, it } from "vitest";
import { dealBoard, type DealItem } from "./logic";

const FREE = "FREE";

function community(count: number, pool: "main" | "easy" = "main"): DealItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `community-${pool}-${i}`,
    text: `community ${pool} ${i}`,
    spicy: false,
    pool,
    targetDayIndex: 2,
    createdBy: `player-${i}`,
  }));
}

function organisers(count: number, pool: "main" | "easy" = "main"): DealItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `organiser-${pool}-${i}`,
    text: `organiser ${pool} ${i}`,
    spicy: false,
    pool,
  }));
}

function communityCount(
  items: DealItem[],
  seed = 17,
  easyMixRatio = 0,
): number {
  const communityIds = new Set(
    items.filter((item) => item.targetDayIndex != null).map((item) => item.id),
  );
  return dealBoard(items, FREE, seed, 0.4, { easyMixRatio })
    .filter((cell) => !cell.free && cell.itemId != null)
    .filter((cell) => communityIds.has(cell.itemId as string)).length;
}

function dealtIds(
  items: DealItem[],
  seed = 17,
  easyMixRatio = 0,
  excludeIds?: ReadonlySet<string>,
): string[] {
  return dealBoard(items, FREE, seed, 0.4, { easyMixRatio, excludeIds })
    .filter((cell) => !cell.free && cell.itemId != null)
    .map((cell) => cell.itemId as string);
}

describe("Community Squares quota (#558)", () => {
  it("keeps zero-Community deals and the free centre byte-identical to pre-#558", () => {
    // Golden outputs captured from the clean pre-#558 dealer at this branch's
    // HEAD. This pins both legacy selection paths and the full 25-cell shape,
    // rather than comparing two calls that could share the same regression.
    const main: DealItem[] = Array.from({ length: 40 }, (_, index) => ({
      id: `m${index}`,
      text: `main ${index}`,
      spicy: index < 10,
      pool: "main",
    }));
    const easy: DealItem[] = Array.from({ length: 20 }, (_, index) => ({
      id: `e${index}`,
      text: `easy ${index}`,
      spicy: false,
      pool: "easy",
    }));
    const cards = [
      dealBoard([...main, ...easy], FREE, 8_675_309, 0.4, {
        easyMixRatio: 0,
      }),
      dealBoard([...main, ...easy], FREE, 8_675_309, 0.4, {
        easyMixRatio: 0.5,
      }),
    ];

    expect(cards.map((cells) => cells.map((cell) => cell.itemId))).toEqual([
      [
        "m39", "m7", "m24", "m2", "m18", "m20", "m1", "m31", "m3",
        "m27", "m5", "m38", null, "m35", "m8", "m25", "m0", "m28",
        "m11", "m9", "m23", "m4", "m13", "m6", "m32",
      ],
      [
        "m39", "e6", "m7", "e5", "m24", "e7", "m2", "e8", "m18",
        "e1", "m20", "e4", null, "m1", "e14", "m31", "e11", "m3",
        "e2", "m27", "e16", "m5", "e18", "m38", "e3",
      ],
    ]);
    for (const cells of cards) {
      expect(cells[12]).toEqual({
        index: 12,
        itemId: null,
        text: FREE,
        free: true,
        marked: true,
        markedAt: null,
      });
    }
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
  ])(
    "reserves every placeable suggestion through four (%i → %i)",
    (available, expected) => {
      expect(communityCount([...community(available), ...organisers(40)])).toBe(
        expected,
      );
    },
  );

  it("reserves exactly four Community Prompts when organiser supply is adequate", () => {
    const pool = [...community(20), ...organisers(40)];

    expect(communityCount(pool)).toBe(4);
  });

  it("counts Community Prompts inside an exact 12 easy / 12 exploratory mix", () => {
    const easyCommunity = community(8, "easy");
    const mainCommunity = community(8, "main").map((item, index) => ({
      ...item,
      spicy: index < 4,
    }));
    const easyOrganisers = organisers(24, "easy");
    const mainOrganisers = organisers(36, "main").map((item, index) => ({
      ...item,
      spicy: index < 12,
    }));
    const pool = [
      ...easyCommunity,
      ...mainCommunity,
      ...easyOrganisers,
      ...mainOrganisers,
    ];
    const byId = new Map(pool.map((item) => [item.id, item]));

    const dealt = dealBoard(pool, FREE, 41, 0.4, { easyMixRatio: 0.5 }).filter(
      (cell) => !cell.free && cell.itemId != null,
    );
    const dealtItems = dealt.map(
      (cell) => byId.get(cell.itemId as string) as DealItem,
    );

    expect(dealtItems.filter((item) => item.pool === "easy")).toHaveLength(12);
    expect(dealtItems.filter((item) => item.pool === "main")).toHaveLength(12);
    expect(
      dealtItems.filter((item) => item.targetDayIndex != null),
    ).toHaveLength(4);
    expect(
      dealtItems.filter(
        (item) => item.pool === "easy" && item.targetDayIndex != null,
      ),
    ).toHaveLength(2);
    expect(
      dealtItems.filter(
        (item) => item.pool === "main" && item.targetDayIndex != null,
      ),
    ).toHaveLength(2);
    expect(
      dealtItems.filter((item) => item.pool === "main" && item.spicy),
    ).toHaveLength(5);
  });

  it("moves an infeasible proportional share to the classification that can supply it", () => {
    const pool = [
      ...community(8, "easy"),
      ...organisers(24, "easy"),
      ...organisers(40, "main"),
    ];

    expect(communityCount(pool, 29, 0.5)).toBe(4);
  });

  it("caps the reservation at a classification capacity of one", () => {
    const pool = [
      ...community(8, "easy"),
      ...organisers(10, "easy"),
      ...organisers(40, "main"),
    ];

    expect(communityCount(pool, 7, 1 / 24)).toBe(1);
  });

  it("does not move an easy suggestion into an all-exploratory card, or vice versa", () => {
    const allExploratory = [
      ...community(8, "easy"),
      ...organisers(24, "easy"),
      ...organisers(40, "main"),
    ];
    const allEasy = [
      ...community(8, "main"),
      ...organisers(40, "main"),
      ...organisers(40, "easy"),
    ];

    expect(communityCount(allExploratory, 5, 0)).toBe(0);
    expect(communityCount(allEasy, 5, 1)).toBe(0);
  });

  it("uses unselected Community content as final same-classification thin-pool backfill", () => {
    const pool = community(24);
    const ids = dealtIds(pool, 13);

    expect(ids).toHaveLength(24);
    expect(new Set(ids)).toHaveLength(24);
    expect(communityCount(pool, 13)).toBe(24);
  });

  it("honors main-pool exclusion on the Community-aware branch when supply remains ample", () => {
    const pool = [...community(8), ...organisers(40)];
    const excludeIds = new Set([
      "community-main-0",
      "community-main-1",
      "organiser-main-0",
      "organiser-main-1",
    ]);
    const ids = dealtIds(pool, 37, 0, excludeIds);

    expect(ids).toHaveLength(24);
    for (const id of excludeIds) expect(ids).not.toContain(id);
    expect(ids.filter((id) => id.startsWith("community-"))).toHaveLength(4);
  });

  it("resets exclusion on the Community-aware branch when honoring it would leave fewer than 24", () => {
    const pool = [...community(4), ...organisers(24)];
    const excludeIds = new Set(
      Array.from({ length: 5 }, (_, index) => `organiser-main-${index}`),
    );
    const ids = dealtIds(pool, 53, 0, excludeIds);

    expect(ids).toHaveLength(24);
    expect(new Set(ids)).toHaveLength(24);
    expect(ids.filter((id) => id.startsWith("community-"))).toHaveLength(4);
    // Only 23 non-excluded items existed, so a full card proves the reset reused
    // at least one excluded organiser rather than starving or dropping the quota.
    expect(ids.some((id) => excludeIds.has(id))).toBe(true);
  });

  it("uses mixed-pool cross-backfill without blanks or duplicates when Community content exceeds four", () => {
    // Requested 12/12, but only ten exploratory items exist and every one is a
    // Community Prompt. They all fill their own thin classification before two
    // spare Easy organisers cross-fill the remaining exploratory capacity.
    const pool = [...community(10, "main"), ...organisers(20, "easy")];
    const ids = dealtIds(pool, 61, 0.5);

    expect(ids).toHaveLength(24);
    expect(new Set(ids)).toHaveLength(24);
    expect(ids.every(Boolean)).toBe(true);
    expect(ids.filter((id) => id.startsWith("community-"))).toHaveLength(10);
  });

  it("uses the organiser residual to hit the spicy target after a forced spicy reservation", () => {
    const forcedSpicy = community(4).map((item) => ({ ...item, spicy: true }));
    const organiserPool = organisers(30).map((item, index) => ({
      ...item,
      spicy: index < 10,
    }));
    const pool = [...forcedSpicy, ...organiserPool];
    const byId = new Map(pool.map((item) => [item.id, item]));
    const ids = dealtIds(pool, 71);

    expect(ids.filter((id) => id.startsWith("community-"))).toHaveLength(4);
    expect(ids.filter((id) => byId.get(id)?.spicy)).toHaveLength(10);
  });

  it("lets an infeasible forced Community reservation win over the spicy target", () => {
    const forcedSpicy = community(4).map((item) => ({ ...item, spicy: true }));
    const pool = [...forcedSpicy, ...organisers(30)];
    const byId = new Map(pool.map((item) => [item.id, item]));
    const ids = dealBoard(pool, FREE, 73, 0, { easyMixRatio: 0 })
      .filter((cell) => !cell.free && cell.itemId != null)
      .map((cell) => cell.itemId as string);

    expect(ids.filter((id) => id.startsWith("community-"))).toHaveLength(4);
    expect(ids.filter((id) => byId.get(id)?.spicy)).toHaveLength(4);
  });

  it("is reproducible per seed and can choose a different reserved subset on another seed", () => {
    const pool = [...community(20), ...organisers(40)];
    const communityIds = new Set(community(20).map((item) => item.id));
    const selected = (seed: number) =>
      dealtIds(pool, seed)
        .filter((id) => communityIds.has(id))
        .sort();

    expect(selected(101)).toEqual(selected(101));
    expect(selected(101)).not.toEqual(selected(102));
  });

  it("treats absent and malformed targets as legacy organiser content", () => {
    const malformed = Array.from({ length: 20 }, (_, index): DealItem => ({
      id: `legacy-${index}`,
      text: `legacy ${index}`,
      spicy: index < 8,
      pool: "main",
      targetDayIndex: [-1, 1.5, Number.NaN, null][
        index % 4
      ] as unknown as number,
    }));
    const withMalformedTargets = [...malformed, ...organisers(40)];
    const withoutTargets = withMalformedTargets.map(
      ({ targetDayIndex: _target, ...item }) => item,
    );

    expect(dealtIds(withMalformedTargets, 83)).toEqual(
      dealtIds(withoutTargets, 83),
    );
  });

  it("leaves the unstratified tutorial draw order unchanged", () => {
    const legacy = organisers(30, "easy");
    const targeted = legacy.map((item) => ({ ...item, targetDayIndex: 2 }));
    const ids = (pool: DealItem[]) =>
      dealBoard(pool, FREE, 91, 0.4, { stratify: false })
        .filter((cell) => !cell.free)
        .map((cell) => cell.itemId);

    expect(ids(targeted)).toEqual(ids(legacy));
  });
});
