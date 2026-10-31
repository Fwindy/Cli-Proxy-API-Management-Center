import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { getDefaultSyncSettings, syncPrices, type SyncSettings } from '@/utils/priceSync';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const price = { input: 2, output: 12, cache_write: 2.5, cache_read: 0.2 };

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

async function syncFixture(
  modelNames: string[],
  catalog: Record<string, unknown>,
  settings: SyncSettings = getDefaultSyncSettings()
) {
  const request = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(catalog));
  try {
    return await syncPrices(modelNames, settings);
  } finally {
    request.mockRestore();
  }
}

describe('price sync model matching', () => {
  test('syncs base and ignored-suffix variants together when only the base model has a price', async () => {
    const result = await syncFixture(
      ['gemini-4-argon', 'gemini-4-argon-high', 'gemini-4-argon-low'],
      { google: { models: { 'gemini-4-argon': { cost: price } } } }
    );

    expect(result.matchedCount).toBe(3);
    expect(result.totalModels).toBe(3);
    expect(result.prices['gemini-4-argon-high']).toEqual(result.prices['gemini-4-argon']);
    expect(result.prices['gemini-4-argon-low']).toEqual(result.prices['gemini-4-argon']);
    expect(result.prices['gemini-4-argon']).toEqual({
      input: 2,
      output: 12,
      cacheCreate: 2.5,
      cacheRead: 0.2,
    });
  });

  test('syncs an ignored-suffix variant when the base name has no usage records', async () => {
    const result = await syncFixture(['gemini-4-argon-high'], {
      google: { models: { 'gemini-4-argon': { cost: price } } },
    });

    expect(result.matchedCount).toBe(1);
    expect(result.prices['gemini-4-argon-high'].input).toBe(2);
  });

  test.each([false, true])(
    'preserves distinct exact prices regardless of source order (reversed: %s)',
    async (reversed) => {
      const models = [
        ['gemini-4-argon', { cost: price }],
        ['gemini-4-argon-high', { cost: { input: 3, output: 18 } }],
      ];
      const result = await syncFixture(['gemini-4-argon', 'gemini-4-argon-high'], {
        google: { models: Object.fromEntries(reversed ? models.reverse() : models) },
      });

      expect(result.prices['gemini-4-argon'].input).toBe(2);
      expect(result.prices['gemini-4-argon-high'].input).toBe(3);
    }
  );

  test('preserves provider priority when filling ignored-suffix variants', async () => {
    const result = await syncFixture(['gemini-4-argon', 'gemini-4-argon-high'], {
      google: { models: { 'gemini-4-argon': { cost: price } } },
      reseller: { models: { 'gemini-4-argon-high': { cost: { input: 99 } } } },
    });

    expect(result.prices['gemini-4-argon'].input).toBe(2);
    expect(result.prices['gemini-4-argon-high'].input).toBe(2);
  });

  test('does not copy prices to variants unless their suffix is configured', async () => {
    const settings = { ...getDefaultSyncSettings(), ignoredModelNameSuffixes: ['-preview'] };
    const result = await syncFixture(
      ['gemini-4-argon', 'gemini-4-argon-high'],
      { google: { models: { 'gemini-4-argon': { cost: price } } } },
      settings
    );

    expect(result.matchedCount).toBe(1);
    expect(result.prices['gemini-4-argon-high']).toBeUndefined();
  });
});
