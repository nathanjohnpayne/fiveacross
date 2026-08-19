export type OgEditionArt = {
  eyebrow: { text: string; markStyle?: string };
  palette: { freeink: string; onglow: string; boardshadow: string };
  board: {
    cellRadius: number;
    pattern: readonly string[];
    barShort: number;
    barLong: number;
    bars: readonly (readonly string[])[];
  };
  stamp?: { text: string };
};

export const OG_EDITION_ART: {
  readonly gcb: OgEditionArt;
  readonly vacay: OgEditionArt & { stamp: { text: string } };
  readonly fiveacross: OgEditionArt;
};
