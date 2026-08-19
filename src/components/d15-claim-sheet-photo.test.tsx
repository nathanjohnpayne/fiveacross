import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Covers specs/d15-claim-sheet-photo.md (#211, closes #190) at two layers:
//   1. ProofSheet (RTL-jsdom) — the two-affordance photo body, the camera_only
//      override, the capture attributes, the source stamp, and the heat line.
//   2. uploadProofMedia (unit) — the EXIF/GPS strip re-encode + fail-closed guard.
// The Feed's 🖼️ badge + Day chip are covered in w2-proof-capture-feed.test.tsx;
// attachProof's source/dayIndex stamp + strip pass-through in w2-proof-capture.test.ts.
// The claim sheet's dialog semantics + focus management ride here too, since this
// is the file that renders ProofSheet standalone — see the last describe block.

const H = vi.hoisted(() => ({
  attachProof: vi.fn(),
  uploadBytes: vi.fn(),
  getDownloadURL: vi.fn(),
  // #559: ProofSheet's "Suggested by [player]" attribution (Codex P2, PR
  // #845 round 5) resolves through a ONE-SHOT `fetchDisplayName` read, never
  // a live subscription — mocked here rather than through '../firebase' so
  // each test controls exactly when/whether it resolves.
  fetchDisplayName: vi.fn(),
}));

vi.mock('../data/proofs', () => ({ attachProof: H.attachProof }));
vi.mock('../data/api', () => ({ fetchDisplayName: H.fetchDisplayName }));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../firebase', () => ({ storage: {}, EVENT_ID: 'med-2026' }));
vi.mock('firebase/storage', () => ({
  ref: (_s: unknown, path: string) => ({ path }),
  uploadBytes: H.uploadBytes,
  getDownloadURL: H.getDownloadURL,
  deleteObject: vi.fn(),
}));

import ProofSheet from './ProofSheet';
import { uploadProofMedia } from '../data/storage';
import type { Cell } from '../types';

const cell = (): Cell => ({ index: 0, itemId: 'i0', text: 'Saw a sailor in Speedos', free: false, marked: false, markedAt: null });
const baseProps = () => ({
  uid: 'u1',
  displayName: 'Deck Daddy',
  photoURL: null,
  cells: [cell()],
  cell: cell(),
  claimMode: 'proof_required' as const,
  currentFirstBingoAt: null,
  onClose: vi.fn(),
});
const fileInputs = (c: HTMLElement) => Array.from(c.querySelectorAll('input[type="file"]')) as HTMLInputElement[];

beforeAll(() => {
  (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:mock';
});
beforeEach(() => {
  vi.clearAllMocks();
  H.attachProof.mockResolvedValue(undefined);
  H.fetchDisplayName.mockResolvedValue('Suggester Sam');
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

describe('ProofSheet photo body — two affordances (#190)', () => {
  it('renders BOTH 📷 Take photo and 🖼️ Library by default, in every Claim Mode', async () => {
    const user = userEvent.setup();
    for (const claimMode of ['honor', 'proof_required', 'admin_confirmed'] as const) {
      const { container, unmount } = render(<ProofSheet {...baseProps()} claimMode={claimMode} />);
      await user.click(screen.getByRole('button', { name: /photo/i }));
      expect(screen.getByText(/Take photo/i)).toBeInTheDocument();
      expect(screen.getByText(/Library$/)).toBeInTheDocument();
      // The #190 transparency note (#262) rides exactly with the affordance.
      expect(screen.getByText(/Library picks wear a 🖼️ badge on the Feed/)).toBeInTheDocument();
      // 📷 keeps capture="environment"; 🖼️ has NO capture attribute.
      const [cam, lib] = fileInputs(container);
      expect(cam.getAttribute('capture')).toBe('environment');
      expect(lib.hasAttribute('capture')).toBe(false);
      unmount();
    }
  });

  it('hides 🖼️ Library when photoProofSource is camera_only, regardless of Claim Mode', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ProofSheet {...baseProps()} claimMode="honor" photoProofSource="camera_only" />,
    );
    await user.click(screen.getByRole('button', { name: /photo/i }));
    expect(screen.getByText(/Take photo/i)).toBeInTheDocument();
    expect(screen.queryByText(/Library/i)).toBeNull();
    expect(fileInputs(container)).toHaveLength(1);
  });

  it('stamps source:"library" when the file comes through the 🖼️ Library input', async () => {
    const user = userEvent.setup();
    const { container } = render(<ProofSheet {...baseProps()} dayIndex={2} stripExif />);
    await user.click(screen.getByRole('button', { name: /photo/i }));
    const [, lib] = fileInputs(container);
    await user.upload(lib, new File(['img'], 'p.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: /mark it/i }));

    await waitFor(() => expect(H.attachProof).toHaveBeenCalledTimes(1));
    expect(H.attachProof.mock.calls[0][0]).toMatchObject({ source: 'library', dayIndex: 2, stripExif: true });
  });

  it('stamps source:"camera" when the file comes through the 📷 Take photo input', async () => {
    const user = userEvent.setup();
    const { container } = render(<ProofSheet {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: /photo/i }));
    const [cam] = fileInputs(container);
    await user.upload(cam, new File(['img'], 'p.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: /mark it/i }));

    await waitFor(() => expect(H.attachProof).toHaveBeenCalledTimes(1));
    expect(H.attachProof.mock.calls[0][0].source).toBe('camera');
  });

  it('renders the "🔥 Marked by N others" heat line from tallyCount (and nothing at 0)', () => {
    const { rerender } = render(<ProofSheet {...baseProps()} tallyCount={3} />);
    expect(screen.getByText(/🔥 Marked by 3 others so far/)).toBeInTheDocument();
    rerender(<ProofSheet {...baseProps()} tallyCount={1} />);
    expect(screen.getByText(/🔥 Marked by 1 other so far/)).toBeInTheDocument();
    rerender(<ProofSheet {...baseProps()} tallyCount={0} />);
    expect(screen.queryByText(/Marked by/)).toBeNull();
  });

  it('excludes the viewer from the heat count on an already-marked Square (Codex P3)', () => {
    // A proof-add open (＋ on a Square the viewer already marked): tallyCount
    // includes the viewer's own marker, so "others" is one fewer.
    const marked = { ...cell(), marked: true, markedAt: 1 };
    const { rerender } = render(<ProofSheet {...baseProps()} cell={marked} tallyCount={3} />);
    expect(screen.getByText(/🔥 Marked by 2 others so far/)).toBeInTheDocument();
    // Viewer is the sole marker → no "others" to boast about.
    rerender(<ProofSheet {...baseProps()} cell={marked} tallyCount={1} />);
    expect(screen.queryByText(/Marked by/)).toBeNull();
  });

  it('keeps the photo affordance inputs focusable for keyboard/AT users (Codex P2)', async () => {
    // The `hidden` attribute would drop the input from the tab order AND the a11y
    // tree; the visually-hidden class keeps it operable by keyboard/screen reader.
    const user = userEvent.setup();
    const { container } = render(<ProofSheet {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: /photo/i }));
    for (const input of fileInputs(container)) {
      expect(input.hidden).toBe(false);
      expect(input).toHaveClass('visually-hidden');
    }
  });
});

describe('claim sheet button register (#309 — wireframe parity)', () => {
  // The wireframes' claim-sheet frame (plans/daily-cards-wireframes.html):
  // sentence-case labels in the MARKUP (the CSS `text-transform: none` scope
  // hook is the `.claim-sheet` root class), the mainline/primary actions on
  // the filled `primary` variant (Take photo, Mark it — the wireframe's
  // `.btn.ok`), the alternatives outlined (Library, Cancel), the Photo
  // segment pre-selected, and the pledge on its accent-outline register
  // (never the filled primary).

  it('mounts Photo-first with the .claim-sheet scope hook on the sheet root', () => {
    const { container } = render(<ProofSheet {...baseProps()} />);
    expect(container.querySelector('.sheet.claim-sheet')).not.toBeNull();
    // Photo opens pre-selected (#309/#310 row 16): its segment is `.on` and
    // the photo body's affordances are already on first paint.
    expect(screen.getByRole('button', { name: 'Photo' })).toHaveClass('seg-btn', 'on');
    expect(fileInputs(container)).toHaveLength(2);
  });

  it('renders every label in the wireframe casing — never uppercase markup', () => {
    render(<ProofSheet {...baseProps()} onPledge={vi.fn()} claimMode="honor" />);
    // Exact accessible names — case-sensitive, so an uppercase regression in
    // the markup (the CSS-transform era look) fails here.
    expect(screen.getByRole('button', { name: 'Photo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sound' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Callout' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark it' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '🎖️ Cross My Heart' })).toBeInTheDocument();
    expect(screen.getByText('Take photo')).toBeInTheDocument();
    expect(screen.getByText('Library')).toBeInTheDocument();
  });

  it('fills the primary actions and keeps the alternatives outlined', () => {
    render(<ProofSheet {...baseProps()} onPledge={vi.fn()} claimMode="honor" />);
    // Filled accent primaries (the wireframe's `.btn.ok`): Take photo + Mark it.
    expect(screen.getByText('Take photo')).toHaveClass('btn', 'primary', 'photo-affordance');
    expect(screen.getByRole('button', { name: 'Mark it' })).toHaveClass('btn', 'primary');
    // Outlined alternatives: Library + Cancel carry no `primary`.
    expect(screen.getByText('Library')).toHaveClass('btn');
    expect(screen.getByText('Library')).not.toHaveClass('primary');
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toHaveClass('primary');
    // The pledge is the accent OUTLINE register (.pledge-btn), never the
    // filled primary — it reads as the honor pledge, not a submit.
    const pledge = screen.getByRole('button', { name: '🎖️ Cross My Heart' });
    expect(pledge).toHaveClass('btn', 'pledge-btn');
    expect(pledge).not.toHaveClass('primary');
  });

  it('admin_confirmed keeps the filled primary on the "Submit claim" casing', () => {
    render(<ProofSheet {...baseProps()} claimMode="admin_confirmed" />);
    expect(screen.getByRole('button', { name: 'Submit claim' })).toHaveClass('btn', 'primary');
  });

  it("carries the wireframe's Lucide glyph per button — and none where the wireframe has none", () => {
    // Icon-identity map from the wireframe's claim-sheet frame (lucide-react
    // renders each glyph with a `lucide-<name>` class, the same hook the
    // parity e2e asserts): camera/mic/pen-line on the segments, camera on
    // Take photo, images on Library. Cancel, Mark it, and the pledge carry
    // NO svg — the pledge's 🎖️ lead-in is label text, not an icon.
    render(<ProofSheet {...baseProps()} onPledge={vi.fn()} claimMode="honor" />);
    const glyphs: Array<[string, string]> = [
      ['Photo', 'lucide-camera'],
      ['Sound', 'lucide-mic'],
      ['Callout', 'lucide-pen-line'],
    ];
    for (const [name, glyph] of glyphs) {
      expect(screen.getByRole('button', { name }).querySelector(`svg.${glyph}`)).toBeTruthy();
    }
    expect(screen.getByText('Take photo').querySelector('svg.lucide-camera')).toBeTruthy();
    expect(screen.getByText('Library').querySelector('svg.lucide-images')).toBeTruthy();
    for (const name of ['Cancel', 'Mark it', '🎖️ Cross My Heart']) {
      expect(screen.getByRole('button', { name }).querySelector('svg')).toBeNull();
    }
  });

  it('moves the filled segment state with the selection', async () => {
    const user = userEvent.setup();
    render(<ProofSheet {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'Sound' }));
    expect(screen.getByRole('button', { name: 'Sound' })).toHaveClass('on');
    expect(screen.getByRole('button', { name: 'Photo' })).not.toHaveClass('on');
  });
});

describe('claim sheet dialog semantics + focus management', () => {
  // The claim sheet was the ONE modal sheet in src/components/** without
  // `role="dialog"` / `aria-modal` — screen readers announced it as ordinary
  // page content and nothing scoped focus to it, leaving the whole board
  // tabbable behind a visually-covering backdrop. Same contract every sibling
  // sheet carries (ProfileEditor, AcceptableUse, More, ProofFeed's
  // FeedWhoListSheet, AdminSheet), asserted here at the ProofSheet layer.

  const title = () => screen.getByText(/^Proof for/);

  it('exposes the sheet as a modal dialog named by its "Proof for …" title', () => {
    render(<ProofSheet {...baseProps()} />);
    const dialog = screen.getByRole('dialog', { name: /Proof for/ });
    // The scope hook and the dialog live on the SAME node — the a11y semantics
    // wrap the whole sheet, not an inner slice of it.
    expect(dialog).toHaveClass('sheet', 'claim-sheet');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Named by the existing title element, not a duplicated `aria-label` that
    // could drift from the Prompt text rendered on screen.
    expect(dialog).toHaveAttribute('aria-labelledby', title().id);
  });

  it('moves focus into the dialog on open and restores it to the opener on close', () => {
    // The sheet opens from any of 25 Squares (or their ＋ proof-add buttons), so
    // it captures whatever was focused at mount rather than holding a triggerRef.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(<ProofSheet {...baseProps()} />);
    expect(title()).toHaveFocus();
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);

    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ProofSheet {...baseProps()} onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab and Shift+Tab inside the dialog, skipping the disabled submit', async () => {
    const user = userEvent.setup();
    render(<ProofSheet {...baseProps()} />);

    const close = screen.getByRole('button', { name: 'Close' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    // "Mark it" is the LAST focusable in the sheet and is disabled until a
    // capture lands — the exact case that makes the disabled filter load-bearing
    // rather than defensive. Treated as `last`, the wrap below would never fire
    // and Tab would walk straight out of the dialog.
    expect(screen.getByRole('button', { name: 'Mark it' })).toBeDisabled();

    cancel.focus();
    await user.tab(); // wraps forward past the disabled submit — stays inside
    expect(close).toHaveFocus();

    // The title holds focus but sits outside the focusable set; Shift+Tab from
    // it still wraps to the last ENABLED control.
    title().focus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });

  it('does not yank focus back to the title when the parent re-renders', async () => {
    // Board passes an inline `onClose` and re-renders constantly off its live
    // streams. A focus effect keyed on `onClose` would re-run on every one of
    // those renders and steal focus mid-typing (the #398 trap) — so it reads the
    // callback through a ref and runs exactly once per mount.
    const user = userEvent.setup();
    const { rerender } = render(<ProofSheet {...baseProps()} />);
    await user.click(screen.getByRole('button', { name: 'Callout' }));
    await user.type(screen.getByRole('textbox'), 'saw it myself');

    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveFocus();
    rerender(<ProofSheet {...baseProps()} />); // fresh onClose identity, same sheet
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveValue('saw it myself');
  });
});

describe('uploadProofMedia — EXIF/GPS strip (#211)', () => {
  beforeEach(() => {
    H.uploadBytes.mockResolvedValue(undefined);
    H.getDownloadURL.mockResolvedValue('https://firebasestorage.example/p.jpg');
  });

  // A canvas repaint that yields a fresh, metadata-free JPEG. We return a known
  // blob object so the assertion can prove THAT re-encoded blob — not the raw,
  // geotagged input — is what uploadBytes receives.
  const cleanBlob = new Blob(['clean-jpeg-bytes'], { type: 'image/jpeg' });
  const mockCanvasOk = () => {
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi
      .fn()
      .mockResolvedValue({ width: 100, height: 80 });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
      cb(cleanBlob);
    });
  };

  it('re-encodes the photo so the raw geotagged blob never reaches uploadBytes', async () => {
    mockCanvasOk();
    const raw = new Blob(['\xFF\xE1EXIF-GPS-geotag-payload'], { type: 'image/jpeg' });
    await uploadProofMedia('u1', 'P', raw, 'photo', { stripExif: true });

    expect(H.uploadBytes).toHaveBeenCalledTimes(1);
    const uploaded = H.uploadBytes.mock.calls[0][1] as Blob;
    expect(uploaded).toBe(cleanBlob); // the re-encoded blob…
    expect(uploaded).not.toBe(raw); // …never the geotagged original
  });

  it('fails closed when the strip is required but the photo could not be re-encoded', async () => {
    // Decode failure → downscaleImage falls back to the raw blob (EXIF intact).
    (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn().mockRejectedValue(new Error('nope'));
    const raw = new Blob(['geotagged'], { type: 'image/jpeg' });
    await expect(uploadProofMedia('u1', 'P', raw, 'photo', { stripExif: true })).rejects.toThrow(/strip EXIF/i);
    expect(H.uploadBytes).not.toHaveBeenCalled();
  });
});

// #559, Codex P2, PR #845 round 5: "Suggested by [player]" attribution in
// Prompt detail (ProofSheet is the sheet a Square tap opens) — no component
// test previously rendered a Community Prompt through ProofSheet or asserted
// the async lookup only fires for a matching community cell.
describe('ProofSheet — "Suggested by [player]" attribution (#559)', () => {
  const communityCell = (): Cell => ({
    index: 0,
    itemId: 'i0',
    text: 'Suggested a group activity',
    free: false,
    marked: false,
    markedAt: null,
    communityPrompt: true,
    suggestedBy: 'u-suggester',
  });

  it('resolves and shows "Suggested by [player]" for a community Square', async () => {
    render(<ProofSheet {...baseProps()} cell={communityCell()} cells={[communityCell()]} />);
    expect(await screen.findByText(/Suggested by Suggester Sam/)).toBeInTheDocument();
    expect(H.fetchDisplayName).toHaveBeenCalledWith('u-suggester');
  });

  it('never fetches or shows attribution for an ordinary (non-community) Square', async () => {
    render(<ProofSheet {...baseProps()} />);
    // Give any stray microtask a turn — there is nothing to await on
    // deliberately, since the point is that NOTHING resolves here.
    await Promise.resolve();
    expect(screen.queryByText(/Suggested by/)).not.toBeInTheDocument();
    expect(H.fetchDisplayName).not.toHaveBeenCalled();
  });

  it('never shows attribution for a Square whose communityPrompt flag is absent even if it somehow carries a suggestedBy uid, and never even FETCHES for it (#863)', async () => {
    const malformed: Cell = { ...communityCell(), communityPrompt: undefined };
    render(<ProofSheet {...baseProps()} cell={malformed} cells={[malformed]} />);
    await Promise.resolve();
    expect(screen.queryByText(/Suggested by/)).not.toBeInTheDocument();
    // The lookup is gated on `communityPrompt`, matching this read's
    // documented contract (specs/community-prompt-targeting.md § Attribution:
    // fired "only while the sheet is open on a community Square") — not just
    // the render, so a malformed cell never spends a network read on a name
    // it will never show (#863).
    expect(H.fetchDisplayName).not.toHaveBeenCalled();
  });

  it("clears the PREVIOUS suggester's name immediately when cell.suggestedBy changes to a DIFFERENT uid — never attributes the new Square to the prior player (#863)", async () => {
    const first = communityCell();
    const second: Cell = { ...communityCell(), itemId: 'i1', suggestedBy: 'u-other-suggester' };
    H.fetchDisplayName.mockResolvedValueOnce('Suggester Sam');
    let resolveSecond: (name: string) => void = () => {};
    const secondPromise = new Promise<string>((resolve) => {
      resolveSecond = resolve;
    });

    const { rerender } = render(<ProofSheet {...baseProps()} cell={first} cells={[first]} />);
    expect(await screen.findByText(/Suggested by Suggester Sam/)).toBeInTheDocument();

    H.fetchDisplayName.mockReturnValue(secondPromise);
    rerender(<ProofSheet {...baseProps()} cell={second} cells={[second]} />);
    // Give the effect a turn to run, WITHOUT letting the new (still-pending)
    // fetch resolve yet.
    await Promise.resolve();
    // The FIRST suggester's name must already be gone — not held over until
    // the SECOND fetch resolves, which would attribute the new Square's
    // prompt to the wrong player in the meantime (#863).
    expect(screen.queryByText(/Suggested by Suggester Sam/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Suggested by/)).not.toBeInTheDocument();

    resolveSecond('Suggester Robin');
    expect(await screen.findByText(/Suggested by Suggester Robin/)).toBeInTheDocument();
  });

  it('does not throw when the sheet unmounts before the lookup resolves (a stale in-flight fetch)', async () => {
    let resolveFetch: (name: string) => void = () => {};
    H.fetchDisplayName.mockReturnValue(new Promise<string>((resolve) => { resolveFetch = resolve; }));
    const { unmount } = render(<ProofSheet {...baseProps()} cell={communityCell()} cells={[communityCell()]} />);
    unmount();
    // Resolving AFTER unmount must not throw or warn about a state update on
    // an unmounted component — the effect's cleanup sets a `cancelled` flag.
    expect(() => resolveFetch('Too Late Larry')).not.toThrow();
    await Promise.resolve();
  });
});
