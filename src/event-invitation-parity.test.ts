// The browser cannot import the Functions decision layer at runtime because it
// pulls in node:crypto. This test pins the URL-borne bearer primitives across
// the two TypeScript programs so a server change cannot leave the credential
// visible in the browser URL past the pre-telemetry capture gate.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./firebase', () => ({ functions: {} }));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn() }));

import {
  EVENT_INVITATION_EVENT_ID_PATTERN as SERVER_EVENT_ID_PATTERN,
  EVENT_INVITATION_FRAGMENT_KEY as SERVER_FRAGMENT_KEY,
  EVENT_INVITATION_ID_PATTERN as SERVER_INVITATION_ID_PATTERN,
  EVENT_INVITATION_MAX_EVENT_ID_LENGTH as SERVER_MAX_EVENT_ID_LENGTH,
  EVENT_INVITATION_TOKEN_PATTERN as SERVER_TOKEN_PATTERN,
} from '../functions/src/eventInvitations';
import {
  EVENT_INVITATION_FRAGMENT_KEY as CLIENT_FRAGMENT_KEY,
  EVENT_INVITATION_TOKEN_PATTERN as CLIENT_TOKEN_PATTERN,
} from './pendingEventInvitation';
import {
  EVENT_INVITATION_EVENT_ID_PATTERN as CLIENT_EVENT_ID_PATTERN,
  EVENT_INVITATION_ID_PATTERN as CLIENT_INVITATION_ID_PATTERN,
  EVENT_INVITATION_MAX_EVENT_ID_LENGTH as CLIENT_MAX_EVENT_ID_LENGTH,
} from './data/eventInvitations';

describe('Event Invitation client/server wire parity', () => {
  it('uses the same fragment key at mint and pre-telemetry capture', () => {
    expect(CLIENT_FRAGMENT_KEY).toBe(SERVER_FRAGMENT_KEY);
  });

  it('uses the same bearer shape at mint, capture, and redemption', () => {
    expect(CLIENT_TOKEN_PATTERN.source).toBe(SERVER_TOKEN_PATTERN.source);
    expect(CLIENT_TOKEN_PATTERN.flags).toBe(SERVER_TOKEN_PATTERN.flags);
  });

  it('uses the same Event and management-id shapes at every callable boundary', () => {
    expect(CLIENT_EVENT_ID_PATTERN.source).toBe(SERVER_EVENT_ID_PATTERN.source);
    expect(CLIENT_EVENT_ID_PATTERN.flags).toBe(SERVER_EVENT_ID_PATTERN.flags);
    expect(CLIENT_INVITATION_ID_PATTERN.source).toBe(SERVER_INVITATION_ID_PATTERN.source);
    expect(CLIENT_INVITATION_ID_PATTERN.flags).toBe(SERVER_INVITATION_ID_PATTERN.flags);
    expect(CLIENT_MAX_EVENT_ID_LENGTH).toBe(SERVER_MAX_EVENT_ID_LENGTH);
  });
});
