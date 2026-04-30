import { useMemo, useState } from 'react';
import type { ChartData, ChartOptions } from 'chart.js';
import { Pie } from 'react-chartjs-2';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { formatCompactNumber } from '@/utils/usage';
import type { ModelStat } from '@/components/usage';
import styles from '@/pages/MonitoringCenterPage.module.scss';

const PIE_COLORS = [
  '#8b5cf6',
  '#22c55e',
  '#f59e0b',
  '#c65746',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#f97316',
  '#8b8680',
  '#3b82f6'
];

export interface ModelUsageDistributionCardProps {
  modelStats: ModelStat[];
  loading: boolean;
  isDark: boolean;
}

export function ModelUsageDistributionCard({
  modelStats,
  loading,
  isDark
}: ModelUsageDistributionCardProps) {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<'requests' | 'tokens'>('requests');

  const rankedRows = useMemo(() => {
    const sorted = [...modelStats]
      .map((item) => ({
        ...item,
        value: metric === 'tokens' ? item.tokens : item.requests
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);

    const topFive = sorted.slice(0, 5);
    const others = sorted.slice(5);
    const othersValue = others.reduce((sum, item) => sum + item.value, 0);
    const total = sorted.reduce((sum, item) => sum + item.value, 0);
    const rows = topFive.map((item) => ({
      ...item,
      share: total > 0 ? (item.value / total) * 100 : 0
    }));

    if (othersValue > 0) {
      rows.push({
        model: t('monitoring_center.others_label'),
        requests: 0,
        successCount: 0,
        failureCount: 0,
        tokens: 0,
        cost: 0,
        averageLatencyMs: null,
        latencySampleCount: 0,
        value: othersValue,
        share: total > 0 ? (othersValue / total) * 100 : 0
      });
    }

    return rows;
  }, [metric, modelStats, t]);

  const chartData = useMemo<ChartData<'pie'>>(
    () => ({
      labels: rankedRows.map((item) => item.model),
      datasets: [
        {
          label:
            metric === 'tokens'
              ? t('usage_stats.total_tokens')
              : t('usage_stats.total_requests'),
          data: rankedRows.map((item) => item.value),
          backgroundColor: rankedRows.map((_, index) => PIE_COLORS[index % PIE_COLORS.length]),
          borderColor: isDark ? 'rgba(24, 24, 27, 0.95)' : '#ffffff',
          borderWidth: 2,
          hoverOffset: 8
        }
      ]
    }),
    [isDark, metric, rankedRows, t]
  );

  const chartOptions = useMemo<ChartOptions<'pie'>>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => {
              const row = rankedRows[context.dataIndex];
              if (!row) return '';
              return `${context.label}: ${formatCompactNumber(row.value)} (${row.share.toFixed(1)}%)`;
            }
          }
        }
      }
    }),
    [rankedRows]
  );

  return (
    <Card
      title={t('monitoring_center.model_distribution_title')}
      extra={
        <div className={styles.periodButtons}>
          <Button
            variant={metric === 'requests' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setMetric('requests')}
          >
            {t('monitoring_center.metric_requests')}
          </Button>
          <Button
            variant={metric === 'tokens' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setMetric('tokens')}
          >
            {t('monitoring_center.metric_tokens')}
          </Button>
        </div>
      }
      className={styles.detailsFixedCard}
    >
      {loading ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : rankedRows.length > 0 ? (
        <div className={styles.chartWrapper}>
          <div className={styles.distributionLayout}>
            <div className={styles.piePane}>
              <div className={styles.pieCanvas}>
                <Pie data={chartData} options={chartOptions} />
              </div>
            </div>
            <div className={styles.distributionList}>
              {rankedRows.map((row, index) => (
                <div key={row.model} className={styles.distributionRow}>
                  <span className={styles.distributionRank}>{index + 1}</span>
                  <div className={styles.distributionMeta}>
                    <span className={styles.distributionModel} title={row.model}>
                      {row.model}
                    </span>
                    <span className={styles.distributionShare}>
                      {t('monitoring_center.share_label')}: {row.share.toFixed(1)}%
                    </span>
                  </div>
                  <span className={styles.legendDot} style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }} />
                  <span className={styles.distributionValue}>{formatCompactNumber(row.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.hint}>{t('usage_stats.no_data')}</div>
      )}
    </Card>
  );
}
