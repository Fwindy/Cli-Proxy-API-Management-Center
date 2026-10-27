import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { usageApi } from '../src/services/api/usage';
import { useUsageStatsStore } from '../src/stores/useUsageStatsStore';
import { getDefaultSyncSettings, syncPrices } from '../src/utils/priceSync';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const restorers: (() => void)[] = [];

afterEach(() => {
  restorers
    .splice(0)
    .reverse()
    .forEach((restore) => restore());
  useUsageStatsStore.getState().clearUsageStats();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('fork error diagnostics', () => {
  test('retains the usage request failure and its user-facing message', async () => {
    useUsageStatsStore.getState().clearUsageStats();
    const failure = new Error('Usage fixture unavailable');
    const request = spyOn(usageApi, 'getUsage').mockRejectedValue(failure);
    restorers.push(() => request.mockRestore());

    const result = await useUsageStatsStore
      .getState()
      .loadUsageStats({ force: true, fullRange: true })
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({ message: failure.message, cause: failure });
    expect(Object.keys(result as Error)).not.toContain('cause');
    expect(useUsageStatsStore.getState()).toMatchObject({
      loading: false,
      error: failure.message,
    });
  });

  test('retains the abort behind the price-sync timeout message', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { setTimeout, clearTimeout },
    });
    const failure = new DOMException('Price fixture aborted', 'AbortError');
    const request = spyOn(globalThis, 'fetch').mockRejectedValue(failure);
    restorers.push(() => request.mockRestore());

    const result = await syncPrices(['fixture-model'], getDefaultSyncSettings()).catch(
      (error: unknown) => error
    );

    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({ message: '价格源请求超时，请稍后重试', cause: failure });
    expect(Object.keys(result as Error)).not.toContain('cause');
  });
});
