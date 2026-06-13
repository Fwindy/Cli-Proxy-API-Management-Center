import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ANTIGRAVITY_CONFIG } from '@/components/quota';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { IconRefreshCw } from '@/components/ui/icons';
import type { UsagePayload } from '@/components/usage';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem, AntigravityQuotaState, AntigravityQuotaGroup } from '@/types';
import {
  CREDENTIAL_COST_WINDOW_GRACE_MS,
  getCredentialRowKeyForFile,
  type CredentialCostEvent
} from '@/utils/credentialUsage';
import { isAntigravityFile } from '@/utils/quota';
import {
  collectUsageDetails,
  calculateCost,
  extractTotalTokens,
  normalizeAuthIndex,
  formatCompactNumber,
  formatUsd,
  type ModelPrice,
  type UsageDetail
} from '@/utils/usage';
import styles from '@/pages/CredentialCenterPage.module.scss';

const DEFAULT_REFRESH_INTERVAL_SECONDS = '0.5';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const getRefreshIntervalMs = (value: string): number => {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds < 0) return Number.parseFloat(DEFAULT_REFRESH_INTERVAL_SECONDS) * 1000;
  return seconds * 1000;
};

interface BatchProgress {
  running: boolean;
  total: number;
  done: number;
  success: number;
  failed: number;
  mode: 'all' | 'missing' | null;
}

const emptyProgress = (): BatchProgress => ({
  running: false,
  total: 0,
  done: 0,
  success: 0,
  failed: 0,
  mode: null
});

interface AntigravityCredentialQuotaCardProps {
  usage: UsagePayload | null;
  loading: boolean;
  modelPrices: Record<string, ModelPrice>;
  authFiles: AuthFileItem[];
  quotaType: 'claude' | 'gemini';
}

interface QuotaRow {
  group: AntigravityQuotaGroup | null;
  summary: {
    requests: number;
    successCount: number;
    failureCount: number;
    tokens: number;
    cost: number;
  } | null;
}

const selectQuotaGroup = (
  quotaState: AntigravityQuotaState | undefined,
  quotaType: 'claude' | 'gemini'
): AntigravityQuotaGroup | null => {
  const groups = quotaState?.groups ?? [];
  if (quotaType === 'claude') {
    return groups.find((g) => g.id === 'claude-gpt') ?? null;
  }
  return groups.find((g) => g.id.startsWith('gemini-')) ?? null;
};

const getRemainingPercentValue = (group: AntigravityQuotaGroup | null): number | null => {
  if (!group || typeof group.remainingFraction !== 'number') return null;
  return Math.max(0, Math.min(100, group.remainingFraction * 100));
};

const getRemainingPercentLabel = (group: AntigravityQuotaGroup | null): string => {
  const remainingPercent = getRemainingPercentValue(group);
  return remainingPercent === null ? '--' : `${Math.round(remainingPercent)}%`;
};

const estimateQuotaCost = (cost: number | null | undefined, group: AntigravityQuotaGroup | null): number | null => {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return null;
  const remainingPercent = getRemainingPercentValue(group);
  if (remainingPercent === null) return null;
  const usedRatio = 1 - remainingPercent / 100;
  if (usedRatio <= 0) return null;
  return cost / usedRatio;
};

const getResetTimeMs = (group: AntigravityQuotaGroup | null): number | null => {
  if (!group || !group.resetTime) return null;
  const resetMs = Date.parse(group.resetTime);
  return Number.isFinite(resetMs) && resetMs > 0 ? resetMs : null;
};

const formatResetLabel = (resetTime: string | undefined): string => {
  if (!resetTime) return '-';
  try {
    const date = new Date(resetTime);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString();
  } catch {
    return '-';
  }
};

