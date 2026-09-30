import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import type { UsagePayload } from '@/components/usage';
import {
  calculateCost,
  extractFirstByteLatencyMs,
  extractLatencyMs,
  extractTotalTokens,
  formatCompactNumber,
  formatDurationMs,
  formatUsdFixedOne,
  type ModelPrice,
  type UsageDetail
} from '@/utils/usage';
import styles from '@/pages/MonitoringCenterPage.module.scss';

export interface MonitorApiKeyStatsCardProps {
  usage: UsagePayload | null;
  loading: boolean;
  modelPrices: Record<string, ModelPrice>;
  title?: ReactNode;
  extra?: ReactNode;
}

type SortKey =
  | 'apiKey'
  | 'requests'
  | 'tokens'
  | 'cost'
  | 'successRate'
  | 'averageFirstByteLatencyMs'
  | 'averageTps';
type SortDir = 'asc' | 'desc';

interface ApiKeyStatsAccumulator {
  apiKey: string;
  requests: number;
  successCount: number;
  failureCount: number;
  tokens: number;
  cost: number;
  firstByteLatencyTotalMs: number;
  firstByteLatencySampleCount: number;
  totalTps: number;
  tpsSampleCount: number;
}

interface ApiKeyStatsRow extends ApiKeyStatsAccumulator {
  successRate: number;
  averageFirstByteLatencyMs: number | null;
  averageTps: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const toNonNegativeNumber = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(numeric, 0) : 0;
};

const getModelsRecord = (apiEntry: unknown) => {
  const record = isRecord(apiEntry) ? apiEntry : null;
  return isRecord(record?.models) ? record.models : null;
};

const getDetails = (modelEntry: unknown) => {
  const record = isRecord(modelEntry) ? modelEntry : null;
  return Array.isArray(record?.details) ? record.details : [];
};

const getModelTotalTokens = (modelEntry: unknown) => {
  const record = isRecord(modelEntry) ? modelEntry : null;
  const totalTokens = toNonNegativeNumber(record?.total_tokens);
  if (totalTokens > 0) return totalTokens;
  return getDetails(modelEntry).reduce((sum, detail) => sum + extractTotalTokens(detail), 0);
};

