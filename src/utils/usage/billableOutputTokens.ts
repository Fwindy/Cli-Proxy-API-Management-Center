import type { UsageDetail } from '../usage';

const SEPARATE_REASONING_MARKERS = ['gemini', 'aistudio', 'antigravity', 'vertex', 'interaction'];

const normalizeSource = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const nonNegativeTokens = (value: unknown): number => {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(count, 0) : 0;
};

/** Follow the host's provider/executor accounting, including aliased Gemini models. */
export function getBillableOutputTokens(
  detail: Pick<UsageDetail, 'provider' | 'executor_type' | 'tokens'>
): number {
  const output = nonNegativeTokens(detail.tokens.output_tokens);
  const provider = normalizeSource(detail.provider);
  const executor = normalizeSource(detail.executor_type);
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
  return output + (separateReasoning ? nonNegativeTokens(detail.tokens.reasoning_tokens) : 0);
}
