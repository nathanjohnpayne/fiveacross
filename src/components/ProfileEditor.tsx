import { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { useAuth } from '../auth/AuthContext';
import { useMyUser } from '../hooks/useData';
import { MAX_DISPLAY_NAME, updateAvatar, updateDisplayName } from '../data/profile';
import Avatar from './Avatar';

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A signed-in User's display-name + avatar editor, reachable from anywhere
 * (identity is public everywhere it appears — ADR 0002). Writes go through
 * data/profile.ts, which reuses uploadAvatar/downscaleImage (data/storage.ts).
 *
 * The editor proper is keyed by uid, so an auth transition (sign-out, account
 * switch) unmounts it wholesale instead of letting state straddle accounts:
 * - the sheet's open/name/busy/error state resets — a sheet account A left
 *   open (or half-typed) can never reappear under, or be saved to, account B;
 * - the useMyUser subscription state resets too. Its `loading` flag only
 *   re-latches inside an effect keyed on the uid, so a single persistent
 *   instance hands the FIRST render after a new sign-in the PREVIOUS
 *   subscription's settled `false` (e.g. from signed-out useMyUser(undefined))
 *   — a one-render window where the trigger showed and the form could seed,
 *   and save, the Google name before the new users/{uid} snapshot arrived. A
 *   fresh instance per uid starts loading=true, so the gate below is per-uid
 *   by construction and that window cannot exist.
 */
export default function ProfileEditor() {
  const { user, loading } = useAuth();
  if (loading || !user) return null;
  return <Editor key={user.uid} user={user} />;
}

function Editor({ user }: { user: User }) {
  // Fresh per uid (see the key above): `profileLoading` starts true and can
  // never be another subscription's leftover settled flag.
  const { data: profile, loading: profileLoading, hasServerData: profileConfirmed } = useMyUser(user.uid);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    titleRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      triggerRef.current?.focus();
    };
  }, [open]);

  // The avatar itself is the edit trigger (it lives in the Nav header), so it
  // renders immediately for layout — but it stays DISABLED until the live
  // users/{uid} snapshot lands. openEditor() below seeds `name` from
  // `currentName`, and while the profile subscription is still loading `profile`
  // is null so that fallback reads `user.displayName` (the Google name). Gating
  // the OPEN on `ready` (not hiding the trigger) keeps the same guarantee — the
  // editor can never seed, and on Save persist, the Google name over a saved
  // custom displayName that simply hadn't arrived yet — without leaving a hole
  // in the header where the avatar belongs.
  const ready = !profileLoading && profileConfirmed;

  const currentName = validDisplayName(profile?.displayName) ?? validDisplayName(user.displayName) ?? 'Anonymous';
  // customPhoto flags whether photoURL currently holds a custom upload (vs.
  // the Google photo) — prefer it only when that flag is set.
  const customSrc = profile?.customPhoto === true && typeof profile.photoURL === 'string' ? profile.photoURL : null;

  const openEditor = () => {
    if (!ready) return; // belt-and-braces; the trigger is also `disabled` until ready
    setName(currentName);
    setError(null);
    setOpen(true);
  };

  // Shared busy/error wrapper for the two writes below.
  const run = async (fn: () => Promise<unknown>, failMsg: string, onOk?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onOk?.();
    } catch {
      setError(failMsg);
    } finally {
      setBusy(false);
    }
  };

  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed) run(() => updateDisplayName(user.uid, trimmed), 'Could not save your name—try again.', () => setOpen(false));
  };

  const onAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) run(() => updateAvatar(user.uid, file), 'Upload failed—try again.');
  };

  // The More menu's "Profile card" row (#208, daily-cards-spec § "More menu"
  // § 1): avatar, name, @handle, all inside the SAME trigger button so tapping
  // anywhere in the row opens the sheet — not just the avatar. `handle` is
  // optional (UserDoc.handle, unset until a Player sets one) so its row is
  // simply omitted rather than rendering an empty "@".
  const handle = typeof profile?.handle === 'string' ? profile.handle.trim() : '';
  // A profile sheet is not merely a visible modal: its name draft and selected
  // avatar live only in this component until their write settles. The update
  // bridge checks this marker before the hidden-tab shortcut too, so moving to
  // the background cannot discard an edit while a new worker activates.
  const hasUnsavedProfileWork = open && (name !== currentName || busy);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="avatar-trigger more-row"
        title="Edit profile"
        aria-label="Edit profile"
        aria-haspopup="dialog"
        disabled={!ready}
        onClick={openEditor}
      >
        <Avatar name={currentName} src={user.photoURL ?? null} customPhoto={customSrc} />
        <span className="more-row-text">
          <span className="more-row-title">{currentName}</span>
          {handle && <span className="more-row-sub">@{handle}</span>}
        </span>
      </button>
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div
            ref={dialogRef}
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Edit profile"
            data-unsaved-work={hasUnsavedProfileWork || undefined}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-title" ref={titleRef} tabIndex={-1}>Edit profile</div>
            <div className="proof-body">
              <button type="button" className="iconbtn" style={{ padding: 0 }} aria-label="Change avatar" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Avatar name={currentName} src={user.photoURL ?? null} customPhoto={customSrc} size={72} />
              </button>
              <input ref={fileRef} type="file" accept="image/*" aria-label="Upload avatar" style={{ display: 'none' }} onChange={onAvatarFile} />
              <input className="input" maxLength={MAX_DISPLAY_NAME} value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" aria-label="Display name" />
            </div>
            {error && <p className="muted" role="alert" style={{ fontSize: 12, textAlign: 'center' }}>{error}</p>}
            <div className="sheet-actions">
              <button type="button" className="btn" onClick={() => setOpen(false)}>Close</button>
              <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={saveName}>
                {busy ? 'Saving…' : 'Save name'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function validDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, MAX_DISPLAY_NAME);
  return trimmed || null;
}
