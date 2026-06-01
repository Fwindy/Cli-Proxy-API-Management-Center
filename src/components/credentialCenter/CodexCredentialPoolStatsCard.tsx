import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CODEX_CONFIG } from '@/components/quota';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import type { UsagePayload } from '@/components/usage';
import { useQuotaStore } from '@/stores';
import { useCodexQuotaMetaStore } from '@/stores/useCodexQuotaMetaStore';
import type { AuthFileItem, CodexQuotaState, CodexQuotaWindow } from '@/types';
import {
  CREDENTIAL_COST_WINDOW_GRACE_MS,
  buildCredentialCostBuckets,
  getCredentialRowKeyForFile,
  sumCostInWindow
} from '@/utils/credentialUsage';
import {
  fetchCodexQuotaWithMeta,
  type CodexQuotaWindowMeta,
} from '@/utils/codexQuotaMeta';
import { isCodexFile, resolveCodexPlanType } from '@/utils/quota';
import { formatUsd, type ModelPrice } from '@/utils/usage';
import styles from '@/pages/CredentialCenterPage.module.scss';

const DEFAULT_REFRESH_INTERVAL_SECONDS = '0.5';

const POOL_WINDOW_CONFIG = {
  paid: {
    titleKey: 'credential_center.codex_pool_paid_title',
    emptyTitleKey: 'credential_center.codex_pool_paid_empty_title',
    emptyDescKey: 'credential_center.codex_pool_paid_empty_desc',
    windowId: 'weekly',
    windowMs: 7 * 24 * 60 * 60 * 1000,
    windowLabelKey: 'credential_center.codex_pool_window_7d'
  },
  free: {
    titleKey: 'credential_center.codex_pool_free_title',
    emptyTitleKey: 'credential_center.codex_pool_free_empty_title',
    emptyDescKey: 'credential_center.codex_pool_free_empty_desc',
    windowId: 'monthly',
    windowMs: 30 * 24 * 60 * 60 * 1000,
    windowLabelKey: 'credential_center.codex_pool_window_30d'
  }
} as const;

type CodexPoolType = keyof typeof POOL_WINDOW_CONFIG;

type RefreshMode = 'all' | 'missing';

interface CodexCredentialPoolStatsCardProps {
  usage: UsagePayload | null;
  modelPrices: Record<string, ModelPrice>;
  authFiles: AuthFileItem[];
  poolType: CodexPoolType;
}

interface BatchProgress {
  running: boolean;
  total: number;
  done: number;
  success: number;
  failed: number;
  skipped: number;
  currentName: string;
  mode: RefreshMode | null;
}

interface CodexPoolRow {
  file: AuthFileItem;
  planType: string;
  quotaState: CodexQuotaState | undefined;
  quotaWindow: CodexQuotaWindow | undefined;
  quotaEstimate: number | null;
  remainingPercent: number | null;
  quotaFetched: boolean;
}

interface CategoryAverage {
  totalEstimate: number | null;
  remainingEstimate: number | null;
}

interface EffectiveCodexPoolRow extends CodexPoolRow {
  effectiveQuotaEstimate: number | null;
  effectiveRemainingEstimate: number | null;
}

interface CategorySummary {
  planType: string;
  credentialCount: number;
  fetchedCount: number;
  totalEstimate: number;
  remainingEstimate: number;
  averageCredentialEstimate: number;
}

const emptyProgress = (): BatchProgress => ({
  running: false,
  total: 0,
  done: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  currentName: '',
  mode: null
});

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const getQuotaWindow = (
  quotaState: CodexQuotaState | undefined,
  id: string
): CodexQuotaWindow | undefined => quotaState?.windows?.find((window) => window.id === id);

const getRemainingPercentValue = (window: CodexQuotaWindow | undefined): number | null => {
  if (!window || typeof window.usedPercent !== 'number') return null;
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
};

