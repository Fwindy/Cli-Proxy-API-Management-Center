import { afterEach, describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { CODEX_CONFIG } from '@/features/quota/providers/codex/data';
import { apiCallApi, type ApiCallResult } from '@/services/api/apiCall';
import type { CodexUsagePayload } from '@/types';
import { fetchCodexQuotaWithMeta } from '@/utils/codexQuotaMeta';
import { CODEX_RATE_LIMIT_RESET_CREDITS_URL, CODEX_USAGE_URL } from '@/utils/quota';

const t = ((key: string) => key) as TFunction;
const originalRequest = apiCallApi.request;

const result = (body: unknown): ApiCallResult => ({
  statusCode: 200,
  header: {},
  bodyText: JSON.stringify(body),
  body,
});

afterEach(() => {
  apiCallApi.request = originalRequest;
});

describe('fork Codex quota metadata adapter', () => {
  test.each([
    { credits: { balance: ' 42.50 ', unlimited: false }, balance: '42.50', unlimited: false },
    { credits: { balance: 125.5, unlimited: true }, balance: '125.5', unlimited: true },
    { credits: { unlimited: true }, balance: null, unlimited: true },
    { credits: undefined, balance: null, unlimited: false },
  ])('preserves upstream account credits and fork window metadata: %j', async (entry) => {
    const payload: CodexUsagePayload = {
      plan_type: 'pro',
      credits: entry.credits,
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_at: 1_800_000_000,
        },
      },
    };
    apiCallApi.request = async (request) => {
      if (request.url === CODEX_USAGE_URL) return result(payload);
      if (request.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL) {
        return result({ available_count: 0, credits: [] });
      }
      throw new Error(`Unexpected request: ${request.url}`);
    };

    const { data, meta } = await fetchCodexQuotaWithMeta(
      { name: 'fork-codex.json', type: 'codex', auth_index: 'test-index' },
      t
    );
    const state = CODEX_CONFIG.buildSuccessState(data);

    expect(state.creditBalance).toBe(entry.balance);
    expect(state.creditsUnlimited).toBe(entry.unlimited);
    expect(state.planType).toBe('pro');
    expect(state.windows[0]?.usedPercent).toBe(25);
    expect(meta.windows['five-hour']).toEqual({
      resetAtUnix: 1_800_000_000,
      windowSeconds: 18_000,
      windowKind: 'five-hour',
    });
    expect(meta.refreshedAtMs).toBeGreaterThan(0);
  });
});
