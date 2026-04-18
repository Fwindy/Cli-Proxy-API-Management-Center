import { useCallback, useMemo } from 'react';
import {
  buildDailyCostSeries,
  buildDailySeriesByModel,
  buildHourlyCostSeries,
  buildHourlySeriesByModel,
  type ModelPrice,
  type UsageTimeRange
} from '@/utils/usage';
import type { UsagePayload } from './useUsageData';

export interface SparklineData {
  labels: string[];
  datasets: [
    {
      data: number[];
      borderColor: string;
      backgroundColor: string;
      fill: boolean;
      tension: number;
      pointRadius: number;
      borderWidth: number;
    }
  ];
}

export interface SparklineBundle {
  data: SparklineData;
}

export interface UseSparklinesOptions {
  usage: UsagePayload | null;
  loading: boolean;
  nowMs: number;
  timeRange?: UsageTimeRange;
  modelPrices?: Record<string, ModelPrice>;
}

export interface UseSparklinesReturn {
  requestsSparkline: SparklineBundle | null;
  tokensSparkline: SparklineBundle | null;
  rpmSparkline: SparklineBundle | null;
  tpmSparkline: SparklineBundle | null;
  costSparkline: SparklineBundle | null;
}

const sumSeries = (dataByModel: Map<string, number[]>, length: number): number[] => {
  const totals = new Array(length).fill(0);
  dataByModel.forEach((values) => {
    values.forEach((value, index) => {
      totals[index] = (totals[index] || 0) + value;
    });
  });
  return totals;
};

const trimDailySeriesToRecentDays = (
  series: { labels: string[]; data: number[] },
  days: number
): { labels: string[]; data: number[] } => {
  if (!Number.isFinite(days) || days <= 0 || series.labels.length <= days) {
    return series;
  }
  const startIndex = Math.max(series.labels.length - days, 0);
  return {
    labels: series.labels.slice(startIndex),
    data: series.data.slice(startIndex)
  };
};

export function useSparklines({
  usage,
  loading,
  timeRange = '24h',
  modelPrices = {}
}: UseSparklinesOptions): UseSparklinesReturn {
  const requestsAndTokensSeries = useMemo(() => {
    if (!usage) {
      return { labels: [], requests: [], tokens: [] };
    }

    if (timeRange === '7h' || timeRange === '24h') {
      const hourWindow = timeRange === '7h' ? 7 : 24;
      const requestBase = buildHourlySeriesByModel(usage, 'requests', hourWindow);
      const tokenBase = buildHourlySeriesByModel(usage, 'tokens', hourWindow);
      return {
        labels: requestBase.labels,
        requests: sumSeries(requestBase.dataByModel, requestBase.labels.length),
        tokens: sumSeries(tokenBase.dataByModel, tokenBase.labels.length)
      };
    }

    const requestBase = buildDailySeriesByModel(usage, 'requests');
    const tokenBase = buildDailySeriesByModel(usage, 'tokens');
    const requestSeries = {
      labels: requestBase.labels,
      data: sumSeries(requestBase.dataByModel, requestBase.labels.length)
    };
    const tokenSeries = {
      labels: tokenBase.labels,
      data: sumSeries(tokenBase.dataByModel, tokenBase.labels.length)
    };

    if (timeRange === '7d' || timeRange === '30d') {
      const days = timeRange === '7d' ? 7 : 30;
      const trimmedRequests = trimDailySeriesToRecentDays(requestSeries, days);
      const trimmedTokens = trimDailySeriesToRecentDays(tokenSeries, days);
      return {
        labels: trimmedRequests.labels,
        requests: trimmedRequests.data,
        tokens: trimmedTokens.data
      };
    }

    return {
      labels: requestSeries.labels,
      requests: requestSeries.data,
      tokens: tokenSeries.data
    };
  }, [timeRange, usage]);

  const costSeries = useMemo(() => {
    if (!usage || Object.keys(modelPrices).length === 0) {
      return { labels: [], data: [] };
    }

    if (timeRange === '7h' || timeRange === '24h') {
      const hourWindow = timeRange === '7h' ? 7 : 24;
      const costBase = buildHourlyCostSeries(usage, modelPrices, hourWindow);
      return { labels: costBase.labels, data: costBase.data };
    }

    const costBase = buildDailyCostSeries(usage, modelPrices);
    const series = { labels: costBase.labels, data: costBase.data };
    if (timeRange === '7d' || timeRange === '30d') {
      return trimDailySeriesToRecentDays(series, timeRange === '7d' ? 7 : 30);
    }
    return series;
  }, [modelPrices, timeRange, usage]);

  const buildSparkline = useCallback(
    (
      series: { labels: string[]; data: number[] },
      color: string,
      backgroundColor: string
    ): SparklineBundle | null => {
      if (loading || !series.data.length || !series.labels.length) {
        return null;
      }
      return {
        data: {
          labels: series.labels,
          datasets: [
            {
              data: series.data,
              borderColor: color,
              backgroundColor,
              fill: true,
              tension: 0.45,
              pointRadius: 0,
              borderWidth: 2
            }
          ]
        }
      };
    },
    [loading]
  );

  const requestsSparkline = useMemo(
    () =>
      buildSparkline(
        { labels: requestsAndTokensSeries.labels, data: requestsAndTokensSeries.requests },
        '#8b8680',
        'rgba(139, 134, 128, 0.18)'
      ),
    [buildSparkline, requestsAndTokensSeries.labels, requestsAndTokensSeries.requests]
  );

  const tokensSparkline = useMemo(
    () =>
      buildSparkline(
        { labels: requestsAndTokensSeries.labels, data: requestsAndTokensSeries.tokens },
        '#8b5cf6',
        'rgba(139, 92, 246, 0.18)'
      ),
    [buildSparkline, requestsAndTokensSeries.labels, requestsAndTokensSeries.tokens]
  );

  const rpmSparkline = useMemo(
    () =>
      buildSparkline(
        { labels: requestsAndTokensSeries.labels, data: requestsAndTokensSeries.requests },
        '#22c55e',
        'rgba(34, 197, 94, 0.18)'
      ),
    [buildSparkline, requestsAndTokensSeries.labels, requestsAndTokensSeries.requests]
  );

  const tpmSparkline = useMemo(
    () =>
      buildSparkline(
        { labels: requestsAndTokensSeries.labels, data: requestsAndTokensSeries.tokens },
        '#f97316',
        'rgba(249, 115, 22, 0.18)'
      ),
    [buildSparkline, requestsAndTokensSeries.labels, requestsAndTokensSeries.tokens]
  );

  const costSparkline = useMemo(
    () =>
      buildSparkline(
        { labels: costSeries.labels, data: costSeries.data },
        '#f59e0b',
        'rgba(245, 158, 11, 0.18)'
      ),
    [buildSparkline, costSeries.data, costSeries.labels]
  );

  return {
    requestsSparkline,
    tokensSparkline,
    rpmSparkline,
    tpmSparkline,
    costSparkline
  };
}
