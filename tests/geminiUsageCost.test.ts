import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildDailyCostSeries,
  buildHourlyCostSeries,
  calculateCost,
  calculateTotalCost,
  collectUsageDetails,
  collectUsageDetailsWithEndpoint,
  getApiStats,
  getModelStats,
  normalizeUsageData,
  type ModelPrice,
  type UsageDetail,
} from '../src/utils/usage';
import { DEFAULT_TIER_MULTIPLIERS, setActiveTierMultipliers } from '../src/utils/tierMultiplier';

const model = 'routed-model';
const prices: Record<string, ModelPrice> = {
  [model]: { input: 0, output: 10, cacheCreate: 0, cacheRead: 0 },
};
const detail = (overrides: Partial<UsageDetail> = {}): UsageDetail => ({
  timestamp: new Date().toISOString(),
  source: 'fixture',
  auth_index: 'fixture-auth',
  provider: 'gemini',
  __modelName: model,
  tokens: {
    input_tokens: 0,
    output_tokens: 1_000,
    reasoning_tokens: 2_000,
    cached_tokens: 0,
    total_tokens: 3_000,
  },
  failed: false,
  ...overrides,
});

afterEach(() => setActiveTierMultipliers([...DEFAULT_TIER_MULTIPLIERS]));

describe('Gemini output billing', () => {
  test.each(['gemini', 'gemini-interactions', 'gemini-cli', 'vertex', 'aistudio', 'antigravity'])(
    'includes separately reported thinking tokens for %s, including model aliases',
    (provider) => {
      expect(calculateCost(detail({ provider }), prices)).toBeCloseTo(0.03, 10);
    }
  );

  test('recognizes the native executor when the provider is absent', () => {
    expect(
      calculateCost(detail({ provider: undefined, executor_type: ' GeminiExecutor ' }), prices)
    ).toBeCloseTo(0.03, 10);
  });

  test.each(['openai', 'codex', 'claude', 'anthropic', 'xai', 'unknown', undefined])(
    'does not add reasoning to an already combined or unknown output total for %s',
    (provider) => {
      expect(calculateCost(detail({ provider }), prices)).toBeCloseTo(0.01, 10);
    }
  );

  test('does not infer accounting from a Gemini model name on an OpenAI connection', () => {
    const gemini = detail({ provider: 'openai-compatibility', __modelName: 'gemini-2.5-pro' });
    expect(calculateCost(gemini, { 'gemini-2.5-pro': prices[model] })).toBeCloseTo(0.01, 10);
  });

  test.each(['gemini', 'vertex', 'custom-gemini-provider'])(
    'prioritizes the OpenAI-compatible executor over the %s provider name',
    (provider) => {
      expect(
        calculateCost(detail({ provider, executor_type: ' OpenAICompatExecutor ' }), prices)
      ).toBeCloseTo(0.01, 10);
    }
  );

  test.each(['openai-compatibility', 'openai-compatible-gemini'])(
    'preserves subset accounting for %s',
    (provider) => {
      expect(calculateCost(detail({ provider }), prices)).toBeCloseTo(0.01, 10);
    }
  );

  test.each([[42], [{}], [['gemini']]])(
    'tolerates malformed provider and executor metadata: %p',
    (value) => {
      expect(
        calculateCost(detail({ provider: value as string, executor_type: value as string }), prices)
      ).toBeCloseTo(0.01, 10);
    }
  );

  test.each([undefined, null, -1, NaN, Infinity, 'invalid'])(
    'ignores unusable thinking counts without losing valid output cost: %p',
    (reasoningTokens) => {
      const record = detail();
      record.tokens.reasoning_tokens = reasoningTokens as number;
      expect(calculateCost(record, prices)).toBeCloseTo(0.01, 10);
    }
  );

  test('charges thinking-only responses', () => {
    const record = detail();
    record.tokens.output_tokens = 0;
    expect(calculateCost(record, prices)).toBeCloseTo(0.02, 10);
  });

  test('uses the context output price and applies the service tier to the complete cost', () => {
    const record = detail({ service_tier: 'priority' });
    record.tokens.input_tokens = 1_000;
    record.tokens.cached_tokens = 200;
    record.tokens.cache_creation_tokens = 100;
    const tieredPrices = {
      [model]: {
        ...prices[model],
        contextTiers: [{ threshold: 999, input: 4, output: 20, cacheRead: 1, cacheCreate: 5 }],
      },
    };
    setActiveTierMultipliers([{ model, tier: 'priority', multiplier: 2 }]);

    // 700 input + 200 cache reads + 100 cache writes + 3,000 output tokens, then x2.
    expect(calculateCost(record, tieredPrices)).toBeCloseTo(0.127, 10);
  });

  test('keeps executor accounting through plugin normalization and every cost summary', () => {
    const native = { ...detail(), executor_type: ' GeminiExecutor ' };
    const compat = { ...detail(), executor_type: ' OpenAICompatExecutor ' };
    const normalized = normalizeUsageData({ 'fixture-key': { [model]: [native, compat] } });
    const records = collectUsageDetails(normalized);

    expect(records.map((record) => record.executor_type)).toEqual([
      'GeminiExecutor',
      'OpenAICompatExecutor',
    ]);
    expect(
      collectUsageDetailsWithEndpoint(normalized).map((record) => record.executor_type)
    ).toEqual(['GeminiExecutor', 'OpenAICompatExecutor']);
    expect(calculateTotalCost(normalized, prices)).toBeCloseTo(0.04, 10);
    expect(getApiStats(normalized, prices)[0].totalCost).toBeCloseTo(0.04, 10);
    expect(getModelStats(normalized, prices)[0].cost).toBeCloseTo(0.04, 10);
    expect(
      buildHourlyCostSeries(normalized, prices).data.reduce((sum, cost) => sum + cost, 0)
    ).toBeCloseTo(0.04, 10);
    expect(
      buildDailyCostSeries(normalized, prices).data.reduce((sum, cost) => sum + cost, 0)
    ).toBeCloseTo(0.04, 10);
  });
});
