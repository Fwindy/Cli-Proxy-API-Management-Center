import { extractLatencyMs } from './latency';

// Devin also reports Interactions usage, with output and reasoning as separate buckets.
const SEPARATE_REASONING_MARKERS = [
  'gemini',
  'aistudio',
  'antigravity',
  'vertex',
  'interaction',
  'devin',
];

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const normalizeSource = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const nonNegativeTokens = (value: unknown): number => {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(count, 0) : 0;
};

/** One generated-output count for pricing and TPS, based on the upstream transport. */
export function getUsageOutputTokens(detail: unknown): number {
  const record = asRecord(detail);
  const tokens = asRecord(record.tokens);
  const output = nonNegativeTokens(tokens.output_tokens);
  const provider = normalizeSource(record.provider);
  const executor = normalizeSource(record.executor_type);
  // Vertex and custom providers can delegate to OpenAI-compatible transport,
  // where output_tokens already includes reasoning_tokens.
  if (
    executor === 'openaicompatexecutor' ||
    provider === 'openai-compatibility' ||
    provider.startsWith('openai-compatible-')
  ) {
    return output;
  }

  const source = `${provider} ${executor}`;
  if (source.includes('claude') || source.includes('anthropic')) return output;
  const separateReasoning = SEPARATE_REASONING_MARKERS.some((marker) => source.includes(marker));
  return output + (separateReasoning ? nonNegativeTokens(tokens.reasoning_tokens) : 0);
}

/** Keep total request duration (including TTFT) as the denominator for every channel. */
export function calculateOutputTps(detail: unknown): number | null {
  const latencyMs = extractLatencyMs(detail);
  if (latencyMs === null || latencyMs <= 0) return null;
  const tps = getUsageOutputTokens(detail) / (latencyMs / 1000);
  return Number.isFinite(tps) ? tps : null;
}