const renderRequestCount = (summary: { requests: number; successCount: number; failureCount: number } | null | undefined) => {
  if (!summary) return '--';

  return (
    <span className={styles.requestCountCell}>
      <span>{summary.requests.toLocaleString()}</span>
      <span className={styles.requestBreakdown}>
        (<span className={styles.statSuccess}>{summary.successCount.toLocaleString()}</span>{' '}
        <span className={styles.statFailure}>{summary.failureCount.toLocaleString()}</span>)
      </span>
    </span>
  );
};

const matchesQuotaType = (modelName: string | undefined, quotaType: 'claude' | 'gemini'): boolean => {
  if (!modelName) return false;
  const normalized = modelName.toLowerCase();
  return normalized.includes(quotaType);
};

const buildFilteredCostBuckets = (
  usage: UsagePayload | null,
  authFiles: AuthFileItem[],
  modelPrices: Record<string, ModelPrice>,
  quotaType: 'claude' | 'gemini'
): Map<string, CredentialCostEvent[]> => {
  const buckets = new Map<string, CredentialCostEvent[]>();

  authFiles.forEach((file) => {
    if (file.name) {
      buckets.set(getCredentialRowKeyForFile(file), []);
    }
  });

  if (!usage) return buckets;

  const authIndexToFile = new Map<string, AuthFileItem>();
  const authFileNameToFile = new Map<string, AuthFileItem>();

  authFiles.forEach((file) => {
    const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
    if (authIndex) {
      authIndexToFile.set(authIndex, file);
    }
    if (file.name) {
      authFileNameToFile.set(file.name, file);
    }
  });

  const allDetails = collectUsageDetails(usage);

  allDetails.forEach((detail: UsageDetail) => {
    // Filter by model name
    if (!matchesQuotaType(detail.__modelName, quotaType)) {
      return;
    }

    const authIndex = normalizeAuthIndex(detail.auth_index);
    const sourceRaw = String(detail.source ?? '').trim();
    const sourceText = sourceRaw.startsWith('t:') ? sourceRaw.slice(2) : sourceRaw;
    const matchedFile =
      (authIndex ? authIndexToFile.get(authIndex) : undefined) ??
      (sourceRaw ? authFileNameToFile.get(sourceRaw) : undefined) ??
      (sourceText ? authFileNameToFile.get(sourceText) : undefined);

    if (!matchedFile?.name) return;

    const timestampMs = detail.__timestampMs ?? Date.parse(detail.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) return;

    const latencyMs =
      typeof detail.latency_ms === 'number' && Number.isFinite(detail.latency_ms) && detail.latency_ms > 0
        ? detail.latency_ms
        : 0;
    const completedAtMs = timestampMs + latencyMs;

    const rowKey = getCredentialRowKeyForFile(matchedFile);
    const events = buckets.get(rowKey) ?? [];
    events.push({
      completedAtMs,
      cost: calculateCost(detail, modelPrices),
      tokens: extractTotalTokens(detail),
      failed: detail.failed === true
    });
    buckets.set(rowKey, events);
  });

  return buckets;
};

const sumUsageInWindow = (
  events: CredentialCostEvent[],
  startMs: number,
  endMs: number,
  graceMs: number = 0
): { requests: number; successCount: number; failureCount: number; tokens: number; cost: number } => {
  const normalizedGraceMs = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 0;
  const effectiveStartMs = startMs - normalizedGraceMs;
  const effectiveEndMs = endMs + normalizedGraceMs;

  return events.reduce(
    (summary, item) => {
      if (item.completedAtMs < effectiveStartMs || item.completedAtMs > effectiveEndMs) {
        return summary;
      }

      summary.requests += 1;
      if (item.failed) {
        summary.failureCount += 1;
      } else {
        summary.successCount += 1;
      }
      summary.tokens += item.tokens;
      summary.cost += item.cost;
      return summary;
    },
    {
      requests: 0,
      successCount: 0,
      failureCount: 0,
      tokens: 0,
      cost: 0
    }
  );
};

