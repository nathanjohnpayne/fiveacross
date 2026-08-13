import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserDoc } from '../types';
import Avatar from './Avatar';
// Real implementations of the modules under test — covers specs/w1-profile-avatar.md.
import { MAX_DISPLAY_NAME, updateAvatar, updateDisplayName } from '../data/profile';
import ProfileEditor from './ProfileEditor';

const { docMock, setDocMock, updateDocMock } = vi.hoisted(() => ({
  docMock: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
  setDocMock: vi.fn(async () => undefined),
  // Mirrors real Firestore: updateDoc rejects when the target document doesn't
  // exist — the exact failure data/profile.ts now avoids by writing via a merge
  // setDoc instead. Kept mocked (rather than removed) so a regression back to
  // updateDoc fails this suite loudly instead of silently.
  updateDocMock: vi.fn<() => Promise<void>>(async () => {
    throw Object.assign(new Error('No document to update'), { code: 'not-found' });
  }),
}));
vi.mock('firebase/firestore', () => ({ doc: docMock, setDoc: setDocMock, updateDoc: updateDocMock }));

const { refMock, uploadBytesMock } = vi.hoisted(() => ({
  refMock: vi.fn((_storage: unknown, path: string) => ({ path })),
  uploadBytesMock: vi.fn(async () => ({})),
}));
vi.mock('firebase/storage', () => ({
  ref: refMock,
  uploadBytes: uploadBytesMock,
  getDownloadURL: async (r: { path: string }) => `https://cdn.example/${r.path}`,
  deleteObject: vi.fn(),
}));

vi.mock('../firebase', () => ({ db: {}, storage: {}, EVENT_ID: 'test-event' }));

type AuthUser = { uid: string; displayName: string | null; photoURL: string | null } | null;
const authState = vi.hoisted(() => ({ current: { user: null as AuthUser, loading: false } }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => authState.current }));

// Faithful stand-in for useData.ts's useDocSub-backed useMyUser: state lives
// per hook INSTANCE and only re-latches inside an effect keyed on the uid —
// the exact timing Codex round-2 finding 3542224113 exploits (a persistent
// instance hands the first render after a new sign-in the PREVIOUS
// subscription's settled loading:false). Tests control snapshot delivery per
// uid: `defer`red uids hold their first snapshot until release(); push()
// emulates a live onSnapshot update to the active subscriber; renderLog
// records every {uid, loading} pair the hook hands a render, so a test can
// pin that no render for a freshly signed-in uid ever saw a stale flag.
const profileSub = vi.hoisted(() => ({
  docs: new Map<string, UserDoc | null>(),
  defer: new Set<string>(),
  cacheOnly: new Set<string>(),
  held: new Map<string, () => void>(),
  listeners: new Map<string, (s: { data: UserDoc | null; loading: boolean; hasServerData: boolean }) => void>(),
  renderLog: [] as Array<{ uid: string | undefined; loading: boolean }>,
  reset() {
    this.docs.clear();
    this.defer.clear();
    this.cacheOnly.clear();
    this.held.clear();
    this.listeners.clear();
    this.renderLog = [];
  },
  release(uid: string) {
    const deliver = this.held.get(uid);
    this.held.delete(uid);
    deliver?.();
  },
  push(uid: string, doc: UserDoc | null, hasServerData = true) {
    this.docs.set(uid, doc);
    this.listeners.get(uid)?.({ data: doc, loading: false, hasServerData });
  },
}));
vi.mock('../hooks/useData', async () => {
  const { useState, useEffect } = await import('react');
  return {
    useMyUser: (uid: string | undefined) => {
      // Mirrors useDocSub: per-instance state, initial loading:true, reset +
      // subscribe inside an effect keyed on the uid, loading:false only once
      // this uid's snapshot arrives (immediately, unless the test defers it).
      const [state, setState] = useState<{ data: UserDoc | null; loading: boolean; hasServerData: boolean }>({
        data: null,
        loading: true,
        hasServerData: false,
      });
      useEffect(() => {
        if (!uid) {
          setState({ data: null, loading: false, hasServerData: false });
          return;
        }
        setState({ data: null, loading: true, hasServerData: false });
        profileSub.listeners.set(uid, setState);
        const deliver = () =>
          setState({
            data: profileSub.docs.get(uid) ?? null,
            loading: false,
            hasServerData: !profileSub.cacheOnly.has(uid),
          });
        if (profileSub.defer.has(uid)) profileSub.held.set(uid, deliver);
        else deliver();
        return () => {
          if (profileSub.listeners.get(uid) === setState) profileSub.listeners.delete(uid);
        };
      }, [uid]);
      profileSub.renderLog.push({ uid, loading: state.loading });
      return state;
    },
  };
});

