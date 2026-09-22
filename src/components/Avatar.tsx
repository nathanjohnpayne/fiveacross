export default function Avatar({
  name,
  src,
  customPhoto,
  size,
}: {
  /** Nullable at runtime (#317): a Player row can exist WITHOUT its identity
   *  fields — `dealDayCard` USED to seed `players/{uid}` with only a
   *  `dayStats` bucket while `joinAndDeal`'s identity merge was still in
   *  flight (the race its fail-closed guard now refuses, #1158), pre-#1158
   *  rows of that shape persist, and a `{theme}`-only row a Player's Theme
   *  pick created has the same shape; the persistent cache can replay any of
   *  them as a later page's FIRST roster snapshot.
   *  `name.trim()` on that row threw during the Leaderboard render, and with
   *  no error boundary above it React unmounted the ENTIRE app — a blank
   *  screen for every viewer until the identity write landed. Render the `?`
   *  fallback instead, exactly like an empty name. */
  name: string | null | undefined;
  src: string | null;
  /** A custom-uploaded avatar URL — takes priority over `src` when set (see specs/w1-profile-avatar.md). */
  customPhoto?: string | null;
  size?: number;
}) {
  const initial = (name?.trim()[0] ?? '?').toUpperCase();
  const style = size ? { width: size, height: size } : undefined;
  const resolvedSrc = customPhoto || src;
  if (resolvedSrc) {
    return (
      <img
        className="avatar"
        style={style}
        src={resolvedSrc}
        alt={name ?? ''}
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div className="avatar" style={style}>
      {initial}
    </div>
  );
}
