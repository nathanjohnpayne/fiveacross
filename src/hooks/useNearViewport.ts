import { useEffect, useRef, useState } from 'react';

/** Retain media only while its card is within one short scroll of the view. */
export function useNearViewport() {
  const ref = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.target === node) setNearby(entry.isIntersecting);
        }
      }, { rootMargin: '400px 0px' });
      observer.observe(node);
      return () => observer.disconnect();
    }
    // Older browsers retain lazy loading through scroll and resize checks.
    const check = () => {
      const box = node.getBoundingClientRect();
      setNearby(box.bottom >= -400 && box.top <= window.innerHeight + 400);
    };
    check();
    window.addEventListener('scroll', check, { passive: true, capture: true });
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('scroll', check, true);
      window.removeEventListener('resize', check);
    };
  }, []);
  return { ref, nearby };
}
