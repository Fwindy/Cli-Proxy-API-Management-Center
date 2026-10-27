import { create } from 'zustand';
import { usageApi } from '@/services/api/usage';
import { useAuthStore } from '@/stores/useAuthStore';
import {
  buildUsageSnapshotFromDetails,
  collectUsageDetailsWithEndpoint,
  computeKeyStatsFromDetails,
  normalizeAuthIndex,
  normalizeUsageData,
  type KeyStats,
  type UsageDetail,
  type UsageDetailWithEndpoint,
  type UsageStatsSnapshot,
  type UsageTimeRange,
} from '@/utils/usage';
import i18n from '@/i18n';

export const USAGE_STATS_STALE_TIME_MS = 240_000;

const USAGE_REFRESH_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const USAGE_RANGE_MS: Record<Exclude<UsageTimeRange, 'all'>, number> = {
  '7h': 7 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export type LoadUsageStatsOptions = {
  force?: boolean;
  fullRange?: boolean;
  staleTimeMs?: number;
  timeRange?: UsageTimeRange;
  minimumLookbackMs?: number;
};

type UsageLoadedRange = {
  startMs: number | null;
  endMs: number;
};

type UsageStatsState = {
  usage: UsageStatsSnapshot | null;
  keyStats: KeyStats;
  usageDetails: UsageDetail[];
  usageDetailsByKey: Record<string, UsageDetailWithEndpoint>;
  loadedRanges: UsageLoadedRange[];
  deletedUsageIds: Record<string, true>;
  loading: boolean;
  error: string | null;
  lastRefreshedAt: number | null;
  scopeKey: string;
  loadUsageStats: (options?: LoadUsageStatsOptions) => Promise<void>;
  deleteUsageRecords: (ids: string[]) => Promise<void>;
  clearUsageStats: () => void;
};

const createEmptyKeyStats = (): KeyStats => ({ bySource: {}, byAuthIndex: {} });

let usageRequestToken = 0;
let inFlightUsageRequest: { id: number; scopeKey: string; requestKey: string; promise: Promise<void> } | null = null;

const getErrorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : i18n.t('usage_stats.loading_error');

const toIsoString = (ms: number): string => new Date(ms).toISOString();

const getRangeStartMs = (timeRange: UsageTimeRange | undefined, nowMs: number): number | null => {
  if (!timeRange || timeRange === 'all') {
    return null;
  }
  return nowMs - USAGE_RANGE_MS[timeRange];
};

const getTargetStartMs = (
  timeRange: UsageTimeRange | undefined,
  nowMs: number,
  minimumLookbackMs: number | undefined
): number | null => {
  if (timeRange === 'all') {
    return null;
  }

  const rangeStartMs = getRangeStartMs(timeRange, nowMs);
  const minimumStartMs =
    typeof minimumLookbackMs === 'number' && Number.isFinite(minimumLookbackMs) && minimumLookbackMs > 0
      ? nowMs - minimumLookbackMs
      : null;

  if (rangeStartMs === null) return minimumStartMs;
  if (minimumStartMs === null) return rangeStartMs;
  return Math.min(rangeStartMs, minimumStartMs);
};

const getLatestLoadedEndMs = (ranges: UsageLoadedRange[]): number | null => {
  if (!ranges.length) return null;
  return Math.max(...ranges.map((range) => range.endMs));
};

const getEarliestConcreteStartMs = (ranges: UsageLoadedRange[]): number | null => {
  const starts = ranges
    .map((range) => range.startMs)
    .filter((startMs): startMs is number => typeof startMs === 'number');
  if (!starts.length) return null;
  return Math.min(...starts);
};

const hasFullRange = (ranges: UsageLoadedRange[]): boolean =>
  ranges.some((range) => range.startMs === null);

const hasStartCoverage = (ranges: UsageLoadedRange[], targetStartMs: number | null): boolean => {
  if (!ranges.length) return false;
  if (hasFullRange(ranges)) return true;
  if (targetStartMs === null) return false;
  const earliest = getEarliestConcreteStartMs(ranges);
  return earliest !== null && earliest <= targetStartMs;
};

const mergeLoadedRanges = (ranges: UsageLoadedRange[]): UsageLoadedRange[] => {
  if (!ranges.length) return [];
  const latestEnd = getLatestLoadedEndMs(ranges) ?? Date.now();
  if (hasFullRange(ranges)) {
    return [{ startMs: null, endMs: latestEnd }];
  }

  const sorted = ranges
    .filter((range): range is { startMs: number; endMs: number } => range.startMs !== null)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: UsageLoadedRange[] = [];

  sorted.forEach((range) => {
    const last = merged[merged.length - 1];
    if (!last || last.startMs === null || range.startMs > last.endMs + 1) {
      merged.push({ ...range });
      return;
    }
    last.endMs = Math.max(last.endMs, range.endMs);
  });

  return merged;
};

const resolveRequestRanges = (
  state: UsageStatsState,
  targetStartMs: number | null,
  nowMs: number,
  force: boolean,
  fresh: boolean
): UsageLoadedRange[] => {
  if (!state.loadedRanges.length) {
    return [{ startMs: targetStartMs, endMs: nowMs }];
  }

  const latestEnd = getLatestLoadedEndMs(state.loadedRanges) ?? nowMs;
  const ranges: UsageLoadedRange[] = [];

  if (targetStartMs === null) {
    if (!hasFullRange(state.loadedRanges)) {
      return [{ startMs: null, endMs: nowMs }];
    }
    if (force || !fresh) {
      ranges.push({ startMs: Math.max(0, latestEnd - USAGE_REFRESH_LOOKBACK_MS), endMs: nowMs });
    }
    return ranges;
  }

  if (!hasFullRange(state.loadedRanges)) {
    const earliestStart = getEarliestConcreteStartMs(state.loadedRanges);
    if (earliestStart === null || targetStartMs < earliestStart) {
      ranges.push({ startMs: targetStartMs, endMs: Math.min(earliestStart ?? nowMs, nowMs) });
    }
  }

  if (force || !fresh) {
    ranges.push({
      startMs: Math.max(targetStartMs, latestEnd - USAGE_REFRESH_LOOKBACK_MS),
      endMs: nowMs,
    });
  }

  return ranges.filter((range) => range.startMs === null || range.endMs > range.startMs);
};

const usageRangeToParams = (range: UsageLoadedRange) => {
  if (range.startMs === null) {
    return undefined;
  }
  return {
    start: toIsoString(range.startMs),
    end: toIsoString(range.endMs),
  };
};

const getUsageDetailCacheKey = (detail: UsageDetailWithEndpoint): string => {
  if (detail.id) {
    return `id:${detail.id}`;
  }

  return [
    'synthetic',
    detail.__endpoint,
    detail.__modelName ?? '',
    detail.timestamp,
    detail.source,
    normalizeAuthIndex(detail.auth_index) ?? '',
    detail.tokens.input_tokens,
    detail.tokens.output_tokens,
    detail.tokens.reasoning_tokens,
    detail.tokens.cached_tokens,
    detail.failed ? '1' : '0',
  ].join('|');
};

const buildDerivedState = (usageDetailsByKey: Record<string, UsageDetailWithEndpoint>) => {
  const usageDetails = Object.values(usageDetailsByKey).sort(
    (a, b) => (b.__timestampMs ?? 0) - (a.__timestampMs ?? 0)
  );
  return {
    usage: buildUsageSnapshotFromDetails(usageDetails),
    keyStats: computeKeyStatsFromDetails(usageDetails),
    usageDetails,
  };
};

const extractUsageDetailsFromResponse = (response: unknown): UsageDetailWithEndpoint[] => {
  const usage = normalizeUsageData(response);
  return collectUsageDetailsWithEndpoint(usage);
};

export const useUsageStatsStore = create<UsageStatsState>((set, get) => ({
  usage: null,
  keyStats: createEmptyKeyStats(),
  usageDetails: [],
  usageDetailsByKey: {},
  loadedRanges: [],
  deletedUsageIds: {},
  loading: false,
  error: null,
  lastRefreshedAt: null,
  scopeKey: '',

  loadUsageStats: async (options = {}) => {
    const force = options.force === true;
    const fullRange = options.fullRange === true;
    const staleTimeMs = options.staleTimeMs ?? USAGE_STATS_STALE_TIME_MS;
    const nowMs = Date.now();
    const targetStartMs = getTargetStartMs(options.timeRange, nowMs, options.minimumLookbackMs);
    const { apiBase = '', managementKey = '' } = useAuthStore.getState();
    const scopeKey = `${apiBase}::${managementKey}`;
    const state = get();
    const scopeChanged = state.scopeKey !== scopeKey;
    const fresh =
      !scopeChanged &&
      state.lastRefreshedAt !== null &&
      nowMs - state.lastRefreshedAt < staleTimeMs;

    if (!force && !fullRange && fresh && hasStartCoverage(state.loadedRanges, targetStartMs)) {
      return;
    }

    if (scopeChanged) {
      usageRequestToken += 1;
      inFlightUsageRequest = null;
      set({
        usage: null,
        keyStats: createEmptyKeyStats(),
        usageDetails: [],
        usageDetailsByKey: {},
        loadedRanges: [],
        deletedUsageIds: {},
        error: null,
        lastRefreshedAt: null,
        scopeKey,
      });
    }

    const requestState = scopeChanged ? get() : state;
    const requestRanges = fullRange
      ? [{ startMs: targetStartMs, endMs: nowMs }]
      : resolveRequestRanges(requestState, targetStartMs, nowMs, force, fresh);

    if (!requestRanges.length) {
      set({ lastRefreshedAt: nowMs, scopeKey });
      return;
    }

    const requestKey = `${scopeKey}::${fullRange ? 'full' : 'incremental'}::${requestRanges
      .map((range) => `${range.startMs ?? 'all'}-${range.endMs}`)
      .join(',')}`;

    if (inFlightUsageRequest && inFlightUsageRequest.scopeKey === scopeKey && inFlightUsageRequest.requestKey === requestKey) {
      await inFlightUsageRequest.promise;
      return;
    }

    const requestId = (usageRequestToken += 1);
    set({ loading: true, error: null, scopeKey });

    const requestPromise = (async () => {
      try {
        const responses = await Promise.all(
          requestRanges.map((range) => usageApi.getUsage(usageRangeToParams(range)))
        );

        if (requestId !== usageRequestToken) return;

        const currentState = get();
        const nextDetailsByKey: Record<string, UsageDetailWithEndpoint> = fullRange
          ? {}
          : { ...currentState.usageDetailsByKey };
        const deletedUsageIds = currentState.deletedUsageIds;

        responses.forEach((response) => {
          extractUsageDetailsFromResponse(response).forEach((detail) => {
            if (detail.id && deletedUsageIds[detail.id]) {
              return;
            }
            nextDetailsByKey[getUsageDetailCacheKey(detail)] = detail;
          });
        });

        const derived = buildDerivedState(nextDetailsByKey);
        set({
          ...derived,
          usageDetailsByKey: nextDetailsByKey,
          loadedRanges: fullRange
            ? mergeLoadedRanges(requestRanges)
            : mergeLoadedRanges([...currentState.loadedRanges, ...requestRanges]),
          loading: false,
          error: null,
          lastRefreshedAt: Date.now(),
          scopeKey,
        });
      } catch (error: unknown) {
        if (requestId !== usageRequestToken) return;
        const message = getErrorMessage(error);
        set({
          loading: false,
          error: message,
          scopeKey,
        });
        throw Object.defineProperty(new Error(message), 'cause', { value: error });
      } finally {
        if (inFlightUsageRequest?.id === requestId) {
          inFlightUsageRequest = null;
        }
      }
    })();

    inFlightUsageRequest = { id: requestId, scopeKey, requestKey, promise: requestPromise };
    await requestPromise;
  },

  deleteUsageRecords: async (ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
    if (!uniqueIds.length) return;

    await usageApi.deleteUsage(uniqueIds);

    set((state) => {
      const idSet = new Set(uniqueIds);
      const usageDetailsByKey = Object.fromEntries(
        Object.entries(state.usageDetailsByKey).filter(([, detail]) => !detail.id || !idSet.has(detail.id))
      ) as Record<string, UsageDetailWithEndpoint>;
      const deletedUsageIds = { ...state.deletedUsageIds };
      uniqueIds.forEach((id) => {
        deletedUsageIds[id] = true;
      });
      return {
        ...buildDerivedState(usageDetailsByKey),
        usageDetailsByKey,
        deletedUsageIds,
      };
    });
  },

  clearUsageStats: () => {
    usageRequestToken += 1;
    inFlightUsageRequest = null;
    set({
      usage: null,
      keyStats: createEmptyKeyStats(),
      usageDetails: [],
      usageDetailsByKey: {},
      loadedRanges: [],
      deletedUsageIds: {},
      loading: false,
      error: null,
      lastRefreshedAt: null,
      scopeKey: '',
    });
  },
}));
