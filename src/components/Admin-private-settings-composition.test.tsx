import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveAdultContent } from '../adultContent';
import { DEFAULT_EDITION, setActiveEdition } from '../editions';
import type { EventDoc } from '../types';

// Actual Admin, settings, slider, schedule, 18+ confirm, private Event hook and
// captured data/admin writers. Only SDK transport and unrelated queues are
// controlled: a second mocked Event answer cannot hide an optimistic echo.
const H = vi.hoisted(() => ({
  db: { name: 'private-memory' }, legacyDb: { name: 'persistent' },
  uid: 'alice', generation: 1, eventId: 'event', adult: false,
  event: {} as EventDoc,
  listeners: [] as { next: (snapshot: unknown) => void; error: () => void; stop: ReturnType<typeof vi.fn> }[],
  writes: [] as { fields: Record<string, unknown>; resolve: () => void; reject: (error: Error) => void }[],
  update: vi.fn(), transaction: vi.fn(),
}));
vi.mock('../firebase', () => ({
  db: H.legacyDb, get EVENT_ID() { return H.eventId; },
  auth: { get currentUser() { return { uid: H.uid }; } }, functions: {}, storage: {}, analytics: null,
}));
vi.mock('../analytics', () => ({ track: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { uid: H.uid } }) }));
vi.mock('../hooks/useOnline', () => ({ useOnline: () => true }));
vi.mock('../hooks/usePrivateFirestore', () => ({ usePrivateFirestore: () => ({
  db: H.db, uid: H.uid, generation: H.generation, failed: false, recoveryRequired: false,
}) }));
vi.mock('../privateFirestore', () => ({ capturePrivateFirestore: () => {
  const { db, uid, generation, eventId } = H;
  const assertCurrent = () => {
    if (H.db !== db || H.uid !== uid || H.generation !== generation || H.eventId !== eventId) throw new Error('Private session retired.');
  };
  return { db, uid, generation, assertCurrent, guard: async <T,>(operation: () => Promise<T>) => {
    assertCurrent(); const result = await operation(); assertCurrent(); return result;
  } };
} }));
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  const ref = (database: unknown, ...parts: string[]) => ({ database, path: parts.join('/'), withConverter() { return this; } });
  return { ...actual, doc: ref, collection: ref,
    onSnapshot: (target: { database: unknown }, _options: unknown, next: (snapshot: unknown) => void, error: () => void) => {
      expect(target.database).toBe(H.db);
      const stop = vi.fn(); H.listeners.push({ next, error, stop }); return stop;
    },
    updateDoc: (...args: unknown[]) => H.update(...args),
    runTransaction: (...args: unknown[]) => H.transaction(...args),
  };
});
vi.mock('../hooks/useData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useData')>();
  const confirmed = { loading: false, failed: false, hasServerData: true, fromCache: false, hasPendingWrites: false };
  return { ...actual,
    usePendingClaims: () => ({ ...confirmed, claims: [] }),
    usePendingItems: () => ({ ...confirmed, items: [] }),
    useReportedProofs: () => ({ ...confirmed, flagged: [] }),
    useAllItems: () => ({ ...confirmed, items: [] }),
    useLeaderboard: () => ({ ...confirmed, players: [] }),
    useDayMetasStatus: () => ({ metas: new Map(), loaded: true, serverConfirmed: true, failed: false, scheduleUnusable: false }),
  };
});
vi.mock('../hooks/useAdultContent', () => ({ useAdultContent: () => H.adult }));
vi.mock('../theme/themes', () => ({ themesForEditionIncluding: () => [
  { id: 'neon-playground', emoji: '🌈', label: 'Neon Playground' },
  { id: 'duty-free', emoji: '✈️', label: 'Duty Free' },
] }));
vi.mock('./admin/ReviewQueue', () => ({ default: () => null }));
vi.mock('./admin/AdminHub', () => ({ default: () => null }));
vi.mock('./admin/PromptPool', () => ({ default: () => null }));
vi.mock('./admin/PlayersPanel', () => ({ default: () => null }));
vi.mock('./admin/MessagesPanel', () => ({ default: () => null }));
import Admin from './Admin';

