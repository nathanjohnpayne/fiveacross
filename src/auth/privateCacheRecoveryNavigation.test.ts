import { describe, expect, it } from 'vitest';
import { applicationAfterRecoveryHref, isPrivateCacheRecoveryDocument, privateCacheRecoveryHref } from './privateCacheRecoveryNavigation';

describe('recovery document navigation', () => {
  it('changes the document query on entry and return while preserving the app path and unrelated query', () => {
    const app = 'https://event.example/more/admin?keep=visible#old-panel';
    const recovery = privateCacheRecoveryHref(app);
    expect(recovery).toBe('https://event.example/more/admin?keep=visible&device-cache-recovery=1');
    expect(isPrivateCacheRecoveryDocument(recovery)).toBe(true);
    expect(applicationAfterRecoveryHref(`${recovery}#old-panel`)).toBe('https://event.example/more/admin?keep=visible');
    // Removing a fragment alone is same-document navigation. Both transitions
    // instead change pathname+search, which makes the browser load entry again.
    expect(new URL(app).pathname + new URL(app).search).not.toBe(new URL(recovery).pathname + new URL(recovery).search);
    const returned = new URL(applicationAfterRecoveryHref(recovery));
    expect(returned.pathname + returned.search).not.toBe(new URL(recovery).pathname + new URL(recovery).search);
  });
  it.each(['', '?device-cache-recovery=0', '?device-cache-recovery=true', '#device-cache-recovery'])('does not select recovery for %s', suffix => {
    expect(isPrivateCacheRecoveryDocument(`https://event.example/${suffix}`)).toBe(false);
  });
});
