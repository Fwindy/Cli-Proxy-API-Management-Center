import { describe, expect, test } from 'bun:test';
import { buildKimiQuotaRows } from '@/utils/quota';

describe('Kimi quota ordering', () => {
  test('shows the 5-hour limit before the weekly limit', () => {
    const rows = buildKimiQuotaRows({
      usage: {
        used: 200,
        limit: 1000,
      },
      limits: [
        {
          detail: {
            used: 20,
            limit: 100,
          },
          window: {
            duration: 300,
            timeUnit: 'MINUTES',
          },
        },
      ],
    });

    expect(rows.map(({ id }) => id)).toEqual(['limit-0', 'summary']);
    expect(rows[0]?.labelKey).toBe('kimi_quota.limit_window');
    expect(rows[0]?.labelParams).toEqual({ duration: '5h' });
    expect(rows[1]?.labelKey).toBe('kimi_quota.weekly_limit');
  });
});
