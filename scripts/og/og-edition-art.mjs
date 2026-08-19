// Renderer-owned art direction that the generated OG images and annotated
// wireframes must share. Keep brand copy in src/editions.ts; this module owns
// only composition/style data that has no app consumer (#697, #884).
export const OG_EDITION_ART = {
  gcb: {
    eyebrow: { text: 'ONE SAILING AT A TIME' },
    palette: {
      freeink: '#1a1206',
      onglow: 'rgba(255,45,149,0.30)',
      onGradient: 'linear-gradient(145deg,#ff2d95,#00e6ff)',
      boardshadow: '0 0 70px rgba(255,45,149,0.10)',
    },
    descriptionWrapAfterWords: 3,
    board: {
      size: 399,
      pad: 15,
      gap: 9,
      cellRadius: 13,
      pattern: ['x..x.', '.x..x', 'xxFxx', '.x...', 'x..x.'],
      barShort: 69,
      barLong: 100,
      barInset: 13,
      bars: [
        ['ls', 'sl', 'ls', 'ss', 'll'],
        ['sl', 'ls', 'ss', 'll', 'sl'],
        ['ls', 'sl', '..', 'll', 'ss'],
        ['ll', 'ss', 'ls', 'sl', 'ls'],
        ['sl', 'ls', 'ss', 'll', 'sl'],
      ],
    },
  },
  vacay: {
    eyebrow: { text: 'ONE TRIP AT A TIME' },
    palette: {
      freeink: '#1b1005',
      onglow: 'rgba(46,127,168,0.20)',
      onGradient: 'linear-gradient(150deg,#2e7fa8,#8fd0c3)',
      boardshadow: '0 22px 48px rgba(0,0,0,0.45)',
    },
    board: {
      size: 350,
      pad: 15,
      gap: 10,
      cellRadius: 12,
      pattern: ['.x..x', 'x..x.', 'xxFxx', '..x..', 'x...x'],
      barShort: 69,
      barLong: 100,
      barInset: 13,
      bars: [
        ['sl', 'll', 'ls', 'ss', 'ls'],
        ['ll', 'sl', 'ss', 'ls', 'sl'],
        ['ls', 'ss', '..', 'sl', 'll'],
        ['ss', 'ls', 'll', 'sl', 'ls'],
        ['sl', 'll', 'ls', 'ss', 'ls'],
      ],
    },
    stamp: { text: 'TAKE THE DETOUR' },
  },
  fiveacross: {
    eyebrow: { text: 'THE PLATFORM', markStyle: 'glyph' },
    palette: {
      freeink: '#171410',
      onglow: 'transparent',
      onGradient: 'linear-gradient(145deg,#3f66f0,#2c4bd8)',
      boardshadow: 'none',
    },
    board: {
      size: 412,
      pad: 16,
      gap: 10,
      cellRadius: 10,
      pattern: ['.....', '.....', 'xxFxx', '.....', '.....'],
      barShort: 62,
      barLong: 78,
      barInset: 13,
      bars: [
        ['ls', 'sl', 'ls', 'sl', 'ls'],
        ['sl', 'ls', 'sl', 'ls', 'sl'],
        ['ll', 'll', '..', 'll', 'll'],
        ['ls', 'sl', 'ls', 'sl', 'ls'],
        ['sl', 'ls', 'sl', 'ls', 'sl'],
      ],
    },
  },
};