function resetMocks() {
  docMock.mockClear();
  setDocMock.mockClear();
  updateDocMock.mockClear();
  refMock.mockClear();
  uploadBytesMock.mockClear();
}

describe('Avatar prefers a custom photo over src', () => {
  it('prefers customPhoto, falls back to src, then to an initial', () => {
    const google = 'https://google/x.jpg';
    const custom = 'https://cdn.example/custom.jpg';
    const { rerender } = render(<Avatar name="Alex" src={google} customPhoto={custom} />);
    expect(screen.getByRole('img')).toHaveAttribute('src', custom);
    rerender(<Avatar name="Alex" src={google} customPhoto={null} />);
    expect(screen.getByRole('img')).toHaveAttribute('src', google);
    rerender(<Avatar name="Alex" src={null} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });
});

describe('data/profile.ts — persists to users/{uid}, reusing storage.ts', () => {
  beforeEach(resetMocks);

  it('trims and persists the display name, caps it at 40 characters, and no-ops on blank', async () => {
    await updateDisplayName('u1', '  New Name  ');
    expect(setDocMock).toHaveBeenCalledWith({ path: 'users/u1' }, { displayName: 'New Name' }, { merge: true });
    expect(updateDocMock).toHaveBeenCalledWith(
      { path: 'events/test-event/players/u1' },
      { displayName: 'New Name' },
    );

    updateDocMock.mockClear();
    setDocMock.mockClear();
    await updateDisplayName('u1', `  ${'a'.repeat(MAX_DISPLAY_NAME + 10)}  `);
    expect(setDocMock).toHaveBeenCalledWith(
      { path: 'users/u1' },
      { displayName: 'a'.repeat(MAX_DISPLAY_NAME) },
      { merge: true },
    );
    expect(updateDocMock).toHaveBeenCalledWith(
      { path: 'events/test-event/players/u1' },
      { displayName: 'a'.repeat(MAX_DISPLAY_NAME) },
    );

    updateDocMock.mockClear();
    setDocMock.mockClear();
    await updateDisplayName('u1', '   ');
    expect(setDocMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  // Covers the fix for the Codex P2 finding on profile.ts:15 — updateDoc fails
  // when users/{uid} doesn't exist, which can happen because ensureUserProfile's
  // create (data/api.ts) has its failure swallowed on the auth side
  // (auth/AuthContext.tsx). The mocked updateDoc above rejects exactly like real
  // Firestore does for a missing document, so this test both proves the save
  // succeeds today and would fail loudly if a regression reintroduced updateDoc.
  it('creates users/{uid} via a merge write when the profile doc is missing (ensureUserProfile create failed)', async () => {
    await expect(updateDisplayName('u1', 'New Name')).resolves.toBeUndefined();
    expect(setDocMock).toHaveBeenCalledWith({ path: 'users/u1' }, { displayName: 'New Name' }, { merge: true });
    expect(updateDocMock).toHaveBeenCalledWith(
      { path: 'events/test-event/players/u1' },
      { displayName: 'New Name' },
    );
  });

  it('refreshes an existing public Player row when the saved profile changes', async () => {
    updateDocMock.mockResolvedValueOnce(undefined);

    await updateDisplayName('u1', 'New Name');

    expect(updateDocMock).toHaveBeenCalledWith(
      { path: 'events/test-event/players/u1' },
      { displayName: 'New Name' },
    );
  });

  it('reuses uploadAvatar (avatars/{uid}.jpg, image/jpeg) then flips customPhoto + photoURL', async () => {
    const url = await updateAvatar('u1', new Blob(['x'], { type: 'image/png' }));
    expect(refMock).toHaveBeenCalledWith({}, 'avatars/u1.jpg');
    expect(uploadBytesMock).toHaveBeenCalledWith({ path: 'avatars/u1.jpg' }, expect.any(Blob), { contentType: 'image/jpeg' });
    expect(setDocMock).toHaveBeenCalledWith({ path: 'users/u1' }, { photoURL: url, customPhoto: true }, { merge: true });
    expect(updateDocMock).toHaveBeenCalledWith(
      { path: 'events/test-event/players/u1' },
      { photoURL: url },
    );
    expect(url).toBe('https://cdn.example/avatars/u1.jpg');
  });
});

describe('ProfileEditor', () => {
  const googlePhoto = 'https://google/photo.jpg';
  const customUrl = 'https://cdn.example/avatars/u1.jpg';

  beforeEach(() => {
    resetMocks();
    profileSub.reset();
    authState.current = { user: { uid: 'u1', displayName: 'Google Name', photoURL: googlePhoto }, loading: false };
    profileSub.docs.set('u1', { displayName: 'Alex', photoURL: null, customPhoto: false, createdAt: 0 });
  });

  it('renders nothing while signed out', () => {
    authState.current = { user: null, loading: false };
    expect(render(<ProfileEditor />).container).toBeEmptyDOMElement();
  });

  it('opens pre-filled with the live display name and saves an edit to users/{uid}', async () => {
    const user = userEvent.setup();
    render(<ProfileEditor />);
    await user.click(screen.getByRole('button', { name: 'Edit profile' }));

    const nameInput = screen.getByLabelText('Display name');
    expect(nameInput).toHaveValue('Alex');
    await user.clear(nameInput);
    await user.type(nameInput, 'New Name');
    await user.click(screen.getByRole('button', { name: 'Save name' }));

    // saveName is async (awaits updateDisplayName before closing) — wait for it.
    await waitFor(() =>
      expect(setDocMock).toHaveBeenCalledWith({ path: 'users/u1' }, { displayName: 'New Name' }, { merge: true }),
    );
    await waitFor(() => expect(screen.queryByText('Edit profile')).not.toBeInTheDocument());
  });

  // Codex P2 finding on ProfileEditor.tsx:32 (round 1) — the editor used to
  // gate only on auth loading, so it could open (and, on an immediate Save,
  // persist) the Google-name fallback while the live users/{uid} subscription
  // was still in flight, clobbering a saved custom displayName. The avatar
  // trigger now renders immediately (it IS the header photo) but stays DISABLED
  // until that snapshot lands, so it still cannot open — and therefore cannot
  // seed — the stale name. Simulates the delay: auth resolves first, the profile
  // snapshot is deferred and resolves later with a name that differs from the
  // Google name, and proves the saved name always wins.
  it('keeps the avatar trigger disabled until the live profile snapshot lands, so a delayed load never clobbers a saved name', async () => {
    const user = userEvent.setup();
    profileSub.defer.add('u1'); // profile subscription still in flight
    profileSub.docs.set('u1', { displayName: 'Saved Custom Name', photoURL: null, customPhoto: false, createdAt: 0 });
    render(<ProfileEditor />);
    // Present for layout (it's the header avatar) but not actionable yet, so the
    // editor cannot be opened or seeded from the still-loading fallback name.
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeDisabled();
    expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();

    // The live users/{uid} snapshot arrives with a saved name that differs
    // from the Google name.
    act(() => profileSub.release('u1'));

    const trigger = screen.getByRole('button', { name: 'Edit profile' });
    expect(trigger).toBeEnabled();
    await user.click(trigger);
    expect(screen.getByLabelText('Display name')).toHaveValue('Saved Custom Name');

    await user.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() =>
      expect(setDocMock).toHaveBeenCalledWith(
        { path: 'users/u1' },
        { displayName: 'Saved Custom Name' },
        { merge: true },
      ),
    );
    // Never persisted the stale Google-name fallback while the profile was loading.
    expect(setDocMock).not.toHaveBeenCalledWith(
      { path: 'users/u1' },
      { displayName: 'Google Name' },
      { merge: true },
    );
  });

  it('keeps the avatar trigger disabled until a server-confirmed profile snapshot lands', async () => {
    const serverDoc = { displayName: 'Server Saved', photoURL: null, customPhoto: false, createdAt: 0 };
    profileSub.cacheOnly.add('u1');
    profileSub.docs.set('u1', { displayName: 'Cached Google Name', photoURL: null, customPhoto: false, createdAt: 0 });

    render(<ProfileEditor />);
    // A cache-only snapshot (no server confirmation yet) leaves it disabled.
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeDisabled();
    expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();

    act(() => profileSub.push('u1', serverDoc, true));

    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit profile' }));
    expect(screen.getByLabelText('Display name')).toHaveValue('Server Saved');
  });

  // Codex P2 finding 3542224104 (round 2, ProfileEditor.tsx:25) — the
  // component stayed mounted across auth transitions and only returned null,
  // so `open`/`name` survived: a sheet account A left open (with a half-typed
  // name) could reappear once account B's profile loaded, and Save would
  // write A's text to B's users/{uid}. The editor is now keyed by uid, so the
  // transition unmounts it and every piece of sheet state resets.
  it('closes and resets the editor across an auth transition — account B never sees or saves account A state', async () => {
    const user = userEvent.setup();
    profileSub.docs.set('u2', { displayName: 'Bee Saved', photoURL: null, customPhoto: false, createdAt: 0 });
    const { container, rerender } = render(<ProfileEditor />);

    // Account A opens the sheet and dirties the name field…
    await user.click(screen.getByRole('button', { name: 'Edit profile' }));
    const nameInput = screen.getByLabelText('Display name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Half-typed A name');

    // …signs out with the sheet still open…
    authState.current = { user: null, loading: false };
    rerender(<ProfileEditor />);
    expect(container).toBeEmptyDOMElement();

    // …and a different account signs in.
    authState.current = { user: { uid: 'u2', displayName: 'Bee Google', photoURL: null }, loading: false };
    rerender(<ProfileEditor />);

    // The sheet did not survive the transition (trigger only, no open form)…
    expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();

    // …and reopening seeds from B's saved profile — never A's leftovers.
    await user.click(screen.getByRole('button', { name: 'Edit profile' }));
    expect(screen.getByLabelText('Display name')).toHaveValue('Bee Saved');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() =>
      expect(setDocMock).toHaveBeenCalledWith({ path: 'users/u2' }, { displayName: 'Bee Saved' }, { merge: true }),
    );
    expect(setDocMock).not.toHaveBeenCalledWith(
      { path: 'users/u2' },
      { displayName: 'Half-typed A name' },
      { merge: true },
    );
    expect(setDocMock).not.toHaveBeenCalledWith({ path: 'users/u2' }, { displayName: 'Alex' }, { merge: true });
  });

  // Codex P2 finding 3542224113 (round 2, ProfileEditor.tsx:36) — after a
  // signed-out render, useMyUser(undefined) had already settled its
  // subscription state to loading:false; a persistent hook instance hands
  // that stale false to the FIRST render after a new sign-in (its re-latch
  // lives in an effect), sailing past the round-1 gate for one frame — long
  // enough to show the trigger and seed/save the Google name before the new
  // users/{uid} snapshot resolves. The editor (and with it the hook instance)
  // is now keyed by uid, so the first render for a new uid always starts
  // loading:true. The renderLog assertion is the load-bearing regression
  // check: act() flushes the stale frame away before the DOM can be queried,
  // but the log records exactly what each render was handed.
  it("after a signed-out render, waits for the NEW uid's snapshot — a stale settled loading flag can't leak the Google name", async () => {
    const user = userEvent.setup();
    // Signed out first: this is what settles a shared subscription's state to
    // loading:false — the stale flag the finding exploits.
    authState.current = { user: null, loading: false };
    const { rerender } = render(<ProfileEditor />);

    // A returning user signs in; their saved name differs from their Google
    // name and their users/{uid} snapshot is slow to arrive.
    profileSub.defer.add('u2');
    profileSub.docs.set('u2', { displayName: 'Gee Saved', photoURL: null, customPhoto: false, createdAt: 0 });
    authState.current = { user: { uid: 'u2', displayName: 'Gee Google', photoURL: null }, loading: false };
    rerender(<ProfileEditor />);

    // No render for the new uid may ever observe loading:false before this
    // uid's own snapshot resolved.
    const u2Renders = profileSub.renderLog.filter((entry) => entry.uid === 'u2');
    expect(u2Renders.length).toBeGreaterThan(0);
    expect(u2Renders[0].loading).toBe(true);
    // And behaviorally: the trigger is present but disabled until u2's snapshot…
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeDisabled();
    expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();

    act(() => profileSub.release('u2'));

    // …then seeds the saved name, and Save persists it — never the Google name.
    await user.click(screen.getByRole('button', { name: 'Edit profile' }));
    expect(screen.getByLabelText('Display name')).toHaveValue('Gee Saved');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() =>
      expect(setDocMock).toHaveBeenCalledWith({ path: 'users/u2' }, { displayName: 'Gee Saved' }, { merge: true }),
    );
    expect(setDocMock).not.toHaveBeenCalledWith({ path: 'users/u2' }, { displayName: 'Gee Google' }, { merge: true });
  });

  it('uploading a photo persists it, and the live update flips the previewed Avatar to it', async () => {
    const user = userEvent.setup();
    render(<ProfileEditor />);
    await user.click(screen.getByRole('button', { name: 'Edit profile' }));
    const preview = within(screen.getByRole('button', { name: 'Change avatar' }));
    expect(preview.getByRole('img')).toHaveAttribute('src', googlePhoto);

    await user.upload(screen.getByLabelText('Upload avatar'), new File(['x'], 'me.png', { type: 'image/png' }));
    // onAvatarFile is async (awaits updateAvatar) — wait for it to settle.
    await waitFor(() =>
      expect(setDocMock).toHaveBeenCalledWith(
        { path: 'users/u1' },
        { photoURL: customUrl, customPhoto: true },
        { merge: true },
      ),
    );

    // The live users/{uid} subscription delivers the updated doc.
    act(() => profileSub.push('u1', { displayName: 'Alex', photoURL: customUrl, customPhoto: true, createdAt: 0 }));
    expect(preview.getByRole('img')).toHaveAttribute('src', customUrl);
  });

  it('falls back to the auth name when a malformed saved displayName would otherwise crash Avatar', async () => {
    const user = userEvent.setup();
    profileSub.docs.set('u1', { displayName: 12345, photoURL: null, customPhoto: false, createdAt: 0 } as unknown as UserDoc);

    render(<ProfileEditor />);
    await user.click(screen.getByRole('button', { name: 'Edit profile' }));

    expect(screen.getByLabelText('Display name')).toHaveValue('Google Name');
    expect(within(screen.getByRole('button', { name: 'Change avatar' })).getByRole('img')).toHaveAttribute('src', googlePhoto);
  });

  it('contains focus inside the profile dialog and restores it on close', async () => {
    const user = userEvent.setup();
    render(<ProfileEditor />);

    const trigger = screen.getByRole('button', { name: 'Edit profile' });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Edit profile' });
    await waitFor(() => expect(within(dialog).getByText('Edit profile')).toHaveFocus());

    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Save name' })).toHaveFocus();

    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Change avatar' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Edit profile' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('marks a changed profile draft as unsaved work so a hidden-tab update cannot discard it', async () => {
    const user = userEvent.setup();
    render(<ProfileEditor />);
    await user.click(screen.getByRole('button', { name: 'Edit profile' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit profile' });
    expect(dialog).not.toHaveAttribute('data-unsaved-work');

    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Draft only');
    expect(dialog).toHaveAttribute('data-unsaved-work');
  });

  it('renders the trigger as the avatar button (tap your photo to edit)', () => {
    render(<ProfileEditor />);

    const trigger = screen.getByRole('button', { name: 'Edit profile' });
    // The avatar-trigger class styles it as a bare, in-header photo button…
    expect(trigger).toHaveClass('avatar-trigger');
    // …and the button's content is the player's avatar, not a separate icon.
    expect(within(trigger).getByRole('img')).toHaveAttribute('src', googlePhoto);
  });
});
