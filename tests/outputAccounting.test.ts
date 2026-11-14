import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { calculateTotalCost, getModelStats, normalizeUsageData } from '../src/utils/usage';
import { MonitorApiKeyStatsCard } from '../src/components/monitor/MonitorApiKeyStatsCard';
import { RequestEventsDetailsCard } from '../src/components/usage/RequestEventsDetailsCard';
import { outputAccountingCases } from './fixtures/outputAccounting';

const model = 'routed-model';
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: { getItem: () => null } },
  });
});
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

const prices = { [model]: { input: 0, output: 10, cacheRead: 0, cacheCreate: 0 } };
const recordFor = (fixture: (typeof outputAccountingCases)[number]) => ({
  id: 'fixture-event',
  timestamp: '2026-11-14T10:00:00Z',
  provider: fixture.provider,
  executor_type: fixture.executor_type,
  source: 'fixture',
  auth_index: 'fixture-auth',
  latency_ms: 5_000,
  ttft_ms: 1_000,
  tokens: {
    input_tokens: 0,
    output_tokens: fixture.output_tokens,
    reasoning_tokens: fixture.reasoning_tokens,
    cached_tokens: 0,
    total_tokens: 3_000,
  },
});
const usageFor = (records: ReturnType<typeof recordFor>[]) =>
  normalizeUsageData({ 'fixture-key': { [model]: records } });
const cells = (html: string) =>
  Array.from(
    (html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '').matchAll(/<td\b[^>]*>(.*?)<\/td>/g),
    (match) => match[1]
  );

describe('channel output accounting', () => {
  for (const fixture of outputAccountingCases) {
    test(`${fixture.name}: pricing and model TPS count the same generated output`, () => {
      const usage = usageFor([recordFor(fixture)]);
      expect(calculateTotalCost(usage, prices)).toBeCloseTo(0.03, 10);
      expect(getModelStats(usage, prices)[0]).toMatchObject({
        averageTps: 600,
        tpsSampleCount: 1,
        cost: 0.03,
      });
    });
  }

  test('retains the arithmetic mean of per-request TPS across channels', () => {
    const gemini = recordFor(
      outputAccountingCases.find((fixture) => fixture.provider === 'gemini')!
    );
    const openai = recordFor(outputAccountingCases[0]);
    openai.latency_ms = 10_000;
    const usage = usageFor([gemini, openai]);
    expect(getModelStats(usage, prices)[0].averageTps).toBe(450);
  });

  test('includes a thinking-only Gemini request in both cost and TPS', () => {
    const gemini = recordFor(
      outputAccountingCases.find((fixture) => fixture.provider === 'gemini')!
    );
    gemini.tokens.output_tokens = 0;
    const usage = usageFor([gemini]);
    expect(calculateTotalCost(usage, prices)).toBeCloseTo(0.02, 10);
    expect(getModelStats(usage, prices)[0].averageTps).toBe(400);
  });

  for (const fixture of outputAccountingCases) {
    test(`${fixture.name}: API key and request details show the same TPS`, () => {
      const usage = usageFor([recordFor(fixture)]);
      const apiKeyHtml = renderToStaticMarkup(
        createElement(MonitorApiKeyStatsCard, { usage, loading: false, modelPrices: prices })
      );
      const requestHtml = renderToStaticMarkup(
        createElement(RequestEventsDetailsCard, {
          usage,
          loading: false,
          geminiKeys: [],
          claudeConfigs: [],
          codexConfigs: [],
          vertexConfigs: [],
          openaiProviders: [],
          authFiles: [],
        })
      );
      expect(cells(apiKeyHtml)).toContain('600.00');
      expect(cells(requestHtml)).toContain('600.00');
      // Raw output and reasoning columns stay faithful to the upstream fields.
      expect(cells(requestHtml)).toContain(fixture.output_tokens.toLocaleString());
      expect(cells(requestHtml)).toContain('2,000');
    });
  }
});
