import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CODEX_CONFIG } from '@/components/quota';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { IconRefreshCw } from '@/components/ui/icons';
import type { UsagePayload } from '@/components/usage';
import { useQuotaStore } from '@/stores';
import { useCodexQuotaMetaStore } from '@/stores/useCodexQuotaMetaStore';
import type { AuthFileItem, CodexQuotaState, CodexQuotaWindow } from '@/types';
import {
  CREDENTIAL_COST_WINDOW_GRACE_MS,
  buildCredentialCostBuckets,
  getCredentialRowKeyForFile,
  sumCredentialUsageInWindow,
  type CredentialWindowUsageSummary
} from '@/utils/credentialUsage';
import {
  fetchCodexQuotaWithMeta,
  type CodexQuotaWindowMeta,
} from '@/utils/codexQuotaMeta';
import { isCodexFile } from '@/utils/quota';
import { formatCompactNumber, formatUsd, type ModelPrice } from '@/utils/usage';
import styles from '@/pages/CredentialCenterPage.module.scss';

const WINDOW_MS_BY_KIND = {
  'five-hour': 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  other: null
} as const;

const WINDOW_MS_BY_ID: Record<string, number | null> = {
  'five-hour': WINDOW_MS_BY_KIND['five-hour'],
  weekly: WINDOW_MS_BY_KIND.weekly,
  monthly: WINDOW_MS_BY_KIND.monthly
};

interface CodexCredentialQuotaCardProps {
  usage: UsagePayload | null;
  loading: boolean;
  modelPrices: Record<string, ModelPrice>;
  authFiles: AuthFileItem[];
}

interface SelectedQuotaWindow {
  window: CodexQuotaWindow;
  meta: CodexQuotaWindowMeta | undefined;
}

const selectMaxQuotaWindow = (
  quotaState: CodexQuotaState | undefined,
  metaById: Record<string, CodexQuotaWindowMeta> | undefined
): SelectedQuotaWindow | null => {
  const windows = quotaState?.windows ?? [];
  let selected: SelectedQuotaWindow | null = null;
  let selectedSeconds = -1;

  windows.forEach((window, index) => {
    const meta = metaById?.[window.id];
    const fallbackMs = WINDOW_MS_BY_ID[window.id];
    const seconds = meta?.windowSeconds ?? (typeof fallbackMs === 'number' ? fallbackMs / 1000 : 0);
    if (seconds > selectedSeconds || (seconds === selectedSeconds && selected === null && index === 0)) {
      selected = { window, meta };
      selectedSeconds = seconds;
    }
  });

  return selected;
};

const getRemainingPercentValue = (window: CodexQuotaWindow | undefined): number | null => {
  if (!window || typeof window.usedPercent !== 'number') return null;
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
};

const getRemainingPercentLabel = (window: CodexQuotaWindow): string => {
  const remainingPercent = getRemainingPercentValue(window);
  return remainingPercent === null ? '--' : `${Math.round(remainingPercent)}%`;
};

