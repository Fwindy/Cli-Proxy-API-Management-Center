// Matched to the host's native usage parsers, before response translation.
// Gemini/Devin use separate reasoning; OpenAI and Anthropic include it in output.
const separate = { output_tokens: 1_000, reasoning_tokens: 2_000 };
const included = { output_tokens: 3_000, reasoning_tokens: 2_000 };

export const outputAccountingCases = [
  {
    name: 'OpenAI Chat Completions',
    provider: 'openai',
    executor_type: 'OpenAICompatExecutor',
    ...included,
  },
  {
    name: 'OpenAI Responses / Codex',
    provider: 'codex',
    executor_type: 'CodexExecutor',
    ...included,
  },
  { name: 'Codex WebSocket', provider: 'codex', executor_type: 'CodexAutoExecutor', ...included },
  { name: 'Anthropic Messages', provider: 'claude', executor_type: 'ClaudeExecutor', ...included },
  {
    name: 'Anthropic provider alias',
    provider: 'anthropic',
    executor_type: 'ClaudeExecutor',
    ...included,
  },
  {
    name: 'Gemini GenerateContent',
    provider: 'gemini',
    executor_type: 'GeminiExecutor',
    ...separate,
  },
  {
    name: 'Gemini Interactions',
    provider: 'gemini-interactions',
    executor_type: 'GeminiExecutor',
    ...separate,
  },
  {
    name: 'Vertex native Gemini',
    provider: 'vertex',
    executor_type: 'GeminiVertexExecutor',
    ...separate,
  },
  { name: 'AI Studio', provider: 'aistudio', executor_type: 'AIStudioExecutor', ...separate },
  {
    name: 'Antigravity',
    provider: 'antigravity',
    executor_type: 'AntigravityExecutor',
    ...separate,
  },
  { name: 'Devin Interactions', provider: 'devin', executor_type: 'DevinExecutor', ...separate },
  { name: 'Kimi', provider: 'kimi', executor_type: 'KimiExecutor', ...included },
  { name: 'xAI', provider: 'xai', executor_type: 'XAIExecutor', ...included },
  { name: 'xAI WebSocket', provider: 'xai', executor_type: 'XAIAutoExecutor', ...included },
  { name: 'Meta', provider: 'meta', executor_type: 'MetaExecutor', ...included },
  {
    name: 'Vertex OpenAI-compatible',
    provider: 'vertex',
    executor_type: 'OpenAICompatExecutor',
    ...included,
  },
  {
    name: 'Gemini-named OpenAI-compatible',
    provider: 'gemini',
    executor_type: 'OpenAICompatExecutor',
    ...included,
  },
];
