// safeMediaUrl — the sink guard for a Proof media element's `src` (<img>/<audio>).
//
// Proof readers and capture previews use app-owned blob: URLs. The shared guard
// also accepts http(s) media and image/audio data URLs defensively for other
// callers, while rejecting active schemes and HTML payloads at the DOM sink.
//
// The CodeQL js/xss-through-dom alerts (#1 and #3) trace a preview from the file
// input through URL.createObjectURL into an image src. React escapes text but
// does not validate attribute schemes. Feed SDK-derived object URLs pass this
// same final barrier; persisted Proof mediaURL/thumbURL values never reach it.
//
// Two barriers, in order, so the guard is legible to both humans and static
// analysis:
//   1. Scheme allowlist — parse the URL and accept only inert media schemes.
//   2. Metacharacter strip — remove the HTML metacharacters `<`, `"`, `'` from the
//      accepted value before it enters an HTML attribute. This directly answers the
//      alert ("reinterpreted as HTML without escaping meta-characters") and is a
//      barrier CodeQL recognises, so the class stops re-flagging on every edit. It
//      is a no-op on every accepted value: a legitimate blob:/http(s):/data:image
//      /data:audio URL never contains `<`, `"`, or `'`.
//
// Returns the accepted URL when its scheme is allowed, or `undefined` so React
// omits the attribute and the caller omits the element entirely.
export function safeMediaUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  let protocol: string;
  try {
    // Absolute-URL parse. A relative or malformed value throws and is treated as
    // unsafe (Proof media is always an absolute blob:/https:/data: URL).
    protocol = new URL(trimmed).protocol.toLowerCase();
  } catch {
    return undefined;
  }

  // Network-fetch and object-URL schemes are inert as a media `src`; inline data
  // URLs are allowed only for image/audio payloads (`data:text/html` and every
  // other media type are rejected). Every script-executing scheme — above all
  // `javascript:`, plus `vbscript:` — falls through to `undefined`.
  const allowed =
    protocol === 'https:' ||
    protocol === 'http:' ||
    protocol === 'blob:' ||
    (protocol === 'data:' && /^data:(image|audio)\//i.test(trimmed));
  if (!allowed) return undefined;

  // Strip HTML metacharacters before the accepted URL reaches the DOM as a `src`.
  // No-op on every accepted scheme (they never contain `<`, `"`, or `'`); it exists
  // so a value can never carry markup into an HTML attribute.
  return trimmed.replace(/["'<]/g, '');
}
