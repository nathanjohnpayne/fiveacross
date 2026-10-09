import { useEffect, useRef, useState } from 'react';

/** Start media work once its card comes within one short scroll of the view. */
export function useNearViewport() {
  const ref = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (nearby || !node) return;
    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.target === node && entry.isIntersecting)) setNearby(true);
      }, { rootMargin: '400px 0px' });
      observer.observe(node);
      return () => observer.disconnect();
    }
    // Older browsers retain lazy loading through scroll and resize checks.
    const check = () => {
      const box = node.getBoundingClientRect();
      if (box.bottom >= -400 && box.top <= window.innerHeight + 400) setNearby(true);
    };
    check();
    window.addEventListener('scroll', check, { passive: true, capture: true });
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('scroll', check, true);
      window.removeEventListener('resize', check);
    };
  }, [nearby]);
  return { ref, nearby };
}