const estimateQuotaCost = (cost: number | null | undefined, window: CodexQuotaWindow | undefined): number | null => {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return null;
  if (!window || typeof window.usedPercent !== 'number') return null;
  const usedRatio = Math.max(0, Math.min(100, window.usedPercent)) / 100;
  if (usedRatio <= 0) return null;
  return cost / usedRatio;
};

const getWindowEndMs = (
  window: CodexQuotaWindow | undefined,
  meta: CodexQuotaWindowMeta | undefined
): number | null => {
  if (!window) return null;
  const endMs = typeof meta?.resetAtUnix === 'number' ? meta.resetAtUnix * 1000 : null;
  return endMs !== null && Number.isFinite(endMs) && endMs > 0 ? endMs : null;
};

const getPlanType = (file: AuthFileItem, quotaState: CodexQuotaState | undefined): string => {
  const raw = quotaState?.planType ?? resolveCodexPlanType(file) ?? 'free';
  const normalized = String(raw).trim().toLowerCase();
  return normalized || 'free';
};

const shouldIncludePlanType = (poolType: CodexPoolType, planType: string): boolean =>
  poolType === 'free' ? planType === 'free' : planType !== 'free';

const getRefreshIntervalMs = (value: string): number => {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds < 0) return Number.parseFloat(DEFAULT_REFRESH_INTERVAL_SECONDS) * 1000;
  return seconds * 1000;
};

const hasFetchedQuota = (quotaState: CodexQuotaState | undefined, windowId: string): boolean => {
  const quotaWindow = getQuotaWindow(quotaState, windowId);
  return quotaState?.status === 'success' && typeof quotaWindow?.usedPercent === 'number';
};

const getPercentBucketKey = (remainingPercent: number | null): string => {
  if (remainingPercent === null) return 'unknown';
  if (remainingPercent <= 0) return 'zero';
  if (remainingPercent <= 20) return '1_20';
  if (remainingPercent <= 40) return '20_40';
  if (remainingPercent <= 60) return '40_60';
  if (remainingPercent <= 80) return '60_80';
  return '80_100';
};

