import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { CODEX_CONFIG } from '@/components/quota';
import { useQuotaStore } from '@/stores';
import type { CodexQuotaState } from '@/types';
import type { AuthFileItem as AuthFileMeta } from '@/types/authFile';
import type { UsagePayload } from '@/components/usage';
import { isCodexFile } from '@/utils/quota';
import {
  calculateCost,
  collectUsageDetails,
  extractTotalTokens,
  formatCompactNumber,
  formatUsd,
  normalizeAuthIndex,
  type ModelPrice
} from '@/utils/usage';
import styles from '@/pages/MonitoringCenterPage.module.scss';

const ALL_FILTER = '__all__';

type SortKey =
  | 'displayName'
  | 'requests'
  | 'tokens'
  | 'successRate'
  | 'cost'
  | 'fiveHourCost'
  | 'weeklyCost';
type SortDir = 'asc' | 'desc';

interface MonitorCredentialStatsCardProps {
  usage: UsagePayload | null;
  loading: boolean;
  modelPrices: Record<string, ModelPrice>;
  authFiles: AuthFileMeta[];
}

interface CredentialRow {
  key: string;
  displayName: string;
  type: string;
  authIndex: string | null;
  authFileName: string | null;
  requests: number;
  successCount: number;
  failureCount: number;
  tokens: number;
  cost: number;
  successRate: number;
  quotaKey: string | null;
}

type CredentialHealth = 'normal' | 'exhausted' | 'disabled';

const isCodexAuthFile = (file: AuthFileMeta | undefined) => Boolean(file && isCodexFile(file));

const normalizeCredentialType = (file?: AuthFileMeta) => {
  const rawType =
    typeof file?.type === 'string'
      ? file.type
      : typeof file?.provider === 'string'
        ? file.provider
        : '';
  return rawType.trim().toLowerCase() || 'unknown';
};

const toWindowCost = (endMs: number | null, windowMs: number | null) => {
  if (!windowMs || !endMs || !Number.isFinite(endMs) || endMs <= 0) {
    return null;
  }
  return { endMs, startMs: endMs - windowMs };
};

const getCredentialHealth = (file?: AuthFileMeta): CredentialHealth => {
  if (file?.disabled === true) return 'disabled';
  if (file?.unavailable === true) return 'exhausted';
  return 'normal';
};

