import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthRefreshQueueCountdownCard } from '@/components/credentialCenter/AuthRefreshQueueCountdownCard';
import { CodexCredentialQuotaCard } from '@/components/credentialCenter/CodexCredentialQuotaCard';
import { AntigravityCredentialQuotaCard } from '@/components/credentialCenter/AntigravityCredentialQuotaCard';
import { CredentialStatsCard } from '@/components/credentialCenter/CredentialStatsCard';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useUsageData, type UsagePayload } from '@/components/usage';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { authFilesApi } from '@/services/api/authFiles';
import { authRefreshQueueApi } from '@/services/api/authRefreshQueue';
import type { AuthFileItem } from '@/types/authFile';
import type { AuthRefreshQueueResponse } from '@/types/authRefreshQueue';
import { filterUsageByTimeRange, type UsageTimeRange } from '@/utils/usage';
import {
  DEFAULT_USAGE_TIME_RANGE,
  USAGE_TIME_RANGE_OPTIONS,
  isUsageTimeRange
} from '@/utils/usageTimeRange';
import styles from './CredentialCenterPage.module.scss';

const TIME_RANGE_STORAGE_KEY = 'cli-proxy-credential-center-time-range-v1';
const CREDENTIAL_USAGE_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;

const loadTimeRange = (): UsageTimeRange => {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_USAGE_TIME_RANGE;
    }
    const raw = localStorage.getItem(TIME_RANGE_STORAGE_KEY);
    return isUsageTimeRange(raw) ? raw : DEFAULT_USAGE_TIME_RANGE;
  } catch {
    return DEFAULT_USAGE_TIME_RANGE;
  }
};

export function CredentialCenterPage() {
  const { t } = useTranslation();
  const [timeRange, setTimeRange] = useState<UsageTimeRange>(loadTimeRange);
  const {
    usage,
    loading,
    error,
    lastRefreshedAt,
    modelPrices,
    loadUsage,
  } = useUsageData({
    timeRange,
    minimumLookbackMs: CREDENTIAL_USAGE_LOOKBACK_MS,
    refreshFullRange: true
  });
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);
  const [authRefreshQueue, setAuthRefreshQueue] = useState<AuthRefreshQueueResponse | null>(null);
  const [authRefreshQueueLoading, setAuthRefreshQueueLoading] = useState(false);
  const [authRefreshQueueError, setAuthRefreshQueueError] = useState<string | null>(null);

  const loadAuthFiles = useCallback(async () => {
    const res = await authFilesApi.list();
    const files = Array.isArray(res) ? res : (res as { files?: AuthFileItem[] })?.files;
    if (!Array.isArray(files)) return;
    setAuthFiles(files);
  }, []);

  const loadAuthRefreshQueue = useCallback(async () => {
    setAuthRefreshQueueLoading(true);
    try {
      const payload = await authRefreshQueueApi.list();
      setAuthRefreshQueue(payload);
      setAuthRefreshQueueError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('credential_center.refresh_queue_load_error');
      setAuthRefreshQueueError(message || t('credential_center.refresh_queue_load_error'));
    } finally {
      setAuthRefreshQueueLoading(false);
    }
  }, [t]);

  const handleRefresh = useCallback(async () => {
    await Promise.all([loadUsage(), loadAuthFiles(), loadAuthRefreshQueue()]);
  }, [loadAuthFiles, loadAuthRefreshQueue, loadUsage]);

  useHeaderRefresh(handleRefresh);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.all([loadAuthFiles(), loadAuthRefreshQueue()]).catch(() => {});
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAuthFiles, loadAuthRefreshQueue]);

  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.setItem(TIME_RANGE_STORAGE_KEY, timeRange);
    } catch {
      // Ignore storage errors.
    }
  }, [timeRange]);

  const filteredUsage = useMemo(
    () => (usage ? filterUsageByTimeRange(usage, timeRange) : null),
    [usage, timeRange]
  );

  const handleTimeRangeChange = useCallback((range: UsageTimeRange) => {
    setTimeRange(range);
  }, []);

  return (
    <div className={styles.container}>
      {loading && !usage && (
        <div className={styles.loadingOverlay} aria-busy="true">
          <div className={styles.loadingOverlayContent}>
            <LoadingSpinner size={28} className={styles.loadingOverlaySpinner} />
            <span className={styles.loadingOverlayText}>{t('common.loading')}</span>
          </div>
        </div>
      )}

      <div className={styles.header}>
        <h1 className={styles.pageTitle}>{t('credential_center.title')}</h1>
        <div className={styles.headerActions}>
          <div className={styles.timeRangeButtons}>
            {USAGE_TIME_RANGE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant={timeRange === option.value ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => handleTimeRangeChange(option.value)}
              >
                {t(option.labelKey)}
              </Button>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleRefresh().catch(() => {})}
            disabled={loading || authRefreshQueueLoading}
          >
            {loading || authRefreshQueueLoading ? t('common.loading') : t('usage_stats.refresh')}
          </Button>
          {lastRefreshedAt && (
            <span className={styles.lastRefreshed}>
              {t('usage_stats.last_updated')}: {lastRefreshedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <AuthRefreshQueueCountdownCard
        queue={authRefreshQueue?.queue ?? []}
        loading={authRefreshQueueLoading}
        error={authRefreshQueueError}
        generatedAt={authRefreshQueue?.generated_at ?? null}
        onRefresh={loadAuthRefreshQueue}
      />

      <div className={styles.credentialCenterGrid}>
        <CredentialStatsCard
          usage={filteredUsage as UsagePayload | null}
          loading={loading}
          modelPrices={modelPrices}
          authFiles={authFiles}
        />
        <CodexCredentialQuotaCard
          usage={usage as UsagePayload | null}
          loading={loading}
          modelPrices={modelPrices}
          authFiles={authFiles}
        />
      </div>

      <div className={styles.credentialCenterGrid}>
        <AntigravityCredentialQuotaCard
          usage={usage as UsagePayload | null}
          loading={loading}
          modelPrices={modelPrices}
          authFiles={authFiles}
          quotaType="claude"
        />

        <AntigravityCredentialQuotaCard
          usage={usage as UsagePayload | null}
          loading={loading}
          modelPrices={modelPrices}
          authFiles={authFiles}
          quotaType="gemini"
        />
      </div>
    </div>
  );
}
