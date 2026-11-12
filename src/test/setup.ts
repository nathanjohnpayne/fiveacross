// Vitest setup for the jsdom "app" project. Registers @testing-library/jest-dom
// matchers (toBeInTheDocument, toHaveTextContent, …) on Vitest's `expect` and
// augments its Assertion types, and auto-cleans the RTL DOM after each test.
// First: React DOM reads `window.AnimationEvent` when it loads (see the module).
import './jsdom-animation-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

function clearBrowserStorage() {
  try {
    localStorage?.clear();
  } catch {
    /* storage can be absent or disabled in Node/jsdom variants */
  }
  try {
    sessionStorage?.clear();
  } catch {
    /* storage can be absent or disabled in Node/jsdom variants */
  }
}

beforeEach(() => {
  clearBrowserStorage();
});

afterEach(() => {
  cleanup();
  clearBrowserStorage();
});