export function MonitorApiKeyStatsCard({
  usage,
  loading,
  modelPrices,
  title,
  extra
}: MonitorApiKeyStatsCardProps) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('requests');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const rows = useMemo<ApiKeyStatsRow[]>(() => {
    const apis = isRecord(usage?.apis) ? usage.apis : null;
    if (!apis) return [];

    return Object.entries(apis).map(([apiKey, apiEntry]) => {
      const apiRecord = isRecord(apiEntry) ? apiEntry : {};
      const models = getModelsRecord(apiEntry);
      const totals: ApiKeyStatsAccumulator = {
        apiKey,
        requests: toNonNegativeNumber(apiRecord.total_requests),
        successCount: toNonNegativeNumber(apiRecord.success_count),
        failureCount: toNonNegativeNumber(apiRecord.failure_count),
        tokens: toNonNegativeNumber(apiRecord.total_tokens),
        cost: 0,
        firstByteLatencyTotalMs: 0,
        firstByteLatencySampleCount: 0,
        totalTps: 0,
        tpsSampleCount: 0
      };

      if (models) {
        let derivedRequests = 0;
        let derivedSuccessCount = 0;
        let derivedFailureCount = 0;
        let derivedTokens = 0;

        Object.entries(models).forEach(([modelName, modelEntry]) => {
          const modelRecord = isRecord(modelEntry) ? modelEntry : {};
          const details = getDetails(modelEntry);
          derivedRequests += toNonNegativeNumber(modelRecord.total_requests);
          derivedSuccessCount += toNonNegativeNumber(modelRecord.success_count);
          derivedFailureCount += toNonNegativeNumber(modelRecord.failure_count);
          derivedTokens += getModelTotalTokens(modelEntry);

          details.forEach((detail) => {
            const detailRecord = isRecord(detail) ? detail : null;
            if (!detailRecord) return;

            totals.cost += calculateCost(
              { ...(detailRecord as unknown as UsageDetail), __modelName: modelName },
              modelPrices
            );

            const firstByteLatencyMs = extractFirstByteLatencyMs(detailRecord);
            if (firstByteLatencyMs !== null && Number.isFinite(firstByteLatencyMs)) {
              totals.firstByteLatencyTotalMs += firstByteLatencyMs;
              totals.firstByteLatencySampleCount += 1;
            }

            const latencyMs = extractLatencyMs(detailRecord);
            const tokens = isRecord(detailRecord.tokens) ? detailRecord.tokens : null;
            const outputTokens = toNonNegativeNumber(tokens?.output_tokens);
            const tps = latencyMs && latencyMs > 0 ? outputTokens / (latencyMs / 1000) : null;
            if (tps !== null && Number.isFinite(tps) && tps >= 0) {
              totals.totalTps += tps;
              totals.tpsSampleCount += 1;
            }
          });
        });

        if (totals.requests === 0) totals.requests = derivedRequests;
        if (totals.successCount === 0 && totals.failureCount === 0) {
          totals.successCount = derivedSuccessCount;
          totals.failureCount = derivedFailureCount;
        }
        if (totals.tokens === 0) totals.tokens = derivedTokens;
      }

      return {
        ...totals,
        successRate: totals.requests > 0 ? (totals.successCount / totals.requests) * 100 : 100,
        averageFirstByteLatencyMs:
          totals.firstByteLatencySampleCount > 0
            ? totals.firstByteLatencyTotalMs / totals.firstByteLatencySampleCount
            : null,
        averageTps: totals.tpsSampleCount > 0 ? totals.totalTps / totals.tpsSampleCount : null
      };
    });
  }, [modelPrices, usage]);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setSortKey(key);
      setSortDir(key === 'apiKey' ? 'asc' : 'desc');
    },
    [sortKey]
  );

  const sortedRows = useMemo(() => {
    const direction = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const aValue = a[sortKey];
      const bValue = b[sortKey];

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return direction * aValue.localeCompare(bValue);
      }

      const left = typeof aValue === 'number' && Number.isFinite(aValue) ? aValue : -1;
      const right = typeof bValue === 'number' && Number.isFinite(bValue) ? bValue : -1;
      return direction * (left - right);
    });
  }, [rows, sortDir, sortKey]);

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const ariaSort = (key: SortKey): 'none' | 'ascending' | 'descending' =>
    sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <Card title={title ?? t('monitoring_center.usage_stats_title')} extra={extra} className={styles.detailsFixedCard}>
      {loading ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : sortedRows.length > 0 ? (
        <div className={styles.detailsScroll}>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.sortableHeader} aria-sort={ariaSort('apiKey')}>
                    <button
                      type="button"
                      className={styles.sortHeaderButton}
                      onClick={() => handleSort('apiKey')}
                    >
                      {t('monitoring_center.api_key_stat_name')}
                      {arrow('apiKey')}
                    </button>
                  </th>
                  <th className={styles.sortableHeader} aria-sort={ariaSort('requests')}>
                    <button
                      type="button"
                      className={styles.sortHeaderButton}
                      onClick={() => handleSort('requests')}
                    >
                      {t('usage_stats.requests_count')}
                      {arrow('requests')}
                    </button>
                  </th>
                  <th className={styles.sortableHeader} aria-sort={ariaSort('tokens')}>
                    <button
                      type="button"
                      className={styles.sortHeaderButton}
                      onClick={() => handleSort('tokens')}
                    >
                      {t('usage_stats.tokens_count')}
                      {arrow('tokens')}
                    </button>
                  </th>
                  <th className={styles.sortableHeader} aria-sort={ariaSort('averageFirstByteLatencyMs')}>
                    <button
                      type="button"
                      className={styles.sortHeaderButton}
                      onClick={() => handleSort('averageFirstByteLatencyMs')}
                    >
                      {t('usage_stats.avg_first_byte_latency')}
                      {arrow('averageFirstByteLatencyMs')}
                    </button>
                  </th>
                  <th className={styles.sortableHeader} aria-sort={ariaSort('averageTps')}>
                    <button
                      type="button"
                      className={styles.sortHeaderButton}
                      onClick={() => handleSort('averageTps')}
                    >
                      {t('usage_stats.avg_tps')}
                      {arrow('averageTps')}
                    </button>
                  </th>
                  <th className={styles.sortableHeader} aria-sort={ariaSort('successRate')}>
                    <button
                      type="button"
                      className={styles.sortHeaderButton}
                      onClick={() => handleSort('successRate')}
                    >
                      {t('usage_stats.success_rate')}
                      {arrow('successRate')}
                    </button>
                  </th>
                  <th className={styles.sortableHeader} aria-sort={ariaSort('cost')}>
                    <button
                      type="button"
                      className={styles.sortHeaderButton}
                      onClick={() => handleSort('cost')}
                    >
                      {t('usage_stats.total_cost')}
                      {arrow('cost')}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => (
                  <tr key={row.apiKey}>
                    <td className={styles.modelCell} title={row.apiKey}>{row.apiKey}</td>
                    <td>
                      <span className={styles.requestCountCell}>
                        <span>{row.requests.toLocaleString()}</span>
                        <span className={styles.requestBreakdown}>
                          (<span className={styles.statSuccess}>{row.successCount.toLocaleString()}</span>{' '}
                          <span className={styles.statFailure}>{row.failureCount.toLocaleString()}</span>)
                        </span>
                      </span>
                    </td>
                    <td>{formatCompactNumber(row.tokens)}</td>
                    <td className={styles.durationCell}>{formatDurationMs(row.averageFirstByteLatencyMs)}</td>
                    <td>{row.averageTps !== null ? row.averageTps.toFixed(2) : '--'}</td>
                    <td>
                      <span
                        className={
                          row.successRate >= 95
                            ? styles.statSuccess
                            : row.successRate >= 80
                              ? styles.statNeutral
                              : styles.statFailure
                        }
                      >
                        {row.successRate.toFixed(1)}%
                      </span>
                    </td>
                    <td>{row.cost > 0 ? formatUsdFixedOne(row.cost) : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className={styles.hint}>{t('usage_stats.no_data')}</div>
      )}
    </Card>
  );
}
