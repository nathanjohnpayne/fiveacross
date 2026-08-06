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
   * `Reply-To`. The Resend Node SDK spells this `replyTo` (camelCase) on the
   * SEND options — verified against the installed `resend@4.8.0` types, where
   * `CreateEmailOptions.replyTo?: string | string[]`. Do not "correct" it to
   * the `reply_to` that appears elsewhere in those same typings: that is the
   * RESPONSE shape (the `Email` object the API returns), and sending it as a
   * request field would be silently ignored rather than rejected.
   *
   * Omitted from the payload entirely when empty, so a deployment that
   * configures no reply address sends exactly what it sent before.
   */
  replyTo?: string;
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
  /** Override the `EMAIL_REPLY_TO` param default (mainly for tests). Resolved
   *  exactly like `from`: an explicit value wins, otherwise the param. */
  replyTo?: string;
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
    let replyTo = args.replyTo;
    let send = args.sender;
    if (!send || from === undefined) {
      // Only the real (non-injected) path — inside the Functions runtime.
      // `replyTo` resolves HERE, inside the same guard, rather than in its own:
      // a fully-injected caller (both `from` and `sender`) must stay free of
      // `firebase-functions`, which is the whole reason this block is
      // conditional. Widening the condition to `replyTo === undefined` would
      // drag the params module into every unit test that injects a transport.
      const { RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO } = await import('./params');
      if (from === undefined) from = EMAIL_FROM.value();
      if (replyTo === undefined) replyTo = EMAIL_REPLY_TO.value();
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
      // Resend's JSON body as an explicit null on some serializers. An EMPTY
      // `replyTo` is dropped by the same rule — the param's default is `''`,
      // and `Reply-To: ` with no address is a malformed header, not an absent
      // one.
      ...(replyTo ? { replyTo } : {}),
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