export function MonitorCredentialStatsCard({
  usage,
  loading,
  modelPrices,
  authFiles
}: MonitorCredentialStatsCardProps) {
  const { t } = useTranslation();
  const [refreshingKeys, setRefreshingKeys] = useState<Record<string, boolean>>({});
  const [sortKey, setSortKey] = useState<SortKey>('displayName');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [typeFilter, setTypeFilter] = useState(ALL_FILTER);
  const [searchTerm, setSearchTerm] = useState('');
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);

  const rows = useMemo((): CredentialRow[] => {
    if (!usage) return [];

    const details = collectUsageDetails(usage);
    const authIndexToFile = new Map<string, AuthFileMeta>();
    const authFileNameToFile = new Map<string, AuthFileMeta>();

    authFiles.forEach((file) => {
      const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
      if (authIndex) {
        authIndexToFile.set(authIndex, file);
      }
      if (file.name) {
        authFileNameToFile.set(file.name, file);
      }
    });

    const rowMap = new Map<string, CredentialRow>();

    details.forEach((detail) => {
      const authIndex = normalizeAuthIndex(detail.auth_index);
      const sourceRaw = String(detail.source ?? '').trim();
      const sourceText = sourceRaw.startsWith('t:') ? sourceRaw.slice(2) : sourceRaw;
      const matchedFile =
        (authIndex ? authIndexToFile.get(authIndex) : undefined) ??
        (sourceRaw ? authFileNameToFile.get(sourceRaw) : undefined) ??
        (sourceText ? authFileNameToFile.get(sourceText) : undefined);

      const resolvedAuthIndex =
        (matchedFile && normalizeAuthIndex(matchedFile['auth_index'] ?? matchedFile.authIndex)) ?? authIndex;
      const authFileName = matchedFile?.name ?? null;

      if (!resolvedAuthIndex && !authFileName) {
        return;
      }

      const rowKey = authFileName ? `file:${authFileName}` : `auth:${resolvedAuthIndex}`;
      const displayName = authFileName ?? resolvedAuthIndex ?? '-';
      const type = normalizeCredentialType(matchedFile);
      const existing = rowMap.get(rowKey) ?? {
        key: rowKey,
        displayName,
        type,
        authIndex: resolvedAuthIndex ?? null,
        authFileName,
        requests: 0,
        successCount: 0,
        failureCount: 0,
        tokens: 0,
        cost: 0,
        successRate: 100,
        quotaKey: matchedFile && isCodexAuthFile(matchedFile) ? matchedFile.name : null
      };

      existing.requests += 1;
      if (detail.failed === true) {
        existing.failureCount += 1;
      } else {
        existing.successCount += 1;
      }
      existing.tokens += extractTotalTokens(detail);
      existing.cost += calculateCost(detail, modelPrices);
      existing.successRate =
        existing.requests > 0 ? (existing.successCount / existing.requests) * 100 : 100;
      rowMap.set(rowKey, existing);
    });

    return Array.from(rowMap.values());
  }, [authFiles, modelPrices, usage]);

  const typeOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(authFiles.map((file) => normalizeCredentialType(file))))
        .sort((a, b) => a.localeCompare(b))
        .map((type) => ({ value: type, label: type }))
    ],
    [authFiles, t]
  );

  const typeOptionSet = useMemo(
    () => new Set(typeOptions.map((option) => option.value)),
    [typeOptions]
  );
  const effectiveTypeFilter = typeOptionSet.has(typeFilter) ? typeFilter : ALL_FILTER;
  const normalizedSearchTerm = searchTerm.trim().toLowerCase();

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const typeMatched = effectiveTypeFilter === ALL_FILTER || row.type === effectiveTypeFilter;
        const nameMatched =
          !normalizedSearchTerm || row.displayName.toLowerCase().includes(normalizedSearchTerm);
        return typeMatched && nameMatched;
      }),
    [effectiveTypeFilter, normalizedSearchTerm, rows]
  );

  const filteredAuthFiles = useMemo(
    () =>
      authFiles.filter((file) =>
        effectiveTypeFilter === ALL_FILTER || normalizeCredentialType(file) === effectiveTypeFilter
      ),
    [authFiles, effectiveTypeFilter]
  );

  const credentialStats = useMemo(
    () =>
      filteredAuthFiles.reduce(
        (acc, file) => {
          const health = getCredentialHealth(file);
          acc[health] += 1;
          return acc;
        },
        { normal: 0, exhausted: 0, disabled: 0 } as Record<CredentialHealth, number>
      ),
    [filteredAuthFiles]
  );

  const resolveQuotaKey = useCallback(
    (row: CredentialRow): string | null => {
      if (row.quotaKey && (codexQuota[row.quotaKey] || authFiles.some((file) => file.name === row.quotaKey))) {
        return row.quotaKey;
      }
      if (row.authFileName) {
        if (codexQuota[row.authFileName]) {
          return row.authFileName;
        }
        const matchedByName = authFiles.find(
          (file) => isCodexAuthFile(file) && file.name === row.authFileName
        );
        if (matchedByName) {
          return matchedByName.name;
        }
      }
      if (row.authIndex) {
        const matchedByAuthIndex = authFiles.find(
          (file) =>
            isCodexAuthFile(file) &&
            normalizeAuthIndex(file['auth_index'] ?? file.authIndex) === row.authIndex
        );
        if (matchedByAuthIndex) {
          return matchedByAuthIndex.name;
        }
      }
      if (codexQuota[row.displayName]) {
        return row.displayName;
      }
      return null;
    },
    [authFiles, codexQuota]
  );

  const handleRefreshQuota = useCallback(
    async (row: CredentialRow) => {
      const quotaKey = resolveQuotaKey(row);
      if (!quotaKey) return;
      const authFile = authFiles.find((file) => file.name === quotaKey);
      if (!authFile) return;

      setRefreshingKeys((prev) => ({ ...prev, [quotaKey]: true }));
      setCodexQuota((prev) => ({
        ...prev,
        [quotaKey]: CODEX_CONFIG.buildLoadingState()
      }));

      try {
        const data = await CODEX_CONFIG.fetchQuota(authFile, t);
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
    [authFiles, resolveQuotaKey, setCodexQuota, t]
  );

  const rowCosts = useMemo(() => {
    const details = collectUsageDetails(usage);
    const buckets = new Map<string, Array<{ timestampMs: number; cost: number }>>();

    rows.forEach((row) => {
      buckets.set(row.key, []);
    });

    details.forEach((detail) => {
      const authIndex = normalizeAuthIndex(detail.auth_index);
      const sourceRaw = String(detail.source ?? '').trim();
      const sourceText = sourceRaw.startsWith('t:') ? sourceRaw.slice(2) : sourceRaw;
      const row = rows.find((item) => {
        if (item.authIndex && authIndex && item.authIndex === authIndex) return true;
        if (item.authFileName && sourceRaw && item.authFileName === sourceRaw) return true;
        if (item.authFileName && sourceText && item.authFileName === sourceText) return true;
        return false;
      });
      if (!row) return;
      const timestampMs = detail.__timestampMs ?? Date.parse(detail.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs <= 0) return;
      buckets.get(row.key)?.push({ timestampMs, cost: calculateCost(detail, modelPrices) });
    });

    return buckets;
  }, [modelPrices, rows, usage]);

  const windowCosts = useMemo(() => {
    const result = new Map<string, { fiveHourCost: number | null; weeklyCost: number | null }>();

    rows.forEach((row) => {
      const quotaKey = resolveQuotaKey(row);
      const quotaState = quotaKey ? (codexQuota[quotaKey] as CodexQuotaState | undefined) : undefined;
      const events = rowCosts.get(row.key) ?? [];
      const fiveHourWindow = quotaState?.windows?.find((window) => window.id === 'five-hour');
      const weeklyWindow = quotaState?.windows?.find((window) => window.id === 'weekly');
      const fiveHourInfo = toWindowCost(
        fiveHourWindow?.resetAtUnix ? fiveHourWindow.resetAtUnix * 1000 : null,
        5 * 60 * 60 * 1000
      );
      const weeklyInfo = toWindowCost(
        weeklyWindow?.resetAtUnix ? weeklyWindow.resetAtUnix * 1000 : null,
        7 * 24 * 60 * 60 * 1000
      );

      const sumInWindow = (startMs: number, endMs: number) =>
        events.reduce(
          (sum, item) => (item.timestampMs >= startMs && item.timestampMs <= endMs ? sum + item.cost : sum),
          0
        );

      result.set(row.key, {
        fiveHourCost: fiveHourInfo ? sumInWindow(fiveHourInfo.startMs, fiveHourInfo.endMs) : null,
        weeklyCost: weeklyInfo ? sumInWindow(weeklyInfo.startMs, weeklyInfo.endMs) : null
      });
    });

    return result;
  }, [codexQuota, resolveQuotaKey, rowCosts, rows]);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setSortKey(key);
      setSortDir(key === 'displayName' ? 'asc' : 'desc');
    },
    [sortKey]
  );

  const getSortValue = useCallback(
    (row: CredentialRow, key: SortKey) => {
      const costs = windowCosts.get(row.key);
      if (key === 'displayName') {
        return row.displayName;
      }
      if (key === 'fiveHourCost') {
        return costs?.fiveHourCost ?? -1;
      }
      if (key === 'weeklyCost') {
        return costs?.weeklyCost ?? -1;
      }
      return row[key];
    },
    [windowCosts]
  );

  const sortedRows = useMemo(() => {
    const direction = sortDir === 'asc' ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      const aValue = getSortValue(a, sortKey);
      const bValue = getSortValue(b, sortKey);

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return direction * aValue.localeCompare(bValue);
      }

      return direction * (Number(aValue) - Number(bValue));
    });
  }, [filteredRows, getSortValue, sortDir, sortKey]);

  const arrow = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const ariaSort = (key: SortKey): 'none' | 'ascending' | 'descending' =>
    sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <Card title={t('usage_stats.credential_stats')} className={`${styles.detailsFixedCard} ${styles.fullWidthSection}`}>
      <div className={styles.requestEventsToolbar}>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('monitoring_center.credential_filter_type')}
          </span>
          <Select
            value={effectiveTypeFilter}
            options={typeOptions}
            onChange={setTypeFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('monitoring_center.credential_filter_type')}
            fullWidth={false}
          />
        </div>
        <div className={`${styles.requestEventsFilterItem} ${styles.toolbarInputItem}`}>
          <span className={styles.requestEventsFilterLabel}>
            {t('monitoring_center.credential_search_label')}
          </span>
          <div className={`${styles.toolbarInputControl} ${styles.credentialSearchGroup}`}>
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.currentTarget.value)}
              placeholder={t('monitoring_center.credential_search_placeholder')}
              aria-label={t('monitoring_center.credential_search_label')}
              className={styles.credentialSearchInput}
            />
            <div className={styles.credentialStatsInline} aria-label={t('monitoring_center.credential_stats_label')}>
              <span className={styles.credentialStatChip}>
                {t('monitoring_center.credential_status_normal')}
                <strong>{credentialStats.normal}</strong>
              </span>
              <span className={styles.credentialStatChip}>
                {t('monitoring_center.credential_status_exhausted')}
                <strong>{credentialStats.exhausted}</strong>
              </span>
              <span className={styles.credentialStatChip}>
                {t('monitoring_center.credential_status_disabled')}
                <strong>{credentialStats.disabled}</strong>
              </span>
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rows.length > 0 ? (
        filteredRows.length > 0 ? (
          <div className={styles.detailsScroll}>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.sortableHeader} aria-sort={ariaSort('displayName')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('displayName')}
                      >
                        {t('usage_stats.credential_name')}{arrow('displayName')}
                      </button>
                    </th>
                    <th className={styles.credentialActionHeader}></th>
                    <th className={`${styles.sortableHeader} ${styles.metricColumn}`} aria-sort={ariaSort('requests')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('requests')}
                      >
                        {t('usage_stats.requests_count')}{arrow('requests')}
                      </button>
                    </th>
                    <th className={`${styles.sortableHeader} ${styles.metricColumn}`} aria-sort={ariaSort('tokens')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('tokens')}
                      >
                        {t('usage_stats.tokens_count')}{arrow('tokens')}
                      </button>
                    </th>
                    <th className={`${styles.sortableHeader} ${styles.metricColumn}`} aria-sort={ariaSort('successRate')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('successRate')}
                      >
                        {t('usage_stats.success_rate')}{arrow('successRate')}
                      </button>
                    </th>
                    <th className={`${styles.sortableHeader} ${styles.metricColumn}`} aria-sort={ariaSort('cost')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('cost')}
                      >
                        {t('usage_stats.total_cost')}{arrow('cost')}
                      </button>
                    </th>
                    <th className={`${styles.sortableHeader} ${styles.metricColumn}`} aria-sort={ariaSort('fiveHourCost')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('fiveHourCost')}
                      >
                        {t('monitoring_center.credential_cost_5h')}{arrow('fiveHourCost')}
                      </button>
                    </th>
                    <th className={`${styles.sortableHeader} ${styles.metricColumn}`} aria-sort={ariaSort('weeklyCost')}>
                      <button
                        type="button"
                        className={styles.sortHeaderButton}
                        onClick={() => handleSort('weeklyCost')}
                      >
                        {t('monitoring_center.credential_cost_7d')}{arrow('weeklyCost')}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => {
                    const resolvedQuotaKey = resolveQuotaKey(row);
                    const quotaState = resolvedQuotaKey
                      ? (codexQuota[resolvedQuotaKey] as CodexQuotaState | undefined)
                      : undefined;
                    const quotaWindows = (quotaState?.windows ?? [])
                      .filter((window) => window.id === 'five-hour' || window.id === 'weekly')
                      .map((window) => ({
                        id: window.id,
                        label: window.labelKey ? t(window.labelKey, window.labelParams ?? {}) : window.label,
                        remainingPercent:
                          typeof window.usedPercent === 'number'
                            ? `${Math.max(0, Math.min(100, Math.round(100 - window.usedPercent)))}%`
                            : '--'
                      }));
                    const quotaCosts = windowCosts.get(row.key);
                    const isRefreshing = resolvedQuotaKey ? refreshingKeys[resolvedQuotaKey] === true : false;
                    return (
                      <tr key={row.key}>
                        <td className={styles.modelCell}>
                          <div>
                            <span>{row.displayName}</span>
                            {row.type && <span className={styles.credentialType}>{row.type}</span>}
                          </div>
                        </td>
                        <td className={styles.credentialActionCell}>
                          {resolvedQuotaKey ? (
                            <div className={styles.credentialQuotaInline}>
                              <Button
                                variant="secondary"
                                size="sm"
                                className={styles.credentialRefreshButton}
                                loading={isRefreshing}
                                onClick={() => void handleRefreshQuota(row)}
                              >
                                {t('codex_quota.refresh_button')}
                              </Button>
                              {quotaWindows.length > 0 ? (
                                <div className={styles.quotaSummary}>
                                  {quotaWindows.map((window) => (
                                    <span key={window.id} className={styles.quotaChip}>
                                      {window.label}:{window.remainingPercent}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              {quotaState?.status === 'error' ? (
                                <span className={styles.quotaChipError}>{quotaState.error}</span>
                              ) : null}
                            </div>
                          ) : null}
                        </td>
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
                        <td>{row.cost > 0 ? formatUsd(row.cost) : '--'}</td>
                        <td className={styles.windowCostCell}>
                          {quotaCosts?.fiveHourCost !== null && quotaCosts?.fiveHourCost !== undefined
                            ? formatUsd(quotaCosts.fiveHourCost)
                            : '--'}
                        </td>
                        <td className={styles.windowCostCell}>
                          {quotaCosts?.weeklyCost !== null && quotaCosts?.weeklyCost !== undefined
                            ? formatUsd(quotaCosts.weeklyCost)
                            : '--'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState
            title={t('monitoring_center.credential_no_result_title')}
            description={t('monitoring_center.credential_no_result_desc')}
          />
        )
      ) : (
        <div className={styles.hint}>{t('usage_stats.no_data')}</div>
      )}
    </Card>
  );
}