const estimateQuotaCost = (cost: number | null | undefined, window: CodexQuotaWindow | undefined): number | null => {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return null;
  const remainingPercent = getRemainingPercentValue(window);
  if (remainingPercent === null) return null;
  const usedRatio = 1 - remainingPercent / 100;
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

const renderRequestCount = (summary: CredentialWindowUsageSummary | null | undefined) => {
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

export function CodexCredentialQuotaCard({
  usage,
  loading,
  modelPrices,
  authFiles
}: CodexCredentialQuotaCardProps) {
  const { t } = useTranslation();
  const [refreshingKeys, setRefreshingKeys] = useState<Record<string, boolean>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);
  const codexQuotaMeta = useCodexQuotaMetaStore((state) => state.codexQuotaMeta);
  const setCodexQuotaMeta = useCodexQuotaMetaStore((state) => state.setCodexQuotaMeta);

  const codexFiles = useMemo(
    () => authFiles.filter((file) => file.name && isCodexFile(file)),
    [authFiles]
  );
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();
  const filteredCodexFiles = useMemo(
    () =>
      codexFiles.filter(
        (file) => !normalizedSearchTerm || file.name.toLowerCase().includes(normalizedSearchTerm)
      ),
    [codexFiles, normalizedSearchTerm]
  );

  const costBuckets = useMemo(
    () => buildCredentialCostBuckets({ usage, authFiles: codexFiles, modelPrices }),
    [codexFiles, modelPrices, usage]
  );

  const quotaRows = useMemo(() => {
    const result = new Map<
      string,
      { selected: SelectedQuotaWindow | null; summary: CredentialWindowUsageSummary | null }
    >();

    codexFiles.forEach((file) => {
      const quotaState = codexQuota[file.name] as CodexQuotaState | undefined;
      const selected = selectMaxQuotaWindow(quotaState, codexQuotaMeta[file.name]?.windows);
      const endMs = getWindowEndMs(selected?.window, selected?.meta);
      const windowMs = selected?.meta?.windowKind
        ? WINDOW_MS_BY_KIND[selected.meta.windowKind]
        : selected?.window.id
          ? WINDOW_MS_BY_ID[selected.window.id]
          : null;
      const summary =
        selected === null || endMs === null || windowMs === null
          ? null
          : sumCredentialUsageInWindow(
              costBuckets.get(getCredentialRowKeyForFile(file)) ?? [],
              endMs - windowMs,
              endMs,
              CREDENTIAL_COST_WINDOW_GRACE_MS
            );

      result.set(file.name, { selected, summary });
    });

    return result;
  }, [codexFiles, codexQuota, codexQuotaMeta, costBuckets]);

  const handleRefreshQuota = useCallback(
    async (file: AuthFileItem) => {
      const quotaKey = file.name;
      if (!quotaKey) return;

      setRefreshingKeys((prev) => ({ ...prev, [quotaKey]: true }));
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
      } finally {
        setRefreshingKeys((prev) => ({ ...prev, [quotaKey]: false }));
      }
    },
    [setCodexQuota, setCodexQuotaMeta, t]
  );

  const renderQuotaLimit = (quotaState: CodexQuotaState | undefined, selected: SelectedQuotaWindow | null) => {
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

    const window = selected?.window;
    if (!window) return <span className={styles.quotaStatus}>--</span>;

    return (
      <span className={styles.quotaLimitCellInner} title={window.resetLabel}>
        <span className={styles.quotaLimitPrimary}>{getRemainingPercentLabel(window)}</span>
        <span className={styles.quotaLimitSecondary}>{window.resetLabel}</span>
      </span>
    );
  };

  return (
    <Card
      title={t('credential_center.codex_quota_title')}
      className={styles.fixedCard}
      extra={
        <div className={styles.cardHeaderControls}>
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
      {loading && codexFiles.length === 0 ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : codexFiles.length === 0 ? (
        <EmptyState
          title={t('credential_center.codex_quota_empty_title')}
          description={t('credential_center.codex_quota_empty_desc')}
        />
      ) : filteredCodexFiles.length === 0 ? (
        <EmptyState
          title={t('monitoring_center.credential_no_result_title')}
          description={t('monitoring_center.credential_no_result_desc')}
        />
      ) : (
        <div className={styles.tableScroll}>
          <table className={`${styles.table} ${styles.codexQuotaTable}`}>
            <thead>
              <tr>
                <th>{t('credential_center.quota_credential')}</th>
                <th className={styles.refreshColumn}>
                  <span className={styles.visuallyHidden}>{t('credential_center.quota_refresh')}</span>
                </th>
                <th className={styles.quotaTypeColumn}>{t('credential_center.quota_type')}</th>
                <th className={styles.quotaLimitColumn}>{t('credential_center.quota_limit')}</th>
                <th className={styles.quotaRequestColumn}>{t('usage_stats.requests_count')}</th>
                <th className={styles.quotaTokenColumn}>{t('usage_stats.tokens_count')}</th>
                <th className={styles.quotaSpendColumn}>{t('credential_center.quota_spend')}</th>
                <th className={styles.quotaEstimateColumn}>{t('credential_center.quota_estimate')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredCodexFiles.map((file) => {
                const quotaState = codexQuota[file.name] as CodexQuotaState | undefined;
                const row = quotaRows.get(file.name);
                const selectedWindow = row?.selected?.window;
                const selectedWindowLabel = selectedWindow?.labelKey
                  ? t(selectedWindow.labelKey, selectedWindow.labelParams as Record<string, string | number>)
                  : selectedWindow?.label;
                const summary = row?.summary ?? null;
                const estimate = estimateQuotaCost(summary?.cost, selectedWindow);
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
                    <td className={styles.quotaTypeColumn}>{selectedWindowLabel ?? '--'}</td>
                    <td className={styles.quotaLimitColumn}>{renderQuotaLimit(quotaState, row?.selected ?? null)}</td>
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
      )}
    </Card>
  );
}