const snapshot = (pending = false, event = H.event) => ({ exists: () => true, data: () => event, metadata: { fromCache: false, hasPendingWrites: pending } });
const emit = (pending = false, event = H.event) => H.listeners.at(-1)!.next(snapshot(pending, event));
const renderAdmin = (section = 'settings') => {
  const tree = <MemoryRouter initialEntries={[`/more/admin/${section}`]}><Admin /></MemoryRouter>;
  return render(tree);
};
const applyFields = (fields: Record<string, unknown>): EventDoc => {
  const next = { ...H.event, settings: { ...H.event.settings } };
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith('settings.')) Object.assign(next.settings!, { [key.slice(9)]: value });
    else Object.assign(next, { [key]: value });
  }
  return next;
};
const hold = (fields: Record<string, unknown>) => {
  emit(true, { ...applyFields(fields), admins: [] });
  return new Promise<void>((resolve, reject) => H.writes.push({ fields, resolve, reject }));
};
const reject = async (index = H.writes.length - 1) => act(async () => {
  // Denial may arrive before Firestore's rollback snapshot. Feedback must stay
  // mounted because the private hook retains the prior committed Event.
  H.writes[index]!.reject(new Error('permission-denied: raw details must not render'));
});
const acknowledge = async (index = H.writes.length - 1) => act(async () => {
  H.event = applyFields(H.writes[index]!.fields); emit(); H.writes[index]!.resolve();
});

beforeEach(() => {
  vi.clearAllMocks(); H.uid = 'alice'; H.generation = 1; H.eventId = 'event'; H.adult = false;
  H.db = { name: 'private-memory' }; H.listeners = []; H.writes = [];
  H.event = {
    name: 'Event', startsOn: '2026-10-03', endsOn: '2026-10-05', timezone: 'UTC',
    status: 'active', admins: ['alice', 'bob'], bannedUids: [], claimMode: 'honor', defaultTheme: 'neon-playground',
    settings: { photoProofSource: 'camera_or_library', stripPhotoExif: true, visionGate: true, reportHideThreshold: 4, easyMixRatio: 0.5, forceAdult: false },
    days: [
      { index: 0, date: '2026-10-05', place: 'Port', placeEmoji: '🚢', pool: 'main', tutorial: false, tonight: ['Show', 'Party'], theme: 'neon-playground', unlockAt: Date.now() + 86_400_000 },
      { index: 1, date: '2026-10-03', place: 'Port', placeEmoji: '🚢', pool: 'main', tutorial: false, tonight: ['Show', 'Party'], theme: 'neon-playground', unlockAt: Date.now() - 86_400_000 },
    ],
  };
  setActiveAdultContent(false); setActiveEdition('fiveacross');
  H.update.mockImplementation((target: { database: unknown; path: string }, fields: Record<string, unknown>) => {
    expect(target.database).toBe(H.db); expect(target.path).toBe(`events/${H.eventId}`); return hold(fields);
  });
  H.transaction.mockImplementation(async (database: unknown, operation: (tx: unknown) => Promise<unknown>) => {
    expect(database).toBe(H.db);
    let fields: Record<string, unknown> = {};
    const tx = { get: async () => snapshot(), update: (_target: unknown, patch: Record<string, unknown>) => { fields = patch; return tx; } };
    const result = await operation(tx); await hold(fields); return result;
  });
});
afterEach(() => { setActiveAdultContent(true); setActiveEdition(DEFAULT_EDITION); });