export function AntigravityCredentialQuotaCard({
  usage,
  loading,
  modelPrices,
  authFiles,
  quotaType
}: AntigravityCredentialQuotaCardProps) {
  const { t } = useTranslation();
  const [refreshingKeys, setRefreshingKeys] = useState<Record<string, boolean>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState(DEFAULT_REFRESH_INTERVAL_SECONDS);
  const [progress, setProgress] = useState<BatchProgress>(emptyProgress);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const setAntigravityQuota = useQuotaStore((state) => state.setAntigravityQuota);

  const antigravityFiles = useMemo(
    () => authFiles.filter((file) => file.name && isAntigravityFile(file)),
    [authFiles]
  );
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const filteredAntigravityFiles = useMemo(
    () =>
      antigravityFiles.filter(
        (file) => !normalizedSearchTerm || file.name.toLowerCase().includes(normalizedSearchTerm)
      ),
    [antigravityFiles, normalizedSearchTerm]
  );

  const costBuckets = useMemo(
    () => buildFilteredCostBuckets(usage, antigravityFiles, modelPrices, quotaType),
    [antigravityFiles, modelPrices, usage, quotaType]
  );

  const quotaRows = useMemo(() => {
    const result = new Map<string, QuotaRow>();

    antigravityFiles.forEach((file) => {
      const quotaState = antigravityQuota[file.name] as AntigravityQuotaState | undefined;
      const group = selectQuotaGroup(quotaState, quotaType);
      const resetTimeMs = getResetTimeMs(group);

      let summary: { requests: number; successCount: number; failureCount: number; tokens: number; cost: number } | null = null;
      if (resetTimeMs !== null) {
        const events = costBuckets.get(getCredentialRowKeyForFile(file)) ?? [];
        summary = sumUsageInWindow(
          events,
          resetTimeMs - SEVEN_DAYS_MS,
          resetTimeMs,
          CREDENTIAL_COST_WINDOW_GRACE_MS
        );
      }

      result.set(file.name, { group, summary });
    });

    return result;
  }, [antigravityFiles, antigravityQuota, costBuckets, quotaType]);

  const handleRefreshQuota = useCallback(
    async (file: AuthFileItem) => {
      const quotaKey = file.name;
      if (!quotaKey) return 'skipped' as const;

      setRefreshingKeys((prev) => ({ ...prev, [quotaKey]: true }));
      setAntigravityQuota((prev) => ({
        ...prev,
        [quotaKey]: ANTIGRAVITY_CONFIG.buildLoadingState()
      }));

      try {
        const data = await ANTIGRAVITY_CONFIG.fetchQuota(file, t);
        setAntigravityQuota((prev) => ({
          ...prev,
          [quotaKey]: ANTIGRAVITY_CONFIG.buildSuccessState(data)
        }));
        return 'success' as const;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status =
          typeof err === 'object' && err !== null && 'status' in err
            ? Number((err as { status?: unknown }).status)
            : undefined;
        setAntigravityQuota((prev) => ({
          ...prev,
          [quotaKey]: ANTIGRAVITY_CONFIG.buildErrorState(
            message,
            Number.isFinite(status) ? status : undefined
          )
        }));
        return 'failed' as const;
      } finally {
        setRefreshingKeys((prev) => ({ ...prev, [quotaKey]: false }));
      }
    },
    [setAntigravityQuota, t]
  );

  const hasFetchedQuota = useCallback((file: AuthFileItem): boolean => {
    const quotaState = antigravityQuota[file.name] as AntigravityQuotaState | undefined;
    return quotaState?.status === 'success' && (quotaState.groups?.length ?? 0) > 0;
  }, [antigravityQuota]);

  const handleBatchRefresh = useCallback(
    async (mode: 'all' | 'missing') => {
      if (progress.running) return;

      const targetFiles = mode === 'all'
        ? antigravityFiles
        : antigravityFiles.filter((file) => !hasFetchedQuota(file));
      const intervalMs = getRefreshIntervalMs(refreshIntervalSeconds);
      const total = targetFiles.length;

      setBatchMessage(null);
      setProgress({
        running: total > 0,
        total,
        done: 0,
        success: 0,
        failed: 0,
        mode
      });

      if (total === 0) {
        setBatchMessage(t('credential_center.codex_pool_batch_none'));
        setProgress(emptyProgress());
        return;
      }

      for (let index = 0; index < targetFiles.length; index += 1) {
        const file = targetFiles[index];
        const result = await handleRefreshQuota(file);
        setProgress((current) => ({
          ...current,
          done: current.done + 1,
          success: current.success + (result === 'success' ? 1 : 0),
          failed: current.failed + (result === 'failed' ? 1 : 0)
        }));
        if (index < targetFiles.length - 1 && intervalMs > 0) {
          await sleep(intervalMs);
        }
      }

      setProgress((current) => ({ ...current, running: false }));
      setBatchMessage(t('credential_center.codex_pool_batch_finished'));
    },
    [antigravityFiles, hasFetchedQuota, handleRefreshQuota, progress.running, refreshIntervalSeconds, t]
  );

  const missingQuotaCount = useMemo(
    () => antigravityFiles.filter((file) => !hasFetchedQuota(file)).length,
    [antigravityFiles, hasFetchedQuota]
  );

  const progressPercent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const renderQuotaLimit = (quotaState: AntigravityQuotaState | undefined, group: AntigravityQuotaGroup | null) => {
    if (quotaState?.status === 'loading') {
      return <span className={styles.quotaStatus}>{t('credential_center.quota_loading')}</span>;
    }
    if (quotaState?.status === 'error') {
      return (
        <span className={styles.quotaError} title={quotaState.error}>
          {t('credential_center.quota_error')}
        </span>
      );
    }

    if (!group) return <span className={styles.quotaStatus}>--</span>;

    return (
      <span className={styles.quotaLimitCellInner} title={formatResetLabel(group.resetTime)}>
        <span className={styles.quotaLimitPrimary}>{getRemainingPercentLabel(group)}</span>
        <span className={styles.quotaLimitSecondary}>{formatResetLabel(group.resetTime)}</span>
      </span>
    );
  };

  const titleKey = quotaType === 'claude'
    ? 'credential_center.antigravity_claude_quota_title'
    : 'credential_center.antigravity_gemini_quota_title';
  const emptyTitleKey = quotaType === 'claude'
    ? 'credential_center.antigravity_claude_quota_empty_title'
    : 'credential_center.antigravity_gemini_quota_empty_title';
  const emptyDescKey = quotaType === 'claude'
    ? 'credential_center.antigravity_claude_quota_empty_desc'
    : 'credential_center.antigravity_gemini_quota_empty_desc';

  return (
    <Card
      title={t(titleKey)}
      className={styles.fixedCard}
      extra={
        <div className={styles.cardHeaderControls}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleBatchRefresh('all')}
            disabled={progress.running || antigravityFiles.length === 0}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
              <IconRefreshCw size={14} />
              全部
            </span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleBatchRefresh('missing')}
            disabled={progress.running || missingQuotaCount === 0}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
              <IconRefreshCw size={14} />
              补漏
            </span>
          </Button>
          <label className={styles.codexPoolIntervalControl}>
            <span>{t('credential_center.codex_pool_refresh_interval')}</span>
            <Input
              type="number"
              min="0"
              step="0.1"
              value={refreshIntervalSeconds}
              onChange={(event) => setRefreshIntervalSeconds(event.currentTarget.value)}
              className={styles.codexPoolIntervalInput}
              aria-label={t('credential_center.codex_pool_refresh_interval')}
            />
            <span>{t('credential_center.codex_pool_refresh_interval_unit')}</span>
          </label>
          <div className={styles.searchFilterItem}>
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.currentTarget.value)}
              placeholder={t('monitoring_center.credential_search_placeholder')}
              aria-label={t('monitoring_center.credential_search_label')}
              className={styles.searchInput}
            />
          </div>
        </div>
      }
    >
      {loading && antigravityFiles.length === 0 ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : antigravityFiles.length === 0 ? (
        <EmptyState
          title={t(emptyTitleKey)}
          description={t(emptyDescKey)}
        />
      ) : filteredAntigravityFiles.length === 0 ? (
        <EmptyState
          title={t('monitoring_center.credential_no_result_title')}
          description={t('monitoring_center.credential_no_result_desc')}
        />
      ) : (
        <>
          {(progress.running || progress.total > 0 || batchMessage) && (
            <div className={styles.codexPoolProgressBox}>
              <div className={styles.codexPoolProgressHeader}>
                <span>
                  {progress.mode
                    ? t(`credential_center.codex_pool_batch_mode_${progress.mode}`)
                    : t('credential_center.codex_pool_batch_progress')}
                </span>
                <span>
                  {progress.done}/{progress.total} · {progressPercent}%
                </span>
              </div>
              <div className={styles.codexPoolProgressTrack}>
                <div className={styles.codexPoolProgressFill} style={{ width: `${progressPercent}%` }} />
              </div>
              <div className={styles.codexPoolProgressMeta}>
                <span>{t('credential_center.codex_pool_progress_success', { count: progress.success })}</span>
                <span>{t('credential_center.codex_pool_progress_failed', { count: progress.failed })}</span>
                {batchMessage && <span>{batchMessage}</span>}
              </div>
            </div>
          )}
          <div className={styles.tableScroll}>
            <table className={`${styles.table} ${styles.codexQuotaTable}`}>
              <thead>
                <tr>
                  <th>{t('credential_center.quota_credential')}</th>
                  <th className={styles.refreshColumn}>
                    <span className={styles.visuallyHidden}>{t('credential_center.quota_refresh')}</span>
                  </th>
                  <th className={styles.quotaLimitColumn}>{t('credential_center.quota_limit')}</th>
                  <th className={styles.quotaRequestColumn}>{t('usage_stats.requests_count')}</th>
                  <th className={styles.quotaTokenColumn}>{t('usage_stats.tokens_count')}</th>
                  <th className={styles.quotaSpendColumn}>{t('credential_center.quota_spend')}</th>
                  <th className={styles.quotaEstimateColumn}>{t('credential_center.quota_estimate')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredAntigravityFiles.map((file) => {
                  const quotaState = antigravityQuota[file.name] as AntigravityQuotaState | undefined;
                  const row = quotaRows.get(file.name);
                  const group = row?.group ?? null;
                  const summary = row?.summary ?? null;
                  const estimate = estimateQuotaCost(summary?.cost, group);
                  const isRefreshing = refreshingKeys[file.name] === true;

                  return (
                    <tr key={file.name}>
                      <td className={styles.credentialCell}>{file.name}</td>
                      <td className={styles.refreshCell}>
                        <span className={styles.refreshCellContent}>
                          <Button
                            variant="secondary"
                            size="sm"
                            className={styles.iconOnlyButton}
                            loading={isRefreshing}
                            onClick={() => void handleRefreshQuota(file)}
                            aria-label={t('credential_center.quota_refresh')}
                            title={t('credential_center.quota_refresh')}
                          >
                            {!isRefreshing && <IconRefreshCw size={14} />}
                          </Button>
                        </span>
                      </td>
                      <td className={styles.quotaLimitColumn}>{renderQuotaLimit(quotaState, group)}</td>
                      <td className={styles.quotaRequestColumn}>{renderRequestCount(summary)}</td>
                      <td className={styles.quotaTokenColumn}>
                        {summary ? formatCompactNumber(summary.tokens) : '--'}
                      </td>
                      <td className={styles.quotaSpendColumn}>
                        {summary ? formatUsd(summary.cost) : '--'}
                      </td>
                      <td className={styles.quotaEstimateColumn}>
                        {estimate !== null ? formatUsd(estimate) : '--'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
