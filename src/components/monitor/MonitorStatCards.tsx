import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Line } from 'react-chartjs-2';
import {
  IconDiamond,
  IconDollarSign,
  IconSatellite,
  IconTimer,
  IconTrendingUp
} from '@/components/ui/icons';
import {
  calculateRecentPerMinuteRates,
  calculateTotalCost,
  formatCompactNumber,
  formatPerMinuteValue,
  formatUsd,
  type ModelPrice,
  type UsageTimeRange
} from '@/utils/usage';
import { sparklineOptions } from '@/utils/usage/chartConfig';
import type { UsagePayload, SparklineBundle } from '@/components/usage';
import styles from '@/pages/MonitoringCenterPage.module.scss';

interface StatCardData {
  key: string;
  label: string;
  icon: ReactNode;
  accent: string;
  accentSoft: string;
  accentBorder: string;
  value: string;
  trend: SparklineBundle | null;
}

export interface MonitorStatCardsProps {
  usage: UsagePayload | null;
  loading: boolean;
  modelPrices: Record<string, ModelPrice>;
  rateWindowMinutes: number;
  timeRange: UsageTimeRange;
  sparklines: {
    requests: SparklineBundle | null;
    tokens: SparklineBundle | null;
    rpm: SparklineBundle | null;
    tpm: SparklineBundle | null;
    cost: SparklineBundle | null;
  };
}

export function MonitorStatCards({
  usage,
  loading,
  modelPrices,
  rateWindowMinutes,
  timeRange,
  sparklines
}: MonitorStatCardsProps) {
  const { t } = useTranslation();

  const rateStats = useMemo(
    () => calculateRecentPerMinuteRates(rateWindowMinutes, usage),
    [rateWindowMinutes, usage]
  );
  const totalCost = useMemo(() => calculateTotalCost(usage, modelPrices), [usage, modelPrices]);
  const hasPrices = Object.keys(modelPrices).length > 0;

  const statsCards: StatCardData[] = [
    {
      key: 'requests',
      label: t('usage_stats.total_requests'),
      icon: <IconSatellite size={16} />,
      accent: '#8b8680',
      accentSoft: 'rgba(139, 134, 128, 0.18)',
      accentBorder: 'rgba(139, 134, 128, 0.35)',
      value: loading ? '-' : (usage?.total_requests ?? 0).toLocaleString(),
      trend: sparklines.requests
    },
    {
      key: 'tokens',
      label: t('usage_stats.total_tokens'),
      icon: <IconDiamond size={16} />,
      accent: '#8b5cf6',
      accentSoft: 'rgba(139, 92, 246, 0.18)',
      accentBorder: 'rgba(139, 92, 246, 0.35)',
      value: loading ? '-' : formatCompactNumber(usage?.total_tokens ?? 0),
      trend: sparklines.tokens
    },
    {
      key: 'rpm',
      label: timeRange === 'all' ? t('usage_stats.rpm_30m') : 'RPM',
      icon: <IconTimer size={16} />,
      accent: '#22c55e',
      accentSoft: 'rgba(34, 197, 94, 0.18)',
      accentBorder: 'rgba(34, 197, 94, 0.32)',
      value: loading ? '-' : formatPerMinuteValue(rateStats.rpm),
      trend: sparklines.rpm
    },
    {
      key: 'tpm',
      label: timeRange === 'all' ? t('usage_stats.tpm_30m') : 'TPM',
      icon: <IconTrendingUp size={16} />,
      accent: '#f97316',
      accentSoft: 'rgba(249, 115, 22, 0.18)',
      accentBorder: 'rgba(249, 115, 22, 0.32)',
      value: loading ? '-' : formatPerMinuteValue(rateStats.tpm),
      trend: sparklines.tpm
    },
    {
      key: 'cost',
      label: t('usage_stats.total_cost'),
      icon: <IconDollarSign size={16} />,
      accent: '#f59e0b',
      accentSoft: 'rgba(245, 158, 11, 0.18)',
      accentBorder: 'rgba(245, 158, 11, 0.32)',
      value: loading ? '-' : hasPrices ? formatUsd(totalCost) : '--',
      trend: hasPrices ? sparklines.cost : null
    }
  ];

  return (
    <div className={styles.statsGrid}>
      {statsCards.map((card) => (
        <div
          key={card.key}
          className={styles.statCard}
          style={
            {
              '--accent': card.accent,
              '--accent-soft': card.accentSoft,
              '--accent-border': card.accentBorder
            } as CSSProperties
          }
        >
          <div className={styles.statCardHeader}>
            <span className={styles.statLabel}>{card.label}</span>
            <span className={styles.statIconBadge}>{card.icon}</span>
          </div>
          <div className={styles.statValue}>{card.value}</div>
          <div className={styles.statTrend}>
            {card.trend ? (
              <Line className={styles.sparkline} data={card.trend.data} options={sparklineOptions} />
            ) : (
              <div className={styles.statTrendPlaceholder}></div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