describe('actual private Admin settings save feedback (#1678)', () => {
  it.each([
    { label: 'Claim mode', field: 'claimMode', value: 'admin_confirmed', control: () => screen.getByRole('button', { name: 'Admin-confirmed' }), assertOld: () => expect(screen.getByRole('button', { name: 'Honor' })).toHaveAttribute('aria-pressed', 'true') },
    { label: 'Photo proof source', field: 'settings.photoProofSource', value: 'camera_only', control: () => screen.getByRole('button', { name: 'Camera only' }), assertOld: () => expect(screen.getByRole('button', { name: 'Camera or library' })).toHaveAttribute('aria-pressed', 'true') },
    { label: 'Location data', field: 'settings.stripPhotoExif', value: false, control: () => screen.getByRole('checkbox', { name: 'Strip location data' }), assertOld: () => expect(screen.getByRole('checkbox', { name: 'Strip location data' })).toBeChecked() },
    { label: 'AI image screen', field: 'settings.visionGate', value: false, control: () => screen.getByRole('checkbox', { name: 'AI image screen' }), assertOld: () => expect(screen.getByRole('checkbox', { name: 'AI image screen' })).toBeChecked() },
    { label: 'Auto-hide threshold', field: 'settings.reportHideThreshold', value: 5, control: () => screen.getByRole('button', { name: 'Increase auto-hide threshold' }), assertOld: () => expect(screen.getByText('4', { selector: 'span' })).toBeInTheDocument() },
    { label: 'Default theme', field: 'defaultTheme', value: 'duty-free', control: () => screen.getByRole('button', { name: /Duty Free/ }), assertOld: () => expect(screen.getByRole('button', { name: /Neon Playground/ })).toHaveClass('active') },
  ])('$label retains committed values through a held echo, catches denial and retries', async ({ label, field, value, control, assertOld }) => {
    renderAdmin(); await act(async () => emit());
    const button = control(); fireEvent.click(button);
    await waitFor(() => expect(H.writes).toHaveLength(1));
    expect(H.writes[0]!.fields).toEqual({ [field]: value });
    expect(control()).toBe(button); expect(button).toBeDisabled(); assertOld();
    expect(screen.getByRole('button', { name: 'Archive…' })).toBeDisabled();
    fireEvent.click(button); expect(H.writes).toHaveLength(1);
    await reject();
    expect(await screen.findByRole('alert')).toHaveTextContent(`${label} save failed. Try again.`);
    expect(screen.queryByText(/raw details/)).toBeNull(); expect(button).toBeEnabled(); assertOld();
    await act(async () => emit());
    fireEvent.click(button); await waitFor(() => expect(H.writes).toHaveLength(2));
    expect(screen.queryByRole('alert')).toBeNull();
    await acknowledge(); expect(button).toBeEnabled(); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retries an identical failed Easy mix release while preserving rapid later releases', async () => {
    renderAdmin(); await act(async () => emit());
    const slider = screen.getByRole('slider') as HTMLInputElement;
    const release = (pct: number) => { fireEvent.change(slider, { target: { value: String(pct) } }); fireEvent.keyUp(slider); };
    slider.focus(); release(60); fireEvent.pointerUp(slider);
    await waitFor(() => expect(H.writes).toHaveLength(1));
    expect(H.writes[0]!.fields).toEqual({ 'settings.easyMixRatio': 0.6 });
    await reject(); expect(slider.value).toBe('50');
    expect(screen.getByRole('alert')).toHaveTextContent('Easy mix save failed. Try again.');
    release(60); await waitFor(() => expect(H.writes).toHaveLength(2));
    expect(screen.queryByRole('alert')).toBeNull();
    release(65); release(70);
    await waitFor(() => expect(H.writes).toHaveLength(4));
    expect(H.writes.slice(1).map((write) => write.fields)).toEqual([
      { 'settings.easyMixRatio': 0.6 }, { 'settings.easyMixRatio': 0.65 }, { 'settings.easyMixRatio': 0.7 },
    ]);
    await acknowledge(3); await reject(2); await reject(1);
    expect(slider.value).toBe('70'); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('follows an earlier committed Easy mix echo after the latest focused release fails', async () => {
    renderAdmin(); await act(async () => emit());
    const slider = screen.getByRole('slider') as HTMLInputElement;
    slider.focus();
    for (const pct of [60, 65]) {
      fireEvent.change(slider, { target: { value: String(pct) } }); fireEvent.keyUp(slider);
    }
    await waitFor(() => expect(H.writes).toHaveLength(2));
    expect(H.writes.map(write => write.fields)).toEqual([
      { 'settings.easyMixRatio': 0.6 }, { 'settings.easyMixRatio': 0.65 },
    ]);
    await reject(1);
    expect(slider.value).toBe('50'); expect(slider).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('Easy mix save failed. Try again.');
    // Promise fulfillment alone is not committed private Event authority.
    await act(async () => H.writes[0]!.resolve());
    expect(slider.value).toBe('50');
    await act(async () => { H.event = applyFields(H.writes[0]!.fields); emit(); });
    expect(slider.value).toBe('60'); expect(slider).toHaveFocus();
    expect(slider).toHaveAttribute('aria-valuetext', '60% · 14 of 24 squares');
    expect(screen.getByText('60% · 14 of 24 squares')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Easy mix save failed. Try again.');
    fireEvent.pointerUp(slider); fireEvent.keyUp(slider); act(() => slider.blur());
    expect(H.writes).toHaveLength(2);
    fireEvent.change(slider, { target: { value: '65' } }); fireEvent.pointerUp(slider);
    await waitFor(() => expect(H.writes).toHaveLength(3));
    expect(H.writes[2]!.fields).toEqual({ 'settings.easyMixRatio': 0.65 });
    expect(screen.queryByRole('alert')).toBeNull(); await acknowledge(2);
  });

  it('does not clobber a new uncommitted slider adjustment when its prior release rejects', async () => {
    renderAdmin(); await act(async () => emit());
    const slider = screen.getByRole('slider') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '60' } }); fireEvent.pointerUp(slider);
    await waitFor(() => expect(H.writes).toHaveLength(1));
    fireEvent.change(slider, { target: { value: '80' } }); await reject();
    expect(slider.value).toBe('80'); fireEvent.pointerUp(slider);
    await waitFor(() => expect(H.writes).toHaveLength(2));
    expect(H.writes[1]!.fields).toEqual({ 'settings.easyMixRatio': 0.8 }); await acknowledge();
  });

  it('preserves a newer slider draft that returns to the failed release value and retries it', async () => {
    renderAdmin(); await act(async () => emit());
    const slider = screen.getByRole('slider') as HTMLInputElement;
    slider.focus();
    fireEvent.change(slider, { target: { value: '60' } }); fireEvent.pointerUp(slider);
    await waitFor(() => expect(H.writes).toHaveLength(1));
    fireEvent.change(slider, { target: { value: '80' } });
    fireEvent.change(slider, { target: { value: '60' } });
    await reject();
    expect(slider.value).toBe('60');
    expect(slider).toHaveAttribute('aria-valuetext', '60% · 14 of 24 squares');
    expect(screen.getByRole('alert')).toHaveTextContent('Easy mix save failed. Try again.');
    fireEvent.pointerUp(slider); await waitFor(() => expect(H.writes).toHaveLength(2));
    expect(H.writes[1]!.fields).toEqual({ 'settings.easyMixRatio': 0.6 });
    expect(screen.queryByRole('alert')).toBeNull(); await acknowledge();
    expect(slider.value).toBe('60');
  });

  it.each(['uid', 'generation', 'event', 'denial'] as const)('retires focused slider recovery on %s before an old success/echo', async (retirement) => {
    const view = renderAdmin(); await act(async () => emit());
    const oldSlider = screen.getByRole('slider') as HTMLInputElement;
    oldSlider.focus();
    for (const pct of [60, 65]) {
      fireEvent.change(oldSlider, { target: { value: String(pct) } }); fireEvent.keyUp(oldSlider);
    }
    await waitFor(() => expect(H.writes).toHaveLength(2)); await reject(1);
    expect(oldSlider.value).toBe('50'); expect(screen.getByRole('alert')).toBeInTheDocument();
    const oldListener = H.listeners.at(-1)!;
    await act(async () => {
      if (retirement === 'denial') oldListener.error();
      else {
        if (retirement === 'uid') H.uid = 'bob';
        if (retirement === 'generation') H.generation++;
        if (retirement === 'event') H.eventId = 'other';
        view.rerender(<MemoryRouter><Admin /></MemoryRouter>);
      }
    });
    expect(screen.queryByRole('slider')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
    if (retirement !== 'denial') await act(async () => emit());
    await act(async () => {
      H.writes[0]!.resolve();
      // A terminal listener error has no subsequent SDK snapshot; only the
      // held writer may settle. Other retired scopes also refuse stale echoes.
      if (retirement !== 'denial') oldListener.next(snapshot(false, { ...H.event, settings: { ...H.event.settings, easyMixRatio: 0.6 } }));
    });
    expect(screen.queryByRole('alert')).toBeNull(); expect(H.writes).toHaveLength(2);
    if (retirement === 'denial') expect(screen.queryByRole('slider')).toBeNull();
    else {
      const current = screen.getByRole('slider') as HTMLInputElement;
      expect(current).not.toBe(oldSlider); expect(current.value).toBe('50'); current.focus();
      await act(async () => { H.event = { ...H.event, settings: { ...H.event.settings, easyMixRatio: 0.7 } }; emit(); });
      expect(current.value).toBe('50'); act(() => current.blur()); expect(current.value).toBe('70');
      expect(H.writes).toHaveLength(2);
    }
  });

  it('holds Day-theme feedback through the private transaction denial and preserves the Day lock', async () => {
    renderAdmin('schedule'); await act(async () => emit());
    const future = screen.getByRole('combobox', { name: 'Day 1 theme' });
    const locked = screen.getByRole('combobox', { name: 'Day 2 theme' });
    expect(locked).toBeDisabled();
    fireEvent.change(future, { target: { value: 'duty-free' } });
    await waitFor(() => expect(H.writes).toHaveLength(1));
    expect(future).toHaveValue('neon-playground'); expect(future).toBeDisabled();
    expect(H.writes[0]!.fields.days).toEqual(H.event.days.map((day) => day.index === 0 ? { ...day, theme: 'duty-free' } : day));
    await reject(); expect(screen.getByRole('alert')).toHaveTextContent('Day theme save failed. Try again.');
    expect(future).toHaveValue('neon-playground'); expect(future).toBeEnabled(); expect(locked).toBeDisabled();
    await act(async () => emit()); fireEvent.change(future, { target: { value: 'duty-free' } });
    await waitFor(() => expect(H.writes).toHaveLength(2)); await acknowledge();
    expect(future).toHaveValue('duty-free'); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the real force-adult dialog on rejection, cancels without IO and retries', async () => {
    renderAdmin(); await act(async () => emit());
    const toggle = screen.getByRole('checkbox', { name: 'Adults only' });
    fireEvent.click(toggle); expect(screen.getByRole('dialog', { name: 'This makes the whole Event 18+' })).toBeInTheDocument(); expect(H.writes).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'This makes the whole Event 18+' })).toBeNull(); expect(toggle).not.toBeChecked();
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle); const confirm = screen.getByRole('button', { name: 'Make this Event 18+' });
    fireEvent.click(confirm); await waitFor(() => expect(H.writes).toHaveLength(1));
    expect(confirm).toBeDisabled(); expect(toggle).not.toBeChecked();
    await reject(); expect(screen.getByRole('dialog', { name: 'This makes the whole Event 18+' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing changed — try again.');
    fireEvent.click(confirm); await waitFor(() => expect(H.writes).toHaveLength(2)); await acknowledge();
    expect(screen.queryByRole('dialog', { name: 'This makes the whole Event 18+' })).toBeNull(); expect(toggle).toBeChecked();
  });

  it.each([false, true])('catches the force-adult direct write when the prior override is %s', async (prior) => {
    H.adult = true; setActiveAdultContent(true); H.event.settings!.forceAdult = prior;
    renderAdmin(); await act(async () => emit());
    const toggle = screen.getByRole('checkbox', { name: 'Adults only' });
    fireEvent.click(toggle); await waitFor(() => expect(H.writes).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: 'This makes the whole Event 18+' })).toBeNull(); expect(toggle).toBeDisabled();
    expect(H.writes[0]!.fields).toEqual({ 'settings.forceAdult': !prior });
    await reject(); expect(screen.getByRole('alert')).toHaveTextContent('Adults-only setting save failed. Try again.');
    expect(toggle).toBeEnabled(); expect((toggle as HTMLInputElement).checked).toBe(prior);
    fireEvent.click(toggle); await waitFor(() => expect(H.writes).toHaveLength(2)); await acknowledge();
    expect((toggle as HTMLInputElement).checked).toBe(!prior);
  });

  it.each(['uid', 'generation', 'event', 'denial'] as const)('retires a held setting before %s changes and isolates late completion', async (retirement) => {
    const view = renderAdmin(); await act(async () => emit());
    fireEvent.click(screen.getByRole('button', { name: 'Admin-confirmed' }));
    await waitFor(() => expect(H.writes).toHaveLength(1));
    const oldListener = H.listeners.at(-1)!;
    await act(async () => {
      if (retirement === 'denial') oldListener.error();
      else {
        if (retirement === 'uid') H.uid = 'bob';
        if (retirement === 'generation') H.generation++;
        if (retirement === 'event') H.eventId = 'other';
        // A new element forces the surrounding context consumers to observe
        // the new scope, exactly as their real providers would.
        view.rerender(<MemoryRouter><Admin /></MemoryRouter>);
      }
    });
    expect(screen.queryByRole('button', { name: 'Admin-confirmed' })).toBeNull();
    if (retirement !== 'denial') {
      expect(oldListener.stop).toHaveBeenCalledOnce(); await act(async () => emit());
      expect(screen.getByRole('button', { name: 'Honor' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Admin-confirmed' })).toBeEnabled();
      // A successful SDK acknowledgment still rejects through the captured
      // lease's post-await fence. It must not paint feedback in the new scope.
      await act(async () => H.writes[0]!.resolve());
      await act(async () => oldListener.next(snapshot(true, { ...H.event, claimMode: 'admin_confirmed' })));
      expect(screen.getByRole('button', { name: 'Honor' })).toHaveAttribute('aria-pressed', 'true');
    } else await reject();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['slider', 'schedule', 'force-dialog'] as const)('isolates a retired %s failure from a fresh Admin scope', async (control) => {
    const view = renderAdmin(control === 'schedule' ? 'schedule' : 'settings'); await act(async () => emit());
    if (control === 'slider') {
      const slider = screen.getByRole('slider'); fireEvent.change(slider, { target: { value: '60' } }); fireEvent.pointerUp(slider);
    } else if (control === 'schedule') {
      fireEvent.change(screen.getByRole('combobox', { name: 'Day 1 theme' }), { target: { value: 'duty-free' } });
    } else {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Adults only' }));
      fireEvent.click(screen.getByRole('button', { name: 'Make this Event 18+' }));
    }
    await waitFor(() => expect(H.writes).toHaveLength(1));
    await act(async () => { H.generation++; view.rerender(<MemoryRouter><Admin /></MemoryRouter>); });
    await act(async () => emit()); await reject();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'This makes the whole Event 18+' })).toBeNull();
    if (control === 'schedule') expect(screen.getByRole('combobox', { name: 'Day 1 theme' })).toHaveValue('neon-playground');
    else {
      expect(screen.getByRole('slider')).toHaveValue('50');
      expect(screen.getByRole('checkbox', { name: 'Adults only' })).not.toBeChecked();
    }
  });
});
