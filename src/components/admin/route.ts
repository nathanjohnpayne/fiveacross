import { matchPath } from 'react-router';

/**
 * The admin console's route vocabulary (specs/admin-console-ia.md § "Routes").
 * Firestore-free and component-free so More can resolve "is the admin open?"
 * without importing the console itself (whose module tests routinely mock).
 */
export const ADMIN_SECTIONS = ['queue', 'settings', 'schedule', 'pool', 'players', 'messages'] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/**
 * Resolve an app pathname to an admin surface: `'hub'` for `/more/admin`, a
 * section id for `/more/admin/<section>`, and `null` for anything outside the
 * admin (More uses that to decide whether the console is open at all). An
 * unknown section segment resolves to `'hub'` — a stale or mistyped deep link
 * lands on the hub rather than a dead end.
 */
export function adminSectionFromPath(pathname: string): AdminSection | 'hub' | null {
  if (matchPath('/more/admin', pathname)) return 'hub';
  const section = matchPath('/more/admin/:section', pathname)?.params.section;
  if (!section) return matchPath('/more/admin/*', pathname) ? 'hub' : null;
  return (ADMIN_SECTIONS as readonly string[]).includes(section) ? (section as AdminSection) : 'hub';
}
