import { matchPath } from 'react-router';
import type { SetupStep } from '../../types';
import { SETUP_STEP_ORDER } from './wizardSteps';

/**
 * The setup wizard's route vocabulary (specs/event-setup-wizard.md § "Shell &
 * navigation"). Mirrors `src/components/admin/route.ts`'s `matchPath`-based
 * parsing rather than a nested `<Routes>` tree — the established pattern in
 * this codebase for a route-driven sub-surface that mounts under one
 * top-level `<Route path="…/*">` (see `More.tsx`'s `adminSectionFromPath`).
 *
 * `/setup` (bare) always starts a FRESH draft — `SetupWizard`'s job, not
 * this module's. `/setup/:draftId/:step` is the one addressable shape a
 * reload or a deep link resumes from.
 */

export function isSetupStep(value: string | undefined): value is SetupStep {
  return !!value && (SETUP_STEP_ORDER as readonly string[]).includes(value);
}

export interface SetupRouteParams {
  draftId: string;
  step: SetupStep;
}

/** Parse `/setup/:draftId/:step`, or `null` for anything else (including the
 *  bare `/setup` index and any malformed subpath). */
export function setupRouteParams(pathname: string): SetupRouteParams | null {
  const match = matchPath('/setup/:draftId/:step', pathname);
  if (!match) return null;
  const { draftId, step } = match.params;
  if (!draftId || !isSetupStep(step)) return null;
  return { draftId, step };
}

/** Whether `pathname` is the bare wizard index (`/setup`, no draft/step). */
export function isSetupIndex(pathname: string): boolean {
  return matchPath('/setup', pathname) !== null;
}

export function setupStepPath(draftId: string, step: SetupStep): string {
  return `/setup/${draftId}/${step}`;
}
