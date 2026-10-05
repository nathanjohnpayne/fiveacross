// The shared Easy mix dial takes a plain value/callback pair. These controls
// pin generic draft, committed-prop, failure recovery and focus ownership.
// Admin.test.tsx covers the Admin surface; the private settings composition
// drives its real committed Event hook and captured writer.
import { describe, it, expect, vi } from 'vitest';
import { Suspense, startTransition, useLayoutEffect, useState } from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { EasyMixSlider } from './EasyMixSlider';

function mount(value: number, onChange = vi.fn()) {
  render(<EasyMixSlider value={value} onChange={onChange} />);
  const slider = screen.getByRole('slider', { name: 'Easy mix percentage' }) as HTMLInputElement;
  return { slider, onChange };
}

function orderedReleases() {
  const pending: { resolve: () => void; reject: () => void }[] = [];
  const save = vi.fn((_ratio: number) => new Promise<void>((resolve, reject) => {
    pending.push({ resolve, reject: () => reject(new Error('Denied')) });
  }));
  const view = render(<EasyMixSlider value={0.5} onChange={save} />);
  const slider = screen.getByRole('slider') as HTMLInputElement;
  const change = (pct: number) => fireEvent.change(slider, { target: { value: String(pct) } });
  const release = (pct: number) => { change(pct); fireEvent.keyUp(slider); };
  const echo = (value: number) => view.rerender(<EasyMixSlider value={value} onChange={save} />);
  slider.focus(); release(60); release(65);
  return { slider, save, pending, change, release, echo };
}

