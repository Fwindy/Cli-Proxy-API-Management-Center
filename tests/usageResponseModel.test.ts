import { describe, expect, test } from 'bun:test';
import {
  collectUsageDetails,
  collectUsageDetailsWithEndpoint,
  normalizeUsageData,
} from '../src/utils/usage';

const timestamp = '2026-10-27T10:00:00Z';
const pluginUsage = (detail: Record<string, unknown>) => ({
  'fixture-key': {
    'requested-model': [{ timestamp, tokens: { input_tokens: 5 }, ...detail }],
  },
});

describe('usage response models', () => {
  test('preserves the upstream response model through plugin normalization and collection', () => {
    const normalized = normalizeUsageData(
      pluginUsage({ response_model: ' upstream-model-20261027 ', alias: 'client-alias' })
    );
    const details = collectUsageDetails(normalized);
    expect(details).toHaveLength(1);
    expect(details[0].response_model).toBe('upstream-model-20261027');
    expect(details[0].__modelName).toBe('requested-model');
    expect(details[0].tokens.input_tokens).toBe(5);
    expect(collectUsageDetailsWithEndpoint(normalized)[0].response_model).toBe(
      'upstream-model-20261027'
    );
  });

  test.each([undefined, null, '', '   ', 12, { model: 'not-a-model-name' }])(
    'leaves unknown response models empty without substituting the request model: %p',
    (responseModel) => {
      const normalized = normalizeUsageData(pluginUsage({ response_model: responseModel }));
      const [detail] = collectUsageDetails(normalized);
      expect(detail.response_model).toBeUndefined();
      expect(detail.__modelName).toBe('requested-model');
      expect(collectUsageDetailsWithEndpoint(normalized)[0].response_model).toBeUndefined();
    }
  );

  test('preserves response models when collecting an existing normalized snapshot', () => {
    const snapshot = {
      apis: {
        'fixture-key': {
          models: {
            'requested-model': {
              details: [{ timestamp, response_model: 'upstream-model', tokens: {} }],
            },
          },
        },
      },
    };
    expect(collectUsageDetails(snapshot)[0].response_model).toBe('upstream-model');
    expect(collectUsageDetailsWithEndpoint(snapshot)[0].response_model).toBe('upstream-model');
  });
});
