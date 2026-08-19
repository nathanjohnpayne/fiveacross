/** Firestore surfaces create collisions differently across the Admin SDK,
 * gRPC layers, and emulators. Keep recognition here; callers still decide what
 * an existing document means at their own boundary. */
export function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 6 || code === '6') return true;
  if (typeof code === 'string' && code.replaceAll('_', '-').toLowerCase() === 'already-exists') return true;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && /(?:already[ _-]?exists|\b6\s+already_exists\b)/i.test(message);
}
