import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { IconMinus } from '@/components/ui/icons';
import { getAuthFileStatusMessage } from '@/features/authFiles/constants';
import { useInterval } from '@/hooks/useInterval';
import { authFilesApi } from '@/services/api/authFiles';
import { useNotificationStore, useUsageStatsStore } from '@/stores';
import type { GeminiKeyConfig, ProviderKeyConfig, OpenAIProviderConfig } from '@/types';
import type { AuthFileItem } from '@/types/authFile';
import type { CredentialInfo } from '@/types/sourceInfo';
import { buildSourceInfoMap, resolveSourceDisplay } from '@/utils/sourceResolver';
import { parseTimestampMs } from '@/utils/timestamp';
import {
  collectUsageDetails,
  extractFirstByteLatencyMs,
  extractGenerationMs,
  extractTotalTokens,
  formatDurationMs,
  normalizeAuthIndex,
  type UsageThinking,
} from '@/utils/usage';
import { downloadBlob } from '@/utils/download';
import styles from '@/pages/UsagePage.module.scss';

const ALL_FILTER = '__all__';
const RESULT_SUCCESS_FILTER = 'success';
const RESULT_FAILURE_FILTER = 'failure';
const MAX_RENDERED_EVENTS = 500;

type RequestEventRow = {
  id: string;
  backendId: string | null;
  timestamp: string;
  timestampMs: number;
  timestampLabel: string;
  model: string;
  sourceKey: string;
  sourceRaw: string;
  source: string;
  sourceType: string;
  authIndex: string;
  failed: boolean;
  firstByteLatencyMs: number | null;
  generationMs: number | null;
  tps: number | null;
  thinking: UsageThinking | null;
  thinkingLabel: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  cacheHitRatio: number | null;
};

export interface RequestEventsDetailsCardProps {
  usage: unknown;
  loading: boolean;
  geminiKeys: GeminiKeyConfig[];
  claudeConfigs: ProviderKeyConfig[];
  codexConfigs: ProviderKeyConfig[];
  vertexConfigs: ProviderKeyConfig[];
  openaiProviders: OpenAIProviderConfig[];
  authFiles?: AuthFileItem[];
  onRefresh?: () => Promise<void> | void;
  lastRefreshedAt?: Date | null;
}

const AUTO_REFRESH_OFF = 'off';
const AUTO_REFRESH_CUSTOM = 'custom';
const AUTO_REFRESH_INTERVALS = {
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '5m': 300_000,
} as const;
const MIN_CUSTOM_AUTO_REFRESH_SECONDS = 5;
const MAX_CUSTOM_AUTO_REFRESH_SECONDS = 3600;
const DEFAULT_CUSTOM_AUTO_REFRESH_SECONDS = 60;

type AutoRefreshValue =
  | keyof typeof AUTO_REFRESH_INTERVALS
  | typeof AUTO_REFRESH_OFF
  | typeof AUTO_REFRESH_CUSTOM;

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
};

const normalizeCustomAutoRefreshSeconds = (value: unknown): number => {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CUSTOM_AUTO_REFRESH_SECONDS;
  }
  return Math.min(Math.max(parsed, MIN_CUSTOM_AUTO_REFRESH_SECONDS), MAX_CUSTOM_AUTO_REFRESH_SECONDS);
};

const normalizeThinkingText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const formatThinkingLabel = (thinking: UsageThinking | null): string => {
  if (!thinking) return '-';

  const intensity = normalizeThinkingText(thinking.intensity);
  const level = normalizeThinkingText(thinking.level);
  const mode = normalizeThinkingText(thinking.mode);
  const budget =
    typeof thinking.budget === 'number' && Number.isFinite(thinking.budget)
      ? thinking.budget
      : null;
  const label = intensity || level || (budget !== null ? String(budget) : mode);
  const budgetLabel = budget !== null ? budget.toLocaleString() : null;

  if (!label) return '-';
  if (budgetLabel !== null && label === String(budget)) {
    return budgetLabel;
  }
  if (mode === 'budget' && budget !== null && budget > 0) {
    return `${label} (${budgetLabel})`;
  }
  if (budget === -1 && label !== 'auto') {
    return `${label} (-1)`;
  }
  return label;
};

