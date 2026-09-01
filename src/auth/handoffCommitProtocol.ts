import type { FirebaseOptions } from 'firebase/app';
import type { HandoffAttemptIdentity } from './handoffAttemptFence';

export interface HandoffSessionCandidate {
  uid: string;
  refreshTokenDigest: string;
}

export type HandoffPageMessage =
  | {
      type: 'initialize';
      attempt: HandoffAttemptIdentity;
      firebaseOptions: FirebaseOptions;
      tenantId: string | null;
      emulatorUrl: string | null;
    }
  | { type: 'prepare'; attempt: HandoffAttemptIdentity; customToken: string }
  | { type: 'commit'; attempt: HandoffAttemptIdentity };

export type HandoffWorkerMessage =
  | { type: 'ready'; attempt: HandoffAttemptIdentity }
  | {
      type: 'prepared';
      attempt: HandoffAttemptIdentity;
      candidate: HandoffSessionCandidate;
    }
  | { type: 'commit-settled'; attempt: HandoffAttemptIdentity; succeeded: boolean }
  | {
      type: 'failed';
      attempt: HandoffAttemptIdentity;
      phase: 'initialize' | 'prepare' | 'protocol';
    };

export function sameHandoffAttempt(
  left: HandoffAttemptIdentity,
  right: HandoffAttemptIdentity,
): boolean {
  return left.transactionId === right.transactionId && left.ownerNonce === right.ownerNonce;
}

function attemptFrom(value: unknown): HandoffAttemptIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<HandoffAttemptIdentity>;
  return typeof candidate.transactionId === 'string' &&
    candidate.transactionId.length > 0 &&
    typeof candidate.ownerNonce === 'string' &&
    candidate.ownerNonce.length > 0
    ? { transactionId: candidate.transactionId, ownerNonce: candidate.ownerNonce }
    : null;
}

export function parseHandoffPageMessage(value: unknown): HandoffPageMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  const attempt = attemptFrom(message.attempt);
  if (attempt === null) return null;

  if (message.type === 'commit') return { type: 'commit', attempt };
  if (
    message.type === 'prepare' &&
    typeof message.customToken === 'string' &&
    message.customToken.length > 0
  ) {
    return { type: 'prepare', attempt, customToken: message.customToken };
  }
  if (message.type !== 'initialize') return null;
  if (typeof message.firebaseOptions !== 'object' || message.firebaseOptions === null) return null;
  const firebaseOptions = message.firebaseOptions as FirebaseOptions;
  if (typeof firebaseOptions.apiKey !== 'string' || firebaseOptions.apiKey.length === 0) return null;
  if (message.tenantId !== null && typeof message.tenantId !== 'string') return null;
  if (message.emulatorUrl !== null && typeof message.emulatorUrl !== 'string') return null;
  return {
    type: 'initialize',
    attempt,
    firebaseOptions,
    tenantId: message.tenantId,
    emulatorUrl: message.emulatorUrl,
  };
}

export function parseHandoffWorkerMessage(value: unknown): HandoffWorkerMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  const attempt = attemptFrom(message.attempt);
  if (attempt === null) return null;
  if (message.type === 'ready') return { type: 'ready', attempt };
  if (message.type === 'commit-settled' && typeof message.succeeded === 'boolean') {
    return { type: 'commit-settled', attempt, succeeded: message.succeeded };
  }
  if (message.type === 'prepared') {
    if (typeof message.candidate !== 'object' || message.candidate === null) return null;
    const candidate = message.candidate as Partial<HandoffSessionCandidate> &
      Record<string, unknown>;
    if (
      Object.hasOwn(candidate, 'refreshToken') ||
      typeof candidate.uid !== 'string' ||
      candidate.uid.length === 0 ||
      typeof candidate.refreshTokenDigest !== 'string' ||
      candidate.refreshTokenDigest.length === 0
    ) {
      return null;
    }
    return {
      type: 'prepared',
      attempt,
      candidate: { uid: candidate.uid, refreshTokenDigest: candidate.refreshTokenDigest },
    };
  }
  if (
    message.type === 'failed' &&
    (message.phase === 'initialize' || message.phase === 'prepare' || message.phase === 'protocol')
  ) {
    return { type: 'failed', attempt, phase: message.phase };
  }
  return null;
}
