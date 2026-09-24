import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ItemDoc } from '../../types';

// admin/PromptPool, component layer. Drives the REAL AdminAddItemForm with the
// data boundary (data/admin writes + useData's isReportHidden) stubbed.

const H = vi.hoisted(() => ({
  adminAddItem: vi.fn((..._a: unknown[]) => Promise.resolve()),
}));

vi.mock('../../hooks/useData', () => ({ isReportHidden: () => false }));
vi.mock('../../data/admin', () => ({
  adminAddItem: (...a: unknown[]) => H.adminAddItem(...a),
  adminUpdateItemText: vi.fn(() => Promise.resolve()),
  hideItem: vi.fn(() => Promise.resolve()),
  restoreItem: vi.fn(() => Promise.resolve()),
  deleteItem: vi.fn(() => Promise.resolve()),
}));

import PromptPool from './PromptPool';
import { UNSAVED_WORK_ATTRIBUTE } from '../../swClientBridge';

beforeEach(() => {
  vi.clearAllMocks();
});

const renderPool = (items: ItemDoc[] = []) =>
  render(
    <PromptPool
      items={items}
      threshold={undefined}
      pendingCount={0}
      lockedSnapshotItemIds={new Set()}
      adminUid="admin-uid"
    />,
  );

describe('Prompt row Hide/Restore follow the status moves the rules allow an admin client (#1275)', () => {
  const item = (id: string, status: ItemDoc['status']): ItemDoc =>
    ({
      id,
      text: `prompt ${id}`,
      createdBy: `u-${id}`,
      createdAt: 1,
      isFreeSpace: false,
      status,
      reportCount: 0,
      spicy: false,
      pool: 'main',
    }) as ItemDoc;
  const rowOf = (text: string) => screen.getByText(text).closest('.row') as HTMLElement;

  it('an active row offers Hide and not Restore', () => {
    renderPool([item('a', 'active')]);
    const row = rowOf('prompt a');
    expect(within(row).getByRole('button', { name: 'Hide' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('a hidden row offers Restore and not Hide', () => {
    renderPool([item('h', 'hidden')]);
    const row = rowOf('prompt h');
    expect(within(row).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Hide' })).toBeNull();
  });

  it.each(['pending', 'rejected'] as const)(
    'a %s row offers neither — approval is the approvePrompts callable and a rejection is final — but keeps Delete',
    (status) => {
      renderPool([item('p', status)]);
      const row = rowOf('prompt p');
      expect(within(row).queryByRole('button', { name: 'Hide' })).toBeNull();
      expect(within(row).queryByRole('button', { name: 'Restore' })).toBeNull();
      expect(within(row).getByTitle('Delete')).toBeInTheDocument();
    },
  );
});

describe('AdminAddItemForm (post-review #751/#754 on PR #720)', () => {
  // `data-unsaved-work` while a prompt is half-typed (Codex P2 round 5, PR
  // #720) originally used raw non-emptiness, while `submit` requires
  // `text.trim()` — so whitespace-only text marked the form as unsaved work
  // even though Add stayed disabled and could never clear it, pinning the tab
  // to a condemned build forever.
  it('marks the form once real text is typed, but not for whitespace-only text', () => {
    renderPool();
    const marker = `[${UNSAVED_WORK_ATTRIBUTE}]`;
    const input = screen.getByPlaceholderText('Add a prompt (lands active, no review)');

    fireEvent.change(input, { target: { value: '   ' } });
    expect(document.querySelector(marker)).toBeNull();

    fireEvent.change(input, { target: { value: 'A real prompt' } });
    expect(document.querySelector(marker)).not.toBeNull();

    fireEvent.change(input, { target: { value: '' } });
    expect(document.querySelector(marker)).toBeNull();
  });
});
