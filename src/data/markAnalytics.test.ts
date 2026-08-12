import { describe, expect, it } from 'vitest';
import { directMarkAnalyticsRequest } from './markAnalytics';

describe('direct-mark analytics requests', () => {
  it('carries the exact direct action metadata while leaving the durable identity to the server transition', () => {
    expect(
      directMarkAnalyticsRequest({ cellIndex: 4, marked: true, mode: 'honor', id: 'request-1' }),
    ).toEqual({ id: 'request-1', cellIndex: 4, marked: true, mode: 'honor', source: 'pledge' });
  });
});