export function CodexCredentialPoolStatsCard({
  usage,
  modelPrices,
  authFiles,
  poolType
}: CodexCredentialPoolStatsCardProps) {
  const { t } = useTranslation();
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState(DEFAULT_REFRESH_INTERVAL_SECONDS);
  const [progress, setProgress] = useState<BatchProgress>(emptyProgress);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);
  const codexQuotaMeta = useCodexQuotaMetaStore((state) => state.codexQuotaMeta);
  const setCodexQuotaMeta = useCodexQuotaMetaStore((state) => state.setCodexQuotaMeta);
  const poolConfig = POOL_WINDOW_CONFIG[poolType];
  const windowLabel = t(poolConfig.windowLabelKey);

  const codexFiles = useMemo(
    () => authFiles.filter((file) => file.name && isCodexFile(file)),
    [authFiles]
  );

  const poolFiles = useMemo(
    () =>
      codexFiles.filter((file) => {
        const quotaState = codexQuota[file.name] as CodexQuotaState | undefined;
        return shouldIncludePlanType(poolType, getPlanType(file, quotaState));
      }),
    [codexFiles, codexQuota, poolType]
  );

  const costBuckets = useMemo(
    () => buildCredentialCostBuckets({ usage, authFiles: poolFiles, modelPrices }),
    [modelPrices, poolFiles, usage]
  );

  const rows = useMemo<CodexPoolRow[]>(
    () =>
      poolFiles.map((file) => {
        const quotaState = codexQuota[file.name] as CodexQuotaState | undefined;
        const quotaMeta = codexQuotaMeta[file.name];
        const quotaWindow = getQuotaWindow(quotaState, poolConfig.windowId);
        const quotaEndMs = getWindowEndMs(quotaWindow, quotaMeta?.windows[poolConfig.windowId]);
        const quotaCost =
          quotaEndMs === null
            ? null
            : sumCostInWindow(
                costBuckets.get(getCredentialRowKeyForFile(file)) ?? [],
                quotaEndMs - poolConfig.windowMs,
                quotaEndMs,
                CREDENTIAL_COST_WINDOW_GRACE_MS
              );
        const quotaEstimate = estimateQuotaCost(quotaCost, quotaWindow);
        const remainingPercent = getRemainingPercentValue(quotaWindow);

        return {
          file,
          planType: getPlanType(file, quotaState),
          quotaState,
          quotaWindow,
          quotaEstimate,
          remainingPercent,
          quotaFetched: hasFetchedQuota(quotaState, poolConfig.windowId)
        };
      }),
    [codexQuota, codexQuotaMeta, costBuckets, poolConfig.windowId, poolConfig.windowMs, poolFiles]
  );

  const categoryAverages = useMemo(() => {
    const grouped = new Map<string, { total: number; remaining: number; totalCount: number; remainingCount: number }>();

    rows.forEach((row) => {
      const bucket = grouped.get(row.planType) ?? { total: 0, remaining: 0, totalCount: 0, remainingCount: 0 };
      if (row.quotaEstimate !== null) {
        bucket.total += row.quotaEstimate;
        bucket.totalCount += 1;
        if (row.remainingPercent !== null) {
          bucket.remaining += row.quotaEstimate * (row.remainingPercent / 100);
          bucket.remainingCount += 1;
        }
      }
      grouped.set(row.planType, bucket);
    });

    const result = new Map<string, CategoryAverage>();
    grouped.forEach((value, key) => {
      result.set(key, {
        totalEstimate: value.totalCount > 0 ? value.total / value.totalCount : null,
        remainingEstimate: value.remainingCount > 0 ? value.remaining / value.remainingCount : null
      });
    });
    return result;
  }, [rows]);

  const effectiveRows = useMemo<EffectiveCodexPoolRow[]>(
    () =>
      rows.map((row) => {
        const average = categoryAverages.get(row.planType);
        const effectiveQuotaEstimate = row.quotaEstimate ?? average?.totalEstimate ?? null;
        const effectiveRemainingEstimate =
          effectiveQuotaEstimate !== null && row.remainingPercent !== null
            ? effectiveQuotaEstimate * (row.remainingPercent / 100)
            : average?.remainingEstimate ?? null;
        return {
          ...row,
          effectiveQuotaEstimate,
          effectiveRemainingEstimate
        };
      }),
    [categoryAverages, rows]
  );

  const totalEstimate = effectiveRows.reduce(
    (sum, row) => sum + (row.effectiveQuotaEstimate ?? 0),
    0
  );
  const totalRemainingEstimate = effectiveRows.reduce(
    (sum, row) => sum + (row.effectiveRemainingEstimate ?? 0),
    0
  );

  const categorySummaries = useMemo<CategorySummary[]>(() => {
    const grouped = new Map<string, CategorySummary>();

    effectiveRows.forEach((row) => {
      const summary = grouped.get(row.planType) ?? {
        planType: row.planType,
        credentialCount: 0,
        fetchedCount: 0,
        totalEstimate: 0,
        remainingEstimate: 0,
        averageCredentialEstimate: 0
      };
      summary.credentialCount += 1;
      if (row.quotaFetched) summary.fetchedCount += 1;
      summary.totalEstimate += row.effectiveQuotaEstimate ?? 0;
      summary.remainingEstimate += row.effectiveRemainingEstimate ?? 0;
      summary.averageCredentialEstimate =
        summary.credentialCount > 0 ? summary.totalEstimate / summary.credentialCount : 0;
      grouped.set(row.planType, summary);
    });

    return Array.from(grouped.values()).sort((left, right) => left.planType.localeCompare(right.planType));
  }, [effectiveRows]);

  const percentBuckets = useMemo(
    () => [
      { key: 'zero', label: t('credential_center.codex_pool_bucket_zero'), count: 0, className: styles.codexPoolBucketDanger },
      { key: '1_20', label: t('credential_center.codex_pool_bucket_1_20'), count: 0, className: styles.codexPoolBucketWarning },
      { key: '20_40', label: t('credential_center.codex_pool_bucket_20_40'), count: 0, className: styles.codexPoolBucketNotice },
      { key: '40_60', label: t('credential_center.codex_pool_bucket_40_60'), count: 0, className: styles.codexPoolBucketInfo },
      { key: '60_80', label: t('credential_center.codex_pool_bucket_60_80'), count: 0, className: styles.codexPoolBucketCalm },
      { key: '80_100', label: t('credential_center.codex_pool_bucket_80_100'), count: 0, className: styles.codexPoolBucketGood },
      { key: 'unknown', label: t('credential_center.codex_pool_bucket_unknown'), count: 0, className: styles.codexPoolBucketMuted }
    ].map((bucket) => ({
      ...bucket,
      count: rows.filter((row) => getPercentBucketKey(row.remainingPercent) === bucket.key).length
    })),
    [rows, t]
  );

  const refreshOneFile = useCallback(
    async (file: AuthFileItem) => {
      const quotaKey = file.name;
      if (!quotaKey) return 'skipped' as const;

      setCodexQuota((prev) => ({
        ...prev,
        [quotaKey]: CODEX_CONFIG.buildLoadingState()
      }));

      try {
        const { data, meta } = await fetchCodexQuotaWithMeta(file, t);
        setCodexQuota((prev) => ({
          ...prev,
          [quotaKey]: CODEX_CONFIG.buildSuccessState(data)
        }));
        setCodexQuotaMeta(quotaKey, meta);
        return 'success' as const;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status =
          typeof err === 'object' && err !== null && 'status' in err
            ? Number((err as { status?: unknown }).status)
            : undefined;
        setCodexQuota((prev) => ({
          ...prev,
          [quotaKey]: CODEX_CONFIG.buildErrorState(
            message,
            Number.isFinite(status) ? status : undefined
          )
        }));
        return 'failed' as const;
      }
    },
    [setCodexQuota, setCodexQuotaMeta, t]
  );

  const handleBatchRefresh = useCallback(
    async (mode: RefreshMode) => {
      if (progress.running) return;

      const targetFiles = mode === 'all'
        ? poolFiles
        : poolFiles.filter((file) => !hasFetchedQuota(codexQuota[file.name] as CodexQuotaState | undefined, poolConfig.windowId));
      const intervalMs = getRefreshIntervalMs(refreshIntervalSeconds);
      const total = targetFiles.length;

      setBatchMessage(null);
      setProgress({
        running: total > 0,
        total,
        done: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        currentName: '',
        mode
      });

      if (total === 0) {
        setBatchMessage(t('credential_center.codex_pool_batch_none'));
        setProgress(emptyProgress());
        return;
      }

      for (let index = 0; index < targetFiles.length; index += 1) {
        const file = targetFiles[index];
        setProgress((current) => ({ ...current, currentName: file.name }));
        const result = await refreshOneFile(file);
        setProgress((current) => ({
          ...current,
          done: current.done + 1,
          success: current.success + (result === 'success' ? 1 : 0),
          failed: current.failed + (result === 'failed' ? 1 : 0),
          skipped: current.skipped + (result === 'skipped' ? 1 : 0)
        }));
        if (index < targetFiles.length - 1 && intervalMs > 0) {
          await sleep(intervalMs);
        }
      }

      setProgress((current) => ({ ...current, running: false, currentName: '' }));
      setBatchMessage(t('credential_center.codex_pool_batch_finished'));
    },
    [codexQuota, poolConfig.windowId, poolFiles, progress.running, refreshIntervalSeconds, refreshOneFile, t]
  );

  const progressPercent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const missingQuotaCount = rows.filter((row) => !row.quotaFetched).length;

  return (
    <Card
      title={t(poolConfig.titleKey)}
      className={styles.codexPoolCard}
      extra={
        <div className={styles.codexPoolControls}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleBatchRefresh('all')}
            disabled={progress.running || poolFiles.length === 0}
          >
            {t('credential_center.codex_pool_refresh_all')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleBatchRefresh('missing')}
            disabled={progress.running || missingQuotaCount === 0}
          >
            {t('credential_center.codex_pool_refresh_missing')}
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
        </div>
      }
    >
      {poolFiles.length === 0 ? (
        <EmptyState
          title={t(poolConfig.emptyTitleKey)}
          description={t(poolConfig.emptyDescKey)}
        />
      ) : (
        <div className={styles.codexPoolContent}>
          <div className={styles.codexPoolOverviewGrid}>
            <div className={styles.codexPoolMetricCard}>
              <span className={styles.codexPoolMetricLabel}>{t('credential_center.codex_pool_total_estimate', { window: windowLabel })}</span>
              <span className={styles.codexPoolMetricValue}>{formatUsd(totalEstimate)}</span>
            </div>
            <div className={styles.codexPoolMetricCard}>
              <span className={styles.codexPoolMetricLabel}>{t('credential_center.codex_pool_remaining_estimate', { window: windowLabel })}</span>
              <span className={styles.codexPoolMetricValue}>{formatUsd(totalRemainingEstimate)}</span>
            </div>
            <div className={styles.codexPoolMetricCard}>
              <span className={styles.codexPoolMetricLabel}>{t('credential_center.codex_pool_credentials')}</span>
              <span className={styles.codexPoolMetricValue}>{poolFiles.length.toLocaleString()}</span>
              <span className={styles.codexPoolMetricSubtext}>
                {t('credential_center.codex_pool_missing_count', { count: missingQuotaCount })}
              </span>
            </div>
          </div>

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
                <span>{t('credential_center.codex_pool_progress_skipped', { count: progress.skipped })}</span>
                {progress.currentName && (
                  <span>{t('credential_center.codex_pool_progress_current', { name: progress.currentName })}</span>
                )}
                {batchMessage && <span>{batchMessage}</span>}
              </div>
            </div>
          )}

          <div className={styles.codexPoolSection}>
            <div className={styles.codexPoolSectionTitle}>{t('credential_center.codex_pool_category_title')}</div>
            <div className={styles.codexPoolCategoryGrid}>
              {categorySummaries.map((summary) => (
                <div key={summary.planType} className={styles.codexPoolCategoryCard}>
                  <div className={styles.codexPoolCategoryHeader}>
                    <span className={styles.codexPoolCategoryName}>{summary.planType}</span>
                    <span className={styles.codexPoolCategoryCount}>
                      {t('credential_center.codex_pool_category_count', { count: summary.credentialCount })}
                    </span>
                  </div>
                  <div className={styles.codexPoolCategoryStats}>
                    <span>{t('credential_center.codex_pool_category_fetched', { count: summary.fetchedCount })}</span>
                    <span>{t('credential_center.codex_pool_category_total', { value: formatUsd(summary.totalEstimate), window: windowLabel })}</span>
                    <span>{t('credential_center.codex_pool_category_remaining', { value: formatUsd(summary.remainingEstimate), window: windowLabel })}</span>
                    <span>{t('credential_center.codex_pool_category_average', { value: formatUsd(summary.averageCredentialEstimate), window: windowLabel })}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.codexPoolSection}>
            <div className={styles.codexPoolSectionTitle}>{t('credential_center.codex_pool_distribution_title', { window: windowLabel })}</div>
            <div className={styles.codexPoolBucketGrid}>
              {percentBuckets.map((bucket) => (
                <div key={bucket.key} className={`${styles.codexPoolBucket} ${bucket.className}`}>
                  <span className={styles.codexPoolBucketCount}>{bucket.count.toLocaleString()}</span>
                  <span className={styles.codexPoolBucketLabel}>{bucket.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
