export const REQUEST_EVENT_ACTION_WIDTH = 44;
export const REQUEST_EVENT_COLUMNS_STORAGE_KEY = 'monitoring-request-event-hidden-columns';

export const REQUEST_EVENT_COLUMNS = [
  { id: 'timestamp', labelKey: 'request_events_timestamp', width: 170 },
  { id: 'model', labelKey: 'request_events_request_model', width: 160 },
  { id: 'responseModel', labelKey: 'request_events_response_model', width: 160 },
  { id: 'source', labelKey: 'request_events_source', width: 228 },
  { id: 'tier', labelKey: 'request_events_tier', width: 96 },
  { id: 'result', labelKey: 'request_events_result', width: 86 },
  { id: 'firstByteLatency', labelKey: 'first_byte_latency', width: 92 },
  { id: 'generation', labelKey: 'generation_time', width: 92 },
  { id: 'tps', labelKey: 'request_events_tps', width: 92 },
  { id: 'thinking', labelKey: 'thinking_intensity', width: 110 },
  { id: 'inputTokens', labelKey: 'input_tokens', width: 100 },
  { id: 'outputTokens', labelKey: 'output_tokens', width: 100 },
  { id: 'reasoningTokens', labelKey: 'reasoning_tokens', width: 100 },
  { id: 'cachedTokens', labelKey: 'cached_tokens', width: 100 },
  { id: 'cacheCreationTokens', labelKey: 'cache_creation_tokens', width: 100 },
  { id: 'totalTokens', labelKey: 'total_tokens', width: 100 },
  { id: 'cacheHit', labelKey: 'cache_hit', width: 100 },
] as const;

export type RequestEventColumn = (typeof REQUEST_EVENT_COLUMNS)[number];
export type RequestEventColumnId = RequestEventColumn['id'];

const TIMING_COLUMNS = new Set<RequestEventColumnId>(['firstByteLatency', 'generation', 'tps']);
const COLUMN_IDS = new Set<string>(REQUEST_EVENT_COLUMNS.map((column) => column.id));

export function getAvailableRequestEventColumns(hasTimingData: boolean): RequestEventColumn[] {
  return REQUEST_EVENT_COLUMNS.filter((column) => hasTimingData || !TIMING_COLUMNS.has(column.id));
}

export function normalizeHiddenRequestEventColumns(
  value: unknown,
  hasTimingData: boolean
): RequestEventColumnId[] {
  const hidden = new Set<RequestEventColumnId>(
    Array.isArray(value)
      ? value.filter(
          (id): id is RequestEventColumnId => typeof id === 'string' && COLUMN_IDS.has(id)
        )
      : []
  );
  const available = getAvailableRequestEventColumns(hasTimingData);
  return available.every((column) => hidden.has(column.id)) ? [] : Array.from(hidden);
}

export function getVisibleRequestEventColumns(
  hiddenColumns: unknown,
  hasTimingData: boolean
): RequestEventColumn[] {
  const hidden = new Set(normalizeHiddenRequestEventColumns(hiddenColumns, hasTimingData));
  return getAvailableRequestEventColumns(hasTimingData).filter((column) => !hidden.has(column.id));
}
