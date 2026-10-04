// The shared Easy mix dial in isolation (#1376): mounted with a plain
// `value`/`onChange` pair, no Admin shell, no Firestore. The Admin surface's
// own behavior (the `setEasyMixRatio` write path, the focus guard's echo
// handling) stays pinned by `Admin.test.tsx`, which this extraction leaves
// unmodified.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EasyMixSlider } from './EasyMixSlider';

function mount(value: number, onChange = vi.fn()) {
  render(<EasyMixSlider value={value} onChange={onChange} />);
  const slider = screen.getByRole('slider', { name: 'Easy mix percentage' }) as HTMLInputElement;
  return { slider, onChange };
}

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
});
