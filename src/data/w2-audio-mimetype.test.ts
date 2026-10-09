import { describe, it, expect, vi, beforeEach } from 'vitest';

// #295: iOS Safari's MediaRecorder records MP4/AAC, not WebM — the pre-fix
// uploadProofMedia() hardcoded EVERY audio proof's Storage extension/
// Content-Type as `.webm`/`audio/webm`, regardless of what the browser
// actually recorded. `ProofSheet` (src/components/w2-proof-capture.test.tsx)
// covers the RECORDING half — the Blob it hands to uploadProofMedia now
// carries the recorder's real mimeType. This file covers the UPLOAD half:
// uploadProofMedia() must derive the object's extension AND Content-Type
// from that Blob's own `type`, not assume webm. `storage.rules`
// (`okAudio()`, contentType.matches('audio/.*')) is untouched and needs no
// change — only the extension/Content-Type MAPPING here is new; the
// Storage↔Firestore lockstep for the resulting `.m4a` object is proven
// against the emulator by tests/rules/w0-storage-rules.test.ts.

const H = vi.hoisted(() => ({ uploadBytes: vi.fn(), getDownloadURL: vi.fn() }));

vi.mock('../firebase', () => ({ storage: {}, EVENT_ID: 'med-2026' }));
vi.mock('firebase/storage', () => ({
  ref: (_s: unknown, path: string) => ({ path }),
  uploadBytes: H.uploadBytes,
  getDownloadURL: H.getDownloadURL,
  deleteObject: vi.fn(),
}));

import { uploadProofMedia } from './storage';
import { PROOF_MEDIA_CACHE_CONTROL } from './proofMediaCache';

// #1410: every proof upload stamps the no-store Cache-Control; path
// immutability does not make retained sensitive bytes safe after deletion.
// The exact-metadata assertions below carry it alongside the #295 contentType
// mapping. (Avatars keep NO cacheControl — their path is overwritten in place;
// src/components/w1-profile-avatar.test.tsx pins that metadata exactly.)
const CC = PROOF_MEDIA_CACHE_CONTROL;

beforeEach(() => {
  vi.clearAllMocks();
  H.uploadBytes.mockResolvedValue(undefined);
  H.getDownloadURL.mockResolvedValue('https://firebasestorage.example/p');
});

describe('uploadProofMedia — audio extension/Content-Type follow the Blob’s real type (#295)', () => {
  it('a WebM/Opus clip (the common-browser case) uploads as .webm / audio/webm — unchanged default', async () => {
    const blob = new Blob(['clip'], { type: 'audio/webm;codecs=opus' });
    const { path } = await uploadProofMedia('u1', 'P', blob, 'audio');

    expect(path).toBe('proofs/med-2026/u1/P.webm');
    expect(H.uploadBytes).toHaveBeenCalledTimes(1);
    const [ref, uploaded, meta] = H.uploadBytes.mock.calls[0];
    expect((ref as { path: string }).path).toBe('proofs/med-2026/u1/P.webm');
    expect(uploaded).toBe(blob); // audio is never re-encoded (unlike photo)
    expect(meta).toEqual({ contentType: 'audio/webm', cacheControl: CC });
  });

  it('a bare "audio/webm" type (no codecs param) still uploads as .webm / audio/webm', async () => {
    const blob = new Blob(['clip'], { type: 'audio/webm' });
    const { path } = await uploadProofMedia('u1', 'P', blob, 'audio');
    expect(path).toBe('proofs/med-2026/u1/P.webm');
    expect(H.uploadBytes.mock.calls[0][2]).toEqual({ contentType: 'audio/webm', cacheControl: CC });
  });

  it('a Safari-recorded MP4/AAC clip uploads as .m4a / audio/mp4, NOT .webm / audio/webm', async () => {
    const blob = new Blob(['clip'], { type: 'audio/mp4' });
    const { path } = await uploadProofMedia('u1', 'P', blob, 'audio');

    expect(path).toBe('proofs/med-2026/u1/P.m4a');
    const [ref, uploaded, meta] = H.uploadBytes.mock.calls[0];
    expect((ref as { path: string }).path).toBe('proofs/med-2026/u1/P.m4a');
    expect(uploaded).toBe(blob);
    expect(meta).toEqual({ contentType: 'audio/mp4', cacheControl: CC });
  });

  it('an mp4 type WITH a codecs parameter (e.g. "audio/mp4;codecs=mp4a.40.2") still normalizes to audio/mp4 / .m4a', async () => {
    const blob = new Blob(['clip'], { type: 'audio/mp4;codecs=mp4a.40.2' });
    const { path } = await uploadProofMedia('u1', 'P', blob, 'audio');
    expect(path).toBe('proofs/med-2026/u1/P.m4a');
    expect(H.uploadBytes.mock.calls[0][2]).toEqual({ contentType: 'audio/mp4', cacheControl: CC });
  });

  it('a bare "audio/aac" type also maps to .m4a / audio/mp4', async () => {
    const blob = new Blob(['clip'], { type: 'audio/aac' });
    const { path } = await uploadProofMedia('u1', 'P', blob, 'audio');
    expect(path).toBe('proofs/med-2026/u1/P.m4a');
    expect(H.uploadBytes.mock.calls[0][2]).toEqual({ contentType: 'audio/mp4', cacheControl: CC });
  });

  it('an empty/unrecognized Blob type falls back to the pre-#295 .webm / audio/webm default rather than guessing', async () => {
    const blob = new Blob(['clip'], { type: '' });
    const { path } = await uploadProofMedia('u1', 'P', blob, 'audio');
    expect(path).toBe('proofs/med-2026/u1/P.webm');
    expect(H.uploadBytes.mock.calls[0][2]).toEqual({ contentType: 'audio/webm', cacheControl: CC });
  });

  it('returns object identity only and never mints a proof download URL', async () => {
    const result = await uploadProofMedia('u1', 'P', new Blob(['clip'], { type: 'audio/mp4' }), 'audio');
    expect(result).toEqual({ path: 'proofs/med-2026/u1/P.m4a' });
    expect(H.getDownloadURL).not.toHaveBeenCalled();
  });

  it('photo uploads are unaffected — always .jpg / image/jpeg regardless of this audio mapping', async () => {
    // downscaleImage isn't mocked here, so a genuinely undecodable "photo"
    // blob falls back to the raw blob unchanged (its decode-failure path) —
    // stripExif defaults true, so that would throw; disable the strip to
    // isolate the ext/contentType assertion from the EXIF-strip contract
    // (covered separately by src/components/d15-claim-sheet-photo.test.tsx).
    const blob = new Blob(['img'], { type: 'image/jpeg' });
    const { path } = await uploadProofMedia('u1', 'P', blob, 'photo', { stripExif: false });
    expect(path).toBe('proofs/med-2026/u1/P.jpg');
    expect(H.uploadBytes.mock.calls[0][2]).toEqual({ contentType: 'image/jpeg', cacheControl: CC });
  });
});