describe('latest failed fallback committed echoes (#1713)', () => {
  it('follows successive committed echoes without a new draft, including an untouched deduped release', async () => {
    const { slider, save, pending, echo } = orderedReleases();
    await act(async () => pending[1].reject());
    expect(slider.value).toBe('50'); fireEvent.keyUp(slider);
    await act(async () => pending[0].resolve());
    expect(slider.value).toBe('50'); expect(save.mock.calls.map(call => call[0])).toEqual([0.6, 0.65]);
    echo(0.62); expect(slider.value).toBe('60');
    echo(0.7); expect(slider.value).toBe('70'); expect(slider).toHaveFocus();
    expect(screen.getByText('70% · 17 of 24 squares')).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-valuetext', '70% · 17 of 24 squares');
    expect(screen.getByRole('alert')).toHaveTextContent('Easy mix save failed. Try again.');
    fireEvent.pointerUp(slider); fireEvent.keyUp(slider); act(() => slider.blur());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it.each([
    { timing: 'before', aba: false, final: 80 }, { timing: 'before', aba: true, final: 65 },
    { timing: 'after', aba: false, final: 80 }, { timing: 'after', aba: true, final: 50 },
  ])('keeps a newer $timing-failure draft (ABA=$aba) when an earlier echo commits', async ({ timing, aba, final }) => {
    const { slider, save, pending, change, release, echo } = orderedReleases();
    const draft = () => { change(80); if (aba) change(final); };
    if (timing === 'before') draft();
    await act(async () => pending[1].reject());
    if (timing === 'after') draft();
    echo(0.6);
    expect(slider.value).toBe(String(final)); expect(slider).toHaveFocus();
    const phrase = `${final}% · ${Math.round(24 * final / 100)} of 24 squares`;
    expect(slider).toHaveAttribute('aria-valuetext', phrase); expect(screen.getByText(phrase)).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(2);
    release(70); expect(save).toHaveBeenLastCalledWith(0.7);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([65, 70])('a newer %i request ends old recovery, and only its own failure may follow a later echo', async (next) => {
    const { slider, save, pending, release, echo } = orderedReleases();
    await act(async () => pending[1].reject());
    release(next); echo(0.6);
    expect(slider.value).toBe(String(next)); expect(save).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => pending[0].reject());
    expect(slider.value).toBe(String(next)); expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => pending[2].reject());
    expect(slider.value).toBe('60'); echo(0.7);
    expect(slider.value).toBe('70'); expect(slider).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('Easy mix save failed. Try again.');
    fireEvent.pointerUp(slider); expect(save).toHaveBeenCalledTimes(3);
  });

  it('retains the ordinary healthy focus guard and catches up on no-op blur', () => {
    const { slider, save, echo } = orderedReleases();
    echo(0.6); echo(0.7);
    expect(slider.value).toBe('65'); expect(slider).toHaveAttribute('aria-valuetext', '65% · 16 of 24 squares');
    act(() => slider.blur()); expect(slider.value).toBe('70'); expect(save).toHaveBeenCalledTimes(2);
  });

  it('ends failed-fallback recovery on blur and protects the next focused interaction', async () => {
    const { slider, save, pending, echo } = orderedReleases();
    await act(async () => pending[1].reject()); echo(0.6);
    expect(slider.value).toBe('60'); act(() => slider.blur()); slider.focus();
    echo(0.7); expect(slider.value).toBe('60');
    act(() => slider.blur()); expect(slider.value).toBe('70'); expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('EasyMixSlider (shared module)', () => {
  it('reads "50% · 12 of 24 squares" at 50% in the bubble and in aria-valuetext', () => {
    const { slider } = mount(0.5);
    expect(slider.min).toBe('0');
    expect(slider.max).toBe('100');
    expect(slider.step).toBe('5');
    expect(slider.value).toBe('50');
    expect(screen.getByText('50% · 12 of 24 squares')).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-valuetext', '50% · 12 of 24 squares');
  });

  it('snaps an off-grid stored ratio to the 5% grid for display', () => {
    const { slider } = mount(0.27);
    expect(slider.value).toBe('25');
    expect(screen.getByText('25% · 6 of 24 squares')).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-valuetext', '25% · 6 of 24 squares');
  });

  it('clamps an out-of-range stored ratio to 0..100', () => {
    const { slider } = mount(1.4);
    expect(slider.value).toBe('100');
    expect(screen.getByText('100% · 24 of 24 squares')).toBeInTheDocument();
  });

  it('fires onChange once on release with the snapped ratio, not while dragging', () => {
    const { slider, onChange } = mount(0.25);
    fireEvent.change(slider, { target: { value: '50' } });
    expect(screen.getByText('50% · 12 of 24 squares')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(0.5);

    // A repeat release at the same position dedups against the last request.
    fireEvent.pointerUp(slider);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('does not fire onChange on an untouched release, key-up, or blur', () => {
    const { slider, onChange } = mount(0.5);
    fireEvent.pointerUp(slider);
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    fireEvent.blur(slider);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not rewrite a stored off-grid ratio just because it was released untouched', () => {
    const { slider, onChange } = mount(0.27);
    fireEvent.pointerUp(slider);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits an assistive-tech value change on blur', () => {
    const { slider, onChange } = mount(0.5);
    fireEvent.change(slider, { target: { value: '70' } });
    fireEvent.blur(slider);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(0.7);
  });

  it('labels the five detent stops under the track and offers them as datalist options', () => {
    const { slider } = mount(0.5);
    for (const v of [0, 25, 50, 75, 100]) {
      expect(screen.getByText(`${v}%`)).toBeInTheDocument();
    }
    const list = document.getElementById(slider.getAttribute('list') ?? '');
    expect(list?.querySelectorAll('option')).toHaveLength(5);
  });

  it('re-syncs the thumb and bubble when the value changes externally', () => {
    const onChange = vi.fn();
    const { rerender } = render(<EasyMixSlider value={0.25} onChange={onChange} />);
    rerender(<EasyMixSlider value={0.75} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Easy mix percentage' }) as HTMLInputElement;
    expect(slider.value).toBe('75');
    expect(screen.getByText('75% · 18 of 24 squares')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('restores the last committed prop after a rendered transition is discarded', async () => {
    let reject!: (error: Error) => void;
    const save = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const renders: number[] = [];
    const commits: number[] = [];
    let update!: (value: number, suspended: boolean) => void;
    const held = new Promise<void>(() => {});
    function Gate({ suspended }: { suspended: boolean }) {
      if (suspended) throw held;
      return null;
    }
    function Slider({ value }: { value: number }) {
      renders.push(value);
      useLayoutEffect(() => { commits.push(value); }, [value]);
      return <><span data-testid="committed-value">{value}</span><EasyMixSlider value={value} onChange={save} /></>;
    }
    function Harness() {
      const [state, setState] = useState({ value: 0.5, suspended: false });
      update = (value, suspended) => setState({ value, suspended });
      return <Suspense fallback={<span>Suspended</span>}><Slider value={state.value} /><Gate suspended={state.suspended} /></Suspense>;
    }
    render(<Harness />);
    const slider = screen.getByRole('slider') as HTMLInputElement;
    slider.focus();
    fireEvent.change(slider, { target: { value: '60' } });
    fireEvent.pointerUp(slider);
    act(() => { startTransition(() => update(0.8, true)); });
    expect(renders).toContain(0.8);
    expect(commits).toEqual([0.5]);
    expect(screen.getByTestId('committed-value')).toHaveTextContent('0.5');
    await act(async () => { reject(new Error('Denied')); });
    act(() => update(0.5, false));
    expect(commits).not.toContain(0.8);
    expect(screen.queryByText('Suspended')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Easy mix save failed');
    expect(slider).toHaveFocus();
    expect(save).toHaveBeenCalledExactlyOnceWith(0.6);
    expect(slider.value).toBe('50');
    expect(slider).toHaveAttribute('aria-valuetext', '50% · 12 of 24 squares');
  });

  it('observes a committed prop before a parent layout effect can release and fail', () => {
    const save = vi.fn(() => { throw new Error('Denied'); });
    function Harness({ value, release }: { value: number; release: boolean }) {
      useLayoutEffect(() => {
        if (release) fireEvent.pointerUp(screen.getByRole('slider'));
      }, [release]);
      return <EasyMixSlider value={value} onChange={save} />;
    }
    const view = render(<Harness value={0.5} release={false} />);
    const slider = screen.getByRole('slider') as HTMLInputElement;
    slider.focus();
    fireEvent.change(slider, { target: { value: '60' } });
    view.rerender(<Harness value={0.8} release />);
    expect(save).toHaveBeenCalledExactlyOnceWith(0.6);
    expect(slider).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('Easy mix save failed');
    expect(slider.value).toBe('80');
    expect(slider).toHaveAttribute('aria-valuetext', '80% · 19 of 24 squares');
  });

});
