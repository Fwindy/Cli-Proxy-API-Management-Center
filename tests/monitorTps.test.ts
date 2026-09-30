import { describe, expect, test } from 'bun:test';
import { getModelStats } from '../src/utils/usage';

const getStats = (details: Record<string, unknown>[]) =>
  getModelStats(
    {
      apis: {
        'test-key': {
          models: {
            'test-model': { details },
          },
        },
      },
    },
    {}
  )[0];

describe('monitor TPS', () => {
  test('divides output tokens by total duration, including time to first token', () => {
    const stats = getStats([
      { latency_ms: 5_000, ttft_ms: 1_000, tokens: { output_tokens: 100 } },
    ]);

    expect(stats.averageTps).toBe(20);
    expect(stats.tpsSampleCount).toBe(1);
    expect(stats.averageLatencyMs).toBe(5_000);
    expect(stats.averageFirstByteLatencyMs).toBe(1_000);
  });

  test.each([undefined, 0, 5_000, 6_000])(
    'does not depend on time to first token being present or below total duration: %s',
    (ttftMs) => {
      const stats = getStats([
        { latency_ms: 5_000, ttft_ms: ttftMs, tokens: { output_tokens: 100 } },
      ]);

      expect(stats.averageTps).toBe(20);
      expect(stats.tpsSampleCount).toBe(1);
    }
  );

  test.each([undefined, null, 0, -1, NaN, Infinity, '', 'invalid'])(
    'excludes requests without a positive finite total duration: %s',
    (latencyMs) => {
      const stats = getStats([
        { latency_ms: latencyMs, ttft_ms: 1_000, tokens: { output_tokens: 100 } },
      ]);

      expect(stats.averageTps).toBeNull();
      expect(stats.tpsSampleCount).toBe(0);
    }
  );

  test('keeps the arithmetic mean of valid per-request TPS values', () => {
    const stats = getStats([
      { latency_ms: 5_000, ttft_ms: 1_000, tokens: { output_tokens: 100 } },
      { latency_ms: 1_000, ttft_ms: 900, tokens: { output_tokens: 80 } },
      { latency_ms: 0, tokens: { output_tokens: 900 } },
    ]);

    expect(stats.averageTps).toBe(50);
    expect(stats.tpsSampleCount).toBe(2);
  });

  test('keeps timed requests with zero output tokens in the average', () => {
    const stats = getStats([
      { latency_ms: 5_000, ttft_ms: 1_000, tokens: { output_tokens: 0 } },
      { latency_ms: 5_000, ttft_ms: 1_000, tokens: { output_tokens: 100 } },
    ]);

    expect(stats.averageTps).toBe(10);
    expect(stats.tpsSampleCount).toBe(2);
  });
});
