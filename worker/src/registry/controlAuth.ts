import {
  validateVerificationRecords,
  verifyPinnedSignature,
  type VerificationRecord,
  type VerificationRole,
} from './keys';
import { JwksUnavailableError, verifyGoogleOidc, type JwksResolver } from './oidc';

const MAX_SIGNATURE_AGE_MS = 60_000;

export class ControlAuthUnavailableError extends Error {}

export type PinnedRoleRequest = {
  role: VerificationRole;
  slot: string;
  keyVersion: string;
  token: string;
  signature: string;
  issuedAt: number;
  exactBytes: Uint8Array;
  audience: string;
};

export async function authenticatePinnedRole(
  request: PinnedRoleRequest,
  dependencies: {
    now: number;
    jwks: JwksResolver;
    verificationRecords: readonly VerificationRecord[];
  },
): Promise<VerificationRecord> {
  if (
    request.slot.length === 0 ||
    request.keyVersion.length === 0 ||
    request.token.length === 0 ||
    request.signature.length === 0 ||
    !Number.isSafeInteger(request.issuedAt) ||
    Math.abs(dependencies.now - request.issuedAt) > MAX_SIGNATURE_AGE_MS
  ) {
    throw new Error('unauthorized');
  }
  let records: readonly VerificationRecord[];
  try {
    records = await validateVerificationRecords(dependencies.verificationRecords);
  } catch {
    throw new ControlAuthUnavailableError('verification configuration unavailable');
  }
  const record = records.find(
    (candidate) =>
      candidate.role === request.role &&
      candidate.epochOrSlot === request.slot &&
      candidate.keyVersion === request.keyVersion,
  );
  if (record === undefined) throw new Error('unauthorized');
  try {
    await verifyGoogleOidc(
      request.token,
      { audience: request.audience, subject: record.subject },
      dependencies.jwks,
      dependencies.now,
    );
  } catch (error) {
    if (error instanceof JwksUnavailableError) {
      throw new ControlAuthUnavailableError('identity verification unavailable');
    }
    throw new Error('unauthorized');
  }
  if (!(await verifyPinnedSignature(record, request.exactBytes, request.signature))) {
    throw new Error('unauthorized');
  }
  return record;
}
