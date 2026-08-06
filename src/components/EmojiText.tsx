import { segmentEmojiRuns } from '../format';

/**
 * Text that may carry emoji, rendered raster-safe (#603): each emoji run gets
 * its own `display: inline-block` span (`.emoji-run`, src/index.css) so
 * html-to-image's SVG `<foreignObject>` pass — used by BOTH the bug-report
 * screenshot capture (src/data/bugReports.ts) and the Share Cards
 * (src/components/ShareCard.tsx, which applies the same treatment in its own
 * DOM builder) — cannot mis-measure the glyph inside a shared text run and
 * paint it over the neighbouring characters. On-page rendering is unchanged:
 * an inline-block box around an emoji sits on the same baseline at the same
 * advance width.
 *
 * Use this for any on-page text run that mixes emoji with words and is
 * subject to screenshot capture (day chips, honors labels, and the like).
 */
export function EmojiText({ text }: { text: string }) {
  const runs = segmentEmojiRuns(text);
  if (runs.length === 1 && !runs[0].emoji) return <>{text}</>;
  return (
    <>
      {runs.map((run, i) =>
        run.emoji ? (
          <span key={i} className="emoji-run">
            {run.text}
          </span>
        ) : (
          run.text
        ),
      )}
    </>
  );
}
