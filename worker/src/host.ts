// Namespace guard: the pure half of the router's "may this hostname reach the
// origin at all?" decision (#545, epic #529). Nothing here touches the network,
// so every branch below is provable without a runtime.
//
// This module answers a question about the ADDRESS only. Whether the Event at
// that address is servable is `resolve.ts`'s job, and whether the caller may
// read that Event's data is neither module's job — the Worker is a router and a
// namespace guard, NEVER an authorization layer, and the application still
// verifies membership before reading Event data.

import { isReservedLabel, validateSlug, type SlugRejection } from '../../src/slug';
import { hostnameKey } from '../../src/hostnameKey';

/**
 * The two Namespaces this router serves (#529 as amended 2026-08-17, #599).
 *
 * `fiveacross.app` is canonical — the host new Events provision against first.
 * `vacaybingo.com` serves in place alongside it: since #599 removed edge
 * canonicalization, an Event reachable at both addresses is SERVED at both,
 * with hostname resolution giving each host its correct Edition branding. There
 * is no alias-to-canonical bounce anywhere in this Worker, and adding one back
 * would re-break per-origin sessions, installed PWAs and offline storage.
 *
 * `fiveacrossbingo.com` is deliberately absent and must not be added. No Event
 * has ever been dealt from that origin, and the whole zone becomes a 301
 * redirect to `fiveacross.app` once #600 completes (#630). Routing a retired
 * brand name through the Event router would keep alive an origin whose entire
 * purpose is to stop existing.
 */
export const NAMESPACES: readonly string[] = ['fiveacross.app', 'vacaybingo.com'];

export type HostRejection =
  /** Not under any Namespace this router guards. */
  | 'out-of-namespace'
  /** More than one label above the apex — `a.b.fiveacross.app`. Never a valid
   *  Event address, and outside the wildcard certificate besides. */
  | 'nested-label'
  /** A reserved infrastructure label (`admin`, `d`, …). */
  | 'reserved-label'
  /** Shaped wrong for a Slug; `detail` carries which rule it broke. */
  | 'invalid-slug';

export type HostClass =
  /** The Namespace apex itself — `fiveacross.app`. A registered serving host
   *  with its own `hostnames/{host}` document, but no first label, so there is
   *  no Slug to validate or cross-check. */
  | { kind: 'apex'; host: string; namespace: string; slug: null }
  /** A wildcard Event address — `bodega-bay.fiveacross.app`. */
  | { kind: 'event'; host: string; namespace: string; slug: string }
  | { kind: 'rejected'; host: string; reason: HostRejection; detail?: SlugRejection };

/**
 * Reduce a Host header or URL hostname to the bytes the guard compares.
 *
 * Lowercased because DNS is case-insensitive and a Slug is stored lowercase;
 * a port stripped because a Host header legitimately carries one. Bracketed
 * IPv6 literals keep their brackets and simply fail the Namespace suffix test,
 * which is the correct outcome — an Event is never addressed by IP.
 */
function hostWithoutPort(rawHost: string): string {
  let host = rawHost.trim();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  const colon = host.indexOf(':');
  if (colon !== -1) host = host.slice(0, colon);
  return host;
}

export function normalizeHost(rawHost: string): string {
  return hostnameKey(hostWithoutPort(rawHost));
}

/** A DNS root dot is a different serialized web origin, even though it names
 * the same DNS resource. The router refuses it before lookup so the app never
 * mounts somewhere its exact-origin auth helper cannot safely complete. */
export function hasTrailingRootDot(rawHost: string): boolean {
  return hostWithoutPort(rawHost).endsWith('.');
}

/**
 * Classify a hostname against the Namespaces and the Slug contract.
 *
 * The reserved-label check runs BEFORE the lookup this classification feeds, and
 * that ordering is the namespace guard's whole point: it means no
 * `hostnames/{host}` document — however it got written — can ever publish an
 * Event on `admin.fiveacross.app`. Data cannot promote itself past the guard,
 * because the guard is decided before any data is read.
 */
export function classifyHost(rawHost: string, namespaces: readonly string[] = NAMESPACES): HostClass {
  const host = normalizeHost(rawHost);

  if (hasTrailingRootDot(rawHost)) {
    return { kind: 'rejected', host, reason: 'out-of-namespace' };
  }

  for (const namespace of namespaces) {
    if (host === namespace) {
      return { kind: 'apex', host, namespace, slug: null };
    }
    if (!host.endsWith(`.${namespace}`)) continue;

    const label = host.slice(0, host.length - namespace.length - 1);
    if (label.includes('.')) {
      return { kind: 'rejected', host, reason: 'nested-label' };
    }
    if (isReservedLabel(label)) {
      return { kind: 'rejected', host, reason: 'reserved-label' };
    }
    const check = validateSlug(label);
    if (!check.ok) {
      return { kind: 'rejected', host, reason: 'invalid-slug', detail: check.reason };
    }
    return { kind: 'event', host, namespace, slug: check.slug };
  }

  return { kind: 'rejected', host, reason: 'out-of-namespace' };
}