const formatCacheHitRatio = (ratio: number | null): string => {
  if (ratio === null) return '--';
  return `${(ratio * 100).toFixed(1)}%`;
};

const encodeCsv = (value: string | number): string => {
  const text = String(value ?? '');
  const trimmedLeft = text.replace(/^\s+/, '');
  const safeText = trimmedLeft && /^[=+\-@]/.test(trimmedLeft) ? `'${text}` : text;
  return `"${safeText.replace(/"/g, '""')}"`;
};

export function RequestEventsDetailsCard({
  usage,
  loading,
  geminiKeys,
  claudeConfigs,
  codexConfigs,
  vertexConfigs,
  openaiProviders,
  authFiles,
  onRefresh,
  lastRefreshedAt,
}: RequestEventsDetailsCardProps) {
  const { t, i18n } = useTranslation();
  const { showConfirmation, showNotification } = useNotificationStore();
  const deleteUsageRecords = useUsageStatsStore((state) => state.deleteUsageRecords);

  const [modelFilter, setModelFilter] = useState(ALL_FILTER);
  const [sourceFilter, setSourceFilter] = useState(ALL_FILTER);
  const [resultFilter, setResultFilter] = useState(ALL_FILTER);
  const [autoRefreshValue, setAutoRefreshValue] = useState<AutoRefreshValue>(AUTO_REFRESH_OFF);
  const [customAutoRefreshSeconds, setCustomAutoRefreshSeconds] = useState(
    DEFAULT_CUSTOM_AUTO_REFRESH_SECONDS.toString()
  );
  const [localAuthFiles, setLocalAuthFiles] = useState<AuthFileItem[]>([]);
  const [selectedFailureRow, setSelectedFailureRow] = useState<RequestEventRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [nextRefreshAtMs, setNextRefreshAtMs] = useState<number | null>(null);
  const [countdownNowMs, setCountdownNowMs] = useState(() => Date.now());

  const resolvedAuthFiles = authFiles ?? localAuthFiles;

  const refreshAuthFiles = useCallback(async () => {
    if (authFiles) return;
    try {
      const res = await authFilesApi.list();
      const files = Array.isArray(res) ? res : (res as { files?: AuthFileItem[] })?.files;
      if (!Array.isArray(files)) return;
      setLocalAuthFiles(files);
    } catch {
      // Ignore auth file refresh failures.
    }
  }, [authFiles]);

  useEffect(() => {
    if (authFiles) return;
    void refreshAuthFiles();
  }, [authFiles, refreshAuthFiles]);

  useEffect(() => {
    if (authFiles || !lastRefreshedAt) {
      return;
    }
    void refreshAuthFiles();
  }, [authFiles, lastRefreshedAt, refreshAuthFiles]);

  const authFileMap = useMemo(() => {
    const map = new Map<string, CredentialInfo>();
    resolvedAuthFiles.forEach((file) => {
      const key = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
      if (!key) return;
      map.set(key, {
        name: file.name || key,
        type: (file.type || file.provider || '').toString(),
        statusMessage: getAuthFileStatusMessage(file),
      });
    });
    return map;
  }, [resolvedAuthFiles]);

  const sourceInfoMap = useMemo(
    () =>
      buildSourceInfoMap({
        geminiApiKeys: geminiKeys,
        claudeApiKeys: claudeConfigs,
        codexApiKeys: codexConfigs,
        vertexApiKeys: vertexConfigs,
        openaiCompatibility: openaiProviders,
      }),
    [claudeConfigs, codexConfigs, geminiKeys, openaiProviders, vertexConfigs]
  );

  const autoRefreshOptions = useMemo(
    () => [
      { value: AUTO_REFRESH_OFF, label: t('monitoring_center.auto_refresh_off') },
      { value: '15s', label: '15s' },
      { value: '30s', label: '30s' },
      { value: '1m', label: '1m' },
      { value: '5m', label: '5m' },
      { value: AUTO_REFRESH_CUSTOM, label: t('monitoring_center.auto_refresh_custom') }
    ],
    [t]
  );
  const normalizedCustomAutoRefreshSeconds = useMemo(
    () => normalizeCustomAutoRefreshSeconds(customAutoRefreshSeconds),
    [customAutoRefreshSeconds]
  );
  const autoRefreshDelay = useMemo(() => {
    if (!onRefresh || autoRefreshValue === AUTO_REFRESH_OFF) {
      return null;
    }
    if (autoRefreshValue === AUTO_REFRESH_CUSTOM) {
      return normalizedCustomAutoRefreshSeconds * 1000;
    }
    return AUTO_REFRESH_INTERVALS[autoRefreshValue];
  }, [autoRefreshValue, normalizedCustomAutoRefreshSeconds, onRefresh]);

  useEffect(() => {
    if (!autoRefreshDelay) {
      setNextRefreshAtMs(null);
      return;
    }

    const now = Date.now();
    setCountdownNowMs(now);

    const nextFromRefresh = lastRefreshedAt ? lastRefreshedAt.getTime() + autoRefreshDelay : null;
    const nextRefreshAt =
      nextFromRefresh && nextFromRefresh > now ? nextFromRefresh : now + autoRefreshDelay;

    setNextRefreshAtMs(nextRefreshAt);
  }, [autoRefreshDelay, lastRefreshedAt]);

  useInterval(() => {
    setCountdownNowMs(Date.now());
  }, autoRefreshDelay ? 1000 : null);

  const handleCustomAutoRefreshSecondsChange = useCallback((value: string) => {
    setCustomAutoRefreshSeconds(value.replace(/\D/g, ''));
  }, []);

  const handleCustomAutoRefreshSecondsBlur = useCallback(() => {
    setCustomAutoRefreshSeconds(normalizeCustomAutoRefreshSeconds(customAutoRefreshSeconds).toString());
  }, [customAutoRefreshSeconds]);

  useInterval(() => {
    if (!onRefresh || loading || !autoRefreshDelay) return;
    setNextRefreshAtMs(Date.now() + autoRefreshDelay);
    void onRefresh();
  }, autoRefreshDelay);

  const autoRefreshCountdown =
    autoRefreshDelay && nextRefreshAtMs
      ? Math.max(0, Math.ceil((nextRefreshAtMs - countdownNowMs) / 1000))
      : null;

  const rows = useMemo<RequestEventRow[]>(() => {
    const details = collectUsageDetails(usage);

    const baseRows = details.map((detail, index) => {
      const timestamp = detail.timestamp;
      const timestampMs =
        typeof detail.__timestampMs === 'number' && detail.__timestampMs > 0
          ? detail.__timestampMs
          : parseTimestampMs(timestamp);
      const date = Number.isNaN(timestampMs) ? null : new Date(timestampMs);
      const sourceRaw = String(detail.source ?? '').trim();
      const authIndexRaw = detail.auth_index as unknown;
      const authIndex =
        authIndexRaw === null || authIndexRaw === undefined || authIndexRaw === ''
          ? '-'
          : String(authIndexRaw);
      const sourceInfo = resolveSourceDisplay(sourceRaw, authIndexRaw, sourceInfoMap, authFileMap);
      const source = sourceInfo.displayName;
      const sourceKey = sourceInfo.identityKey ?? `source:${sourceRaw || source}`;
      const sourceType = sourceInfo.type;
      const model = String(detail.__modelName ?? '').trim() || '-';
      const inputTokens = Math.max(toNumber(detail.tokens?.input_tokens), 0);
      const outputTokens = Math.max(toNumber(detail.tokens?.output_tokens), 0);
      const reasoningTokens = Math.max(toNumber(detail.tokens?.reasoning_tokens), 0);
      const cachedTokens = Math.max(
        Math.max(toNumber(detail.tokens?.cached_tokens), 0),
        Math.max(toNumber(detail.tokens?.cache_tokens), 0)
      );
      const totalTokens = Math.max(
        toNumber(detail.tokens?.total_tokens),
        extractTotalTokens(detail)
      );
      const backendId = typeof detail.id === 'string' && detail.id.trim() ? detail.id.trim() : null;
      const firstByteLatencyMs = extractFirstByteLatencyMs(detail);
      const generationMs = extractGenerationMs(detail);
      const tps = generationMs && generationMs > 0 ? outputTokens / (generationMs / 1000) : null;
      const thinking = detail.thinking ?? null;
      const thinkingEffort = normalizeThinkingText(detail.thinking_effort);
      const thinkingLabel = thinkingEffort || formatThinkingLabel(thinking);
      const cacheHitRatio = inputTokens > 0 ? cachedTokens / inputTokens : null;

      return {
        id: backendId ?? `${timestamp}-${model}-${sourceKey}-${authIndex}-${index}`,
        backendId,
        timestamp,
        timestampMs: Number.isNaN(timestampMs) ? 0 : timestampMs,
        timestampLabel: date ? date.toLocaleString(i18n.language) : timestamp || '-',
        model,
        sourceKey,
        sourceRaw: sourceRaw || '-',
        source,
        sourceType,
        authIndex,
        failed: detail.failed === true,
        firstByteLatencyMs,
        generationMs,
        tps,
        thinking,
        thinkingLabel,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedTokens,
        totalTokens,
        cacheHitRatio,
      };
    });

    const sourceLabelKeyMap = new Map<string, Set<string>>();
    baseRows.forEach((row) => {
      const keys = sourceLabelKeyMap.get(row.source) ?? new Set<string>();
      keys.add(row.sourceKey);
      sourceLabelKeyMap.set(row.source, keys);
    });

    const buildDisambiguatedSourceLabel = (row: RequestEventRow) => {
      const labelKeyCount = sourceLabelKeyMap.get(row.source)?.size ?? 0;
      if (labelKeyCount <= 1) {
        return row.source;
      }

      if (row.authIndex !== '-') {
        return `${row.source} · ${row.authIndex}`;
      }

      if (row.sourceRaw !== '-' && row.sourceRaw !== row.source) {
        return `${row.source} · ${row.sourceRaw}`;
      }

      if (row.sourceType) {
        return `${row.source} · ${row.sourceType}`;
      }

      return `${row.source} · ${row.sourceKey}`;
    };

    return baseRows
      .map((row) => ({
        ...row,
        source: buildDisambiguatedSourceLabel(row),
      }))
      .sort((a, b) => b.timestampMs - a.timestampMs);
  }, [authFileMap, i18n.language, sourceInfoMap, usage]);

  const hasTimingData = useMemo(
    () => rows.some((row) => row.firstByteLatencyMs !== null || row.generationMs !== null),
    [rows]
  );

  const modelOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(new Set(rows.map((row) => row.model))).map((model) => ({
        value: model,
        label: model,
      })),
    ],
    [rows, t]
  );

  const sourceOptions = useMemo(() => {
    const optionMap = new Map<string, string>();
    rows.forEach((row) => {
      if (!optionMap.has(row.sourceKey)) {
        optionMap.set(row.sourceKey, row.source);
      }
    });

    return [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      ...Array.from(optionMap.entries()).map(([value, label]) => ({
        value,
        label,
      })),
    ];
  }, [rows, t]);

  const resultOptions = useMemo(
    () => [
      { value: ALL_FILTER, label: t('usage_stats.filter_all') },
      { value: RESULT_SUCCESS_FILTER, label: t('stats.success') },
      { value: RESULT_FAILURE_FILTER, label: t('stats.failure') },
    ],
    [t]
  );

  const modelOptionSet = useMemo(
    () => new Set(modelOptions.map((option) => option.value)),
    [modelOptions]
  );
  const sourceOptionSet = useMemo(
    () => new Set(sourceOptions.map((option) => option.value)),
    [sourceOptions]
  );
  const resultOptionSet = useMemo(
    () => new Set(resultOptions.map((option) => option.value)),
    [resultOptions]
  );

  const effectiveModelFilter = modelOptionSet.has(modelFilter) ? modelFilter : ALL_FILTER;
  const effectiveSourceFilter = sourceOptionSet.has(sourceFilter) ? sourceFilter : ALL_FILTER;
  const effectiveResultFilter = resultOptionSet.has(resultFilter) ? resultFilter : ALL_FILTER;

  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const modelMatched =
          effectiveModelFilter === ALL_FILTER || row.model === effectiveModelFilter;
        const sourceMatched =
          effectiveSourceFilter === ALL_FILTER || row.sourceKey === effectiveSourceFilter;
        const resultMatched =
          effectiveResultFilter === ALL_FILTER ||
          (effectiveResultFilter === RESULT_FAILURE_FILTER ? row.failed : !row.failed);
        return modelMatched && sourceMatched && resultMatched;
      }),
    [effectiveModelFilter, effectiveResultFilter, effectiveSourceFilter, rows]
  );

  const renderedRows = useMemo(() => filteredRows.slice(0, MAX_RENDERED_EVENTS), [filteredRows]);

  const hasActiveFilters =
    effectiveModelFilter !== ALL_FILTER ||
    effectiveSourceFilter !== ALL_FILTER ||
    effectiveResultFilter !== ALL_FILTER;

  const handleClearFilters = () => {
    setModelFilter(ALL_FILTER);
    setSourceFilter(ALL_FILTER);
    setResultFilter(ALL_FILTER);
  };

  const handleExportCsv = () => {
    if (!filteredRows.length) return;

    const csvHeader = [
      'timestamp',
      'model',
      'source',
      'source_raw',
      'result',
      ...(hasTimingData ? ['first_byte_latency_ms', 'generation_ms', 'tps'] : []),
      'thinking_effort',
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'cached_tokens',
      'total_tokens',
      'cache_hit_ratio',
    ];

    const csvRows = filteredRows.map((row) =>
      [
        row.timestamp,
        row.model,
        row.source,
        row.sourceRaw,
        row.failed ? 'failed' : 'success',
        ...(hasTimingData
          ? [
              row.firstByteLatencyMs ?? '',
              row.generationMs ?? '',
              row.tps !== null ? row.tps.toFixed(2) : '',
            ]
          : []),
        row.thinkingLabel === '-' ? '' : row.thinkingLabel,
        row.inputTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.cachedTokens,
        row.totalTokens,
        row.cacheHitRatio !== null ? row.cacheHitRatio.toFixed(4) : '',
      ]
        .map((value) => encodeCsv(value))
        .join(',')
    );

    const content = [csvHeader.join(','), ...csvRows].join('\n');
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.csv`,
      blob: new Blob([content], { type: 'text/csv;charset=utf-8' }),
    });
  };

  const handleExportJson = () => {
    if (!filteredRows.length) return;

    const payload = filteredRows.map((row) => ({
      timestamp: row.timestamp,
      model: row.model,
      source: row.source,
      source_raw: row.sourceRaw,
      failed: row.failed,
      ...(hasTimingData && row.firstByteLatencyMs !== null
        ? { first_byte_latency_ms: row.firstByteLatencyMs }
        : {}),
      ...(hasTimingData && row.generationMs !== null ? { generation_ms: row.generationMs } : {}),
      ...(hasTimingData && row.tps !== null ? { tps: row.tps } : {}),
      ...(row.thinkingLabel !== '-' ? { thinking_effort: row.thinkingLabel } : {}),
      tokens: {
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        reasoning_tokens: row.reasoningTokens,
        cached_tokens: row.cachedTokens,
        total_tokens: row.totalTokens,
      },
      ...(row.cacheHitRatio !== null ? { cache_hit_ratio: row.cacheHitRatio } : {}),
    }));

    const content = JSON.stringify(payload, null, 2);
    const fileTime = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob({
      filename: `usage-events-${fileTime}.json`,
      blob: new Blob([content], { type: 'application/json;charset=utf-8' }),
    });
  };

  const handleDeleteRow = useCallback(
    (row: RequestEventRow) => {
      const backendId = row.backendId;
      if (!backendId) return;
      showConfirmation({
        title: t('usage_stats.request_events_delete_title'),
        message: t('usage_stats.request_events_delete_confirm'),
        confirmText: t('common.confirm'),
        variant: 'danger',
        onConfirm: async () => {
          setDeletingId(backendId);
          try {
            await deleteUsageRecords([backendId]);
            showNotification(t('usage_stats.request_events_delete_success'), 'success');
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : '';
            showNotification(
              `${t('usage_stats.request_events_delete_failed')}${message ? `: ${message}` : ''}`,
              'error'
            );
            throw err;
          } finally {
            setDeletingId(null);
          }
        },
      });
    },
    [deleteUsageRecords, showConfirmation, showNotification, t]
  );

  const selectedCredentialInfo = useMemo(() => {
    if (!selectedFailureRow) return null;
    const normalizedAuthIndex = normalizeAuthIndex(selectedFailureRow.authIndex);
    if (!normalizedAuthIndex) return null;
    return authFileMap.get(normalizedAuthIndex) ?? null;
  }, [authFileMap, selectedFailureRow]);
  const selectedFailureMessage = selectedCredentialInfo?.statusMessage?.trim() || '';

  return (
    <Card
      title={t('usage_stats.request_events_title')}
      extra={
        <div className={styles.requestEventsActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearFilters}
            disabled={!hasActiveFilters}
          >
            {t('usage_stats.clear_filters')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportCsv}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_csv')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExportJson}
            disabled={filteredRows.length === 0}
          >
            {t('usage_stats.export_json')}
          </Button>
        </div>
      }
    >
      <div className={styles.requestEventsToolbar}>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_model')}
          </span>
          <Select
            value={effectiveModelFilter}
            options={modelOptions}
            onChange={setModelFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_model')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_source')}
          </span>
          <Select
            value={effectiveSourceFilter}
            options={sourceOptions}
            onChange={setSourceFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_source')}
            fullWidth={false}
          />
        </div>
        <div className={styles.requestEventsFilterItem}>
          <span className={styles.requestEventsFilterLabel}>
            {t('usage_stats.request_events_filter_result')}
          </span>
          <Select
            value={effectiveResultFilter}
            options={resultOptions}
            onChange={setResultFilter}
            className={styles.requestEventsSelect}
            ariaLabel={t('usage_stats.request_events_filter_result')}
            fullWidth={false}
          />
        </div>
        {onRefresh && (
          <div className={styles.requestEventsFilterItem}>
            <span className={styles.requestEventsFilterLabelRow}>
              <span className={styles.requestEventsFilterLabel}>{t('monitoring_center.auto_refresh')}</span>
              {autoRefreshCountdown !== null && (
                <span className={styles.requestEventsCountdown}>
                  {t('monitoring_center.auto_refresh_countdown', { count: autoRefreshCountdown })}
                </span>
              )}
            </span>
            <div className={styles.requestEventsAutoRefreshControls}>
              <Select
                value={autoRefreshValue}
                options={autoRefreshOptions}
                onChange={(value) => setAutoRefreshValue(value as AutoRefreshValue)}
                className={styles.requestEventsSelect}
                ariaLabel={t('monitoring_center.auto_refresh')}
                fullWidth={false}
              />
              {autoRefreshValue === AUTO_REFRESH_CUSTOM && (
                <Input
                  type="text"
                  inputMode="numeric"
                  value={customAutoRefreshSeconds}
                  onChange={(event) => handleCustomAutoRefreshSecondsChange(event.target.value)}
                  onBlur={handleCustomAutoRefreshSecondsBlur}
                  className={styles.requestEventsAutoRefreshInput}
                  aria-label={t('monitoring_center.auto_refresh_custom_seconds')}
                  placeholder={normalizedCustomAutoRefreshSeconds.toString()}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {loading && rows.length === 0 ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_empty_title')}
          description={t('usage_stats.request_events_empty_desc')}
        />
      ) : filteredRows.length === 0 ? (
        <EmptyState
          title={t('usage_stats.request_events_no_result_title')}
          description={t('usage_stats.request_events_no_result_desc')}
        />
      ) : (
        <>
          <div className={styles.requestEventsMeta}>
            <span>{t('usage_stats.request_events_count', { count: filteredRows.length })}</span>
            {filteredRows.length > MAX_RENDERED_EVENTS && (
              <span className={styles.requestEventsLimitHint}>
                {t('usage_stats.request_events_limit_hint', {
                  shown: MAX_RENDERED_EVENTS,
                  total: filteredRows.length,
                })}
              </span>
            )}
          </div>

          <div className={styles.requestEventsTableWrapper}>
            <table className={`${styles.table} ${styles.requestEventsTable}`}>
              <colgroup>
                <col className={styles.requestEventsActionCol} />
                <col className={styles.requestEventsTimestampCol} />
                <col className={styles.requestEventsModelCol} />
                <col className={styles.requestEventsSourceCol} />
                <col className={styles.requestEventsResultCol} />
                {hasTimingData && <col className={styles.requestEventsTimingCol} />}
                {hasTimingData && <col className={styles.requestEventsTimingCol} />}
                {hasTimingData && <col className={styles.requestEventsTimingCol} />}
                <col className={styles.requestEventsThinkingCol} />
                <col className={styles.requestEventsTokenCol} />
                <col className={styles.requestEventsTokenCol} />
                <col className={styles.requestEventsTokenCol} />
                <col className={styles.requestEventsTokenCol} />
                <col className={styles.requestEventsTokenCol} />
                <col className={styles.requestEventsTokenCol} />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label={t('usage_stats.request_events_delete_action')} />
                  <th>{t('usage_stats.request_events_timestamp')}</th>
                  <th>{t('usage_stats.model_name')}</th>
                  <th>{t('usage_stats.request_events_source')}</th>
                  <th>{t('usage_stats.request_events_result')}</th>
                  {hasTimingData && <th>{t('usage_stats.first_byte_latency')}</th>}
                  {hasTimingData && <th>{t('usage_stats.generation_time')}</th>}
                  {hasTimingData && <th>{t('usage_stats.request_events_tps')}</th>}
                  <th>{t('usage_stats.thinking_intensity')}</th>
                  <th>{t('usage_stats.input_tokens')}</th>
                  <th>{t('usage_stats.output_tokens')}</th>
                  <th>{t('usage_stats.reasoning_tokens')}</th>
                  <th>{t('usage_stats.cached_tokens')}</th>
                  <th>{t('usage_stats.total_tokens')}</th>
                  <th>{t('usage_stats.cache_hit')}</th>
                </tr>
              </thead>
              <tbody>
                {renderedRows.map((row) => (
                  <tr key={row.id}>
                    <td className={styles.requestEventsDeleteCell}>
                      <button
                        type="button"
                        className={styles.requestEventsDeleteButton}
                        onClick={() => handleDeleteRow(row)}
                        disabled={!row.backendId || deletingId === row.backendId}
                        title={t('usage_stats.request_events_delete_action')}
                        aria-label={t('usage_stats.request_events_delete_action')}
                      >
                        <IconMinus size={14} />
                      </button>
                    </td>
                    <td title={row.timestamp} className={styles.requestEventsTimestamp}>
                      {row.timestampLabel}
                    </td>
                    <td className={styles.modelCell}>{row.model}</td>
                    <td className={styles.requestEventsSourceCell} title={row.source}>
                      <span>{row.source}</span>
                      {row.sourceType && (
                        <span className={styles.credentialType}>{row.sourceType}</span>
                      )}
                    </td>
                    <td>
                      {row.failed ? (
                        <button
                          type="button"
                          className={`${styles.requestEventsResultFailed} ${styles.requestEventsResultButton}`}
                          onClick={() => setSelectedFailureRow(row)}
                          aria-label={t('usage_stats.request_events_failure_log_view')}
                        >
                          {t('stats.failure')}
                        </button>
                      ) : (
                        <span className={styles.requestEventsResultSuccess}>{t('stats.success')}</span>
                      )}
                    </td>
                    {hasTimingData && (
                      <td className={styles.durationCell}>{formatDurationMs(row.firstByteLatencyMs)}</td>
                    )}
                    {hasTimingData && (
                      <td className={styles.durationCell}>{formatDurationMs(row.generationMs)}</td>
                    )}
                    {hasTimingData && <td>{row.tps !== null ? row.tps.toFixed(2) : '--'}</td>}
                    <td>
                      <span
                        className={
                          row.thinkingLabel !== '-'
                            ? styles.requestEventsThinkingBadge
                            : styles.requestEventsThinkingEmpty
                        }
                        title={
                          row.thinking
                            ? [
                                row.thinking.mode
                                  ? `${t('usage_stats.thinking_mode')}: ${row.thinking.mode}`
                                  : '',
                                row.thinking.level
                                  ? `${t('usage_stats.thinking_level')}: ${row.thinking.level}`
                                  : '',
                                typeof row.thinking.budget === 'number'
                                  ? `${t('usage_stats.thinking_budget')}: ${row.thinking.budget.toLocaleString()}`
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(' · ')
                            : undefined
                        }
                      >
                        {row.thinkingLabel}
                      </span>
                    </td>
                    <td>{row.inputTokens.toLocaleString()}</td>
                    <td>{row.outputTokens.toLocaleString()}</td>
                    <td>{row.reasoningTokens.toLocaleString()}</td>
                    <td>{row.cachedTokens.toLocaleString()}</td>
                    <td>{row.totalTokens.toLocaleString()}</td>
                    <td>{formatCacheHitRatio(row.cacheHitRatio)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Modal
        open={selectedFailureRow !== null}
        title={t('usage_stats.request_events_failure_log_title')}
        onClose={() => setSelectedFailureRow(null)}
        width={560}
      >
        {selectedFailureRow && (
          <div className={styles.requestEventsFailureModalBody}>
            <div className={styles.requestEventsFailureMeta}>
              <div>
                <span className={styles.requestEventsFailureMetaLabel}>
                  {t('usage_stats.request_events_failure_log_timestamp')}
                </span>
                <span className={styles.requestEventsFailureMetaValue}>
                  {selectedFailureRow.timestampLabel}
                </span>
              </div>
              <div>
                <span className={styles.requestEventsFailureMetaLabel}>
                  {t('usage_stats.request_events_failure_log_model')}
                </span>
                <span className={styles.requestEventsFailureMetaValue}>{selectedFailureRow.model}</span>
              </div>
            </div>

            {selectedCredentialInfo?.name && (
              <div className={styles.requestEventsFailureCredentialRow}>
                <span className={styles.requestEventsFailureMetaLabel}>
                  {t('usage_stats.request_events_failure_log_credential')}
                </span>
                <span className={styles.requestEventsFailureMetaValue}>{selectedCredentialInfo.name}</span>
              </div>
            )}

            <div className={styles.requestEventsFailureMessageBlock}>
              <div className={styles.requestEventsFailureMetaLabel}>
                {t('usage_stats.request_events_failure_log_message_label')}
              </div>
              <div className={styles.requestEventsFailureMessage}>
                {selectedFailureMessage || t('usage_stats.request_events_failure_log_empty')}
              </div>
            </div>

            <div className={styles.requestEventsFailureNote}>
              {t('usage_stats.request_events_failure_log_note')}
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
