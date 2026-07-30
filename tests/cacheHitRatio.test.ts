import { describe, expect, test } from 'bun:test';
import { calculateCacheHitRatio } from '../src/utils/usage';

describe('cache hit ratio', () => {
  test('uses context total as the denominator for Anthropic long-context turns', () => {
    // Real record: a Claude continuation turn whose 209,115-token context was
    // fully served from cache, leaving only 2 newly-billed input tokens.
    // Dividing by input_tokens alone produced 10,455,750%.
    const ratio = calculateCacheHitRatio({
      provider: 'claude',
      inputTokens: 2,
      cacheReadTokens: 209_115,
      cacheCreationTokens: 1_487,
    });

    expect(ratio).not.toBeNull();
    expect(ratio! * 100).toBeLessThanOrEqual(100);
    expect((ratio! * 100).toFixed(1)).toBe('99.3');
  });

  test('treats input_tokens as the total for non-Anthropic providers', () => {
    // OpenAI-style accounting: input_tokens already includes cached tokens,
    // so the denominator stays equal to input_tokens.
    const ratio = calculateCacheHitRatio({
      provider: 'openai',
      inputTokens: 1_000,
      cacheReadTokens: 800,
      cacheCreationTokens: 0,
    });

    expect(ratio).toBe(0.8);
  });

  test('never exceeds 100% for either accounting style', () => {
    const anthropic = calculateCacheHitRatio({
      provider: 'anthropic',
      inputTokens: 0,
      cacheReadTokens: 50_000,
      cacheCreationTokens: 0,
    });
    expect(anthropic).toBe(1);

    const openai = calculateCacheHitRatio({
      provider: 'gpt-5',
      inputTokens: 50_000,
      cacheReadTokens: 50_000,
      cacheCreationTokens: 0,
    });
    expect(openai).toBe(1);
  });

  test('returns null when there is no context to measure', () => {
    expect(
      calculateCacheHitRatio({
        provider: 'claude',
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })
    ).toBeNull();
  });

  test('reports zero when nothing was served from cache', () => {
    expect(
      calculateCacheHitRatio({
        provider: 'claude',
        inputTokens: 1_200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      })
    ).toBe(0);
  });

  test('clamps negative inputs instead of producing a negative ratio', () => {
    expect(
      calculateCacheHitRatio({
        provider: 'claude',
        inputTokens: -5,
        cacheReadTokens: 100,
        cacheCreationTokens: -3,
      })
    ).toBe(1);
  });
});
