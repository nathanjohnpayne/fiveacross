// The join code (#1934, PRD Decision 2): the Event Slug a native player types
// because a native app has no Event hostname to resolve from.
//
// The owner decided on 2026-10-20 that a join code gets NO record of its own.
// It names the Event's hostname in the canonical Namespace, and the native
// client resolves it through that hostname's existing `publicHostnames/{host}`
// projection (specs/hostnames-lookup.md § Join codes). That one decision is why
// this module is a pure mapping and nothing else: the public-read Rules, the
// field allowlist, the `list` denial and the adult-posture stamp all already
// cover that document, so a join-code lookup inherits every one of them instead
// of needing a parallel copy that could drift.
//
// The accepted cost: an Event is joinable by code only if it has a
// `<slug>.fiveacross.app` hostname record.

import { CANONICAL_NAMESPACE_APEX } from './editions';
import { normalizeSlug, validateSlug, type SlugRejection } from './slug';

export type JoinCodeCheck =
  | { ok: true; slug: string; hostname: string }
  | { ok: false; reason: SlugRejection };

/**
 * Map what a player typed to the hostname whose public projection resolves it.
 *
 * Typing is folded with `normalizeSlug` (trim, lowercase), because a join code
 * arrives from a form, and that is the one place normalization belongs. The
 * folded candidate then has to pass the same strict `validateSlug` the wizard
 * and the edge router apply. A code the router would refuse as a first label
 * (a reserved label, an `r2-` rehearsal label, a malformed Slug) is refused
 * here before any read, so a join screen can never be used to read a document
 * the Namespace guard would never serve.
 *
 * The result is a `hostnameKey`-shaped document key: lowercase, no root dot.
 * The native live posture watcher keys on the same hostname
 * (`publicHostnames/{hostname}`), so the record that resolved the Event and the
 * record watched for a posture rise are one document.
 */
export function joinCodeHostname(input: string): JoinCodeCheck {
  const check = validateSlug(normalizeSlug(input));
  if (!check.ok) return check;
  return { ok: true, slug: check.slug, hostname: `${check.slug}.${CANONICAL_NAMESPACE_APEX}` };
}
