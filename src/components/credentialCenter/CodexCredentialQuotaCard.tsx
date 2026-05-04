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
import type { AuthFileItem, CodexQuotaState, CodexQuotaWindow } from '@/types';
import {
  CREDENTIAL_COST_WINDOW_GRACE_MS,
  buildCredentialCostBuckets,
  getCredentialRowKeyForFile,
  sumCostInWindow
} from '@/utils/credentialUsage';
import { isCodexFile } from '@/utils/quota';
import { formatUsd, type ModelPrice } from '@/utils/usage';
import styles from '@/pages/CredentialCenterPage.module.scss';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface CodexCredentialQuotaCardProps {
  usage: UsagePayload | null;
  loading: boolean;
  modelPrices: Record<string, ModelPrice>;
  authFiles: AuthFileItem[];
}

const getQuotaWindow = (
  quotaState: CodexQuotaState | undefined,
  id: 'five-hour' | 'weekly'
): CodexQuotaWindow | undefined => quotaState?.windows?.find((window) => window.id === id);

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

const getWindowEndMs = (window: CodexQuotaWindow | undefined): number | null => {
  const endMs = typeof window?.resetAtUnix === 'number' ? window.resetAtUnix * 1000 : null;
  return endMs !== null && Number.isFinite(endMs) && endMs > 0 ? endMs : null;
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

  const spendByFile = useMemo(() => {
    const result = new Map<string, { fiveHourCost: number | null; weeklyCost: number | null }>();

    codexFiles.forEach((file) => {
      const quotaState = codexQuota[file.name] as CodexQuotaState | undefined;
      const fiveHourEndMs = getWindowEndMs(getQuotaWindow(quotaState, 'five-hour'));
      const weeklyEndMs = getWindowEndMs(getQuotaWindow(quotaState, 'weekly'));
      const events = costBuckets.get(getCredentialRowKeyForFile(file)) ?? [];

      result.set(file.name, {
        fiveHourCost:
          fiveHourEndMs === null
            ? null
            : sumCostInWindow(
                events,
                fiveHourEndMs - FIVE_HOURS_MS,
                fiveHourEndMs,
                CREDENTIAL_COST_WINDOW_GRACE_MS
              ),
        weeklyCost:
          weeklyEndMs === null
            ? null
            : sumCostInWindow(
                events,
                weeklyEndMs - SEVEN_DAYS_MS,
                weeklyEndMs,
                CREDENTIAL_COST_WINDOW_GRACE_MS
              )
      });
    });

    return result;
  }, [codexFiles, codexQuota, costBuckets]);

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
        const data = await CODEX_CONFIG.fetchQuota(file, t);
        setCodexQuota((prev) => ({
          ...prev,
          [quotaKey]: CODEX_CONFIG.buildSuccessState(data)
        }));
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
    [setCodexQuota, t]
  );

  const renderQuotaLimit = (quotaState: CodexQuotaState | undefined, id: 'five-hour' | 'weekly') => {
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

    const window = getQuotaWindow(quotaState, id);
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
                <th className={styles.quotaLimitColumn}>{t('credential_center.quota_limit_5h')}</th>
                <th className={styles.quotaLimitColumn}>{t('credential_center.quota_limit_7d')}</th>
                <th className={styles.quotaSpendColumn}>{t('credential_center.quota_spend_5h')}</th>
                <th className={styles.quotaSpendColumn}>{t('credential_center.quota_spend_7d')}</th>
                <th className={styles.quotaEstimateColumn}>{t('credential_center.quota_estimate_5h')}</th>
                <th className={styles.quotaEstimateColumn}>{t('credential_center.quota_estimate_7d')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredCodexFiles.map((file) => {
                const quotaState = codexQuota[file.name] as CodexQuotaState | undefined;
                const fiveHourWindow = getQuotaWindow(quotaState, 'five-hour');
                const weeklyWindow = getQuotaWindow(quotaState, 'weekly');
                const spend = spendByFile.get(file.name);
                const fiveHourEstimate = estimateQuotaCost(spend?.fiveHourCost, fiveHourWindow);
                const weeklyEstimate = estimateQuotaCost(spend?.weeklyCost, weeklyWindow);
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
                    <td className={styles.quotaLimitColumn}>{renderQuotaLimit(quotaState, 'five-hour')}</td>
                    <td className={styles.quotaLimitColumn}>{renderQuotaLimit(quotaState, 'weekly')}</td>
                    <td className={styles.quotaSpendColumn}>
                      {spend?.fiveHourCost !== null && spend?.fiveHourCost !== undefined
                        ? formatUsd(spend.fiveHourCost)
                        : '--'}
                    </td>
                    <td className={styles.quotaSpendColumn}>
                      {spend?.weeklyCost !== null && spend?.weeklyCost !== undefined
                        ? formatUsd(spend.weeklyCost)
                        : '--'}
                    </td>
                    <td className={styles.quotaEstimateColumn}>
                      {fiveHourEstimate !== null ? formatUsd(fiveHourEstimate) : '--'}
                    </td>
                    <td className={styles.quotaEstimateColumn}>
                      {weeklyEstimate !== null ? formatUsd(weeklyEstimate) : '--'}
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
