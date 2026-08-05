/**
 * Reusable transactional-email wrapper over the Resend Node SDK (issue #101).
 * Best-effort and NEVER throws: a Resend `{ error }` or a thrown transport error
 * is logged and surfaced as `false`, so a mail failure can never fail the write
 * that triggered it (ADR 0001). The Resend client and `firebase-functions/params`
 * config are lazy-loaded and both `from` and the transport are injectable, so
 * this module has no heavy top-level imports and is unit-testable without a
 * Functions runtime or a live key.
 */

/** Payload passed to Resend's `emails.send`. */
export interface EmailPayload {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text?: string;
  /**
   * Extra RFC 5322 headers. Added for the daily engagement email's
   * `List-Unsubscribe` / `List-Unsubscribe-Post` pair (#616), which is what
   * makes a mail client surface its own native unsubscribe control — a header,
   * not a body link, so it cannot be expressed any other way. Omitted entirely
   * when absent, so the moderation notifier's payload is byte-identical to
   * before.
   */
  headers?: Record<string, string>;
}

/** The transport seam — the real one calls `new Resend(...).emails.send`. */
export type EmailSender = (
  payload: EmailPayload,
  opts: { idempotencyKey: string },
) => Promise<{ error: unknown }>;

export interface SendEmailArgs {
  to: string[];
  subject: string;
  html: string;
  text?: string;
  idempotencyKey: string;
  /** Extra RFC 5322 headers — see `EmailPayload.headers` (#616). */
  headers?: Record<string, string>;
  /** Override the `EMAIL_FROM` param default (mainly for tests). */
  from?: string;
  /** Override the Resend transport (mainly for tests). */
  sender?: EmailSender;
}

/**
 * Send one email to one or more recipients. Returns `true` on a clean send,
 * `false` on any Resend error or thrown transport error. Never throws.
 */
export async function sendEmail(args: SendEmailArgs): Promise<boolean> {
  // The ENTIRE real-path setup — param/secret resolution and Resend
  // construction — sits inside the try, so a setup failure (e.g. an unresolved
  // RESEND_API_KEY) returns false instead of rejecting. That keeps the
  // never-throw contract for every caller, not just the moderation trigger with
  // its own outer catch (#101 Codex R3 F3).
  try {
    let from = args.from;
    let send = args.sender;
    if (!send || from === undefined) {
      // Only the real (non-injected) path — inside the Functions runtime.
      const { RESEND_API_KEY, EMAIL_FROM } = await import('./params');
      if (from === undefined) from = EMAIL_FROM.value();
      if (!send) {
        const apiKey = RESEND_API_KEY.value(); // throws here if the secret is unresolved
        const { Resend } = await import('resend');
        const client = new Resend(apiKey);
        send = (payload, opts) => client.emails.send(payload, opts) as Promise<{ error: unknown }>;
      }
    }
    const payload: EmailPayload = {
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      // Spread rather than assigned: an `headers: undefined` key would reach
      // Resend's JSON body as an explicit null on some serializers.
      ...(args.headers ? { headers: args.headers } : {}),
    };
    const { error } = await send(payload, { idempotencyKey: args.idempotencyKey });
    if (error) {
      console.error('resend send failed', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('resend send failed (setup or transport)', err);
    return false;
  }
}
