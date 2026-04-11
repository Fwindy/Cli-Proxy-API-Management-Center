import { useMemo, useState } from 'react';
import type { ChartData, ChartOptions } from 'chart.js';
import { Chart } from 'react-chartjs-2';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { buildUsageTotalsTrend, type ModelPrice } from '@/utils/usage';
import { getHourChartMinWidth } from '@/utils/usage/chartConfig';
import type { UsagePayload } from '@/components/usage';
import styles from '@/pages/MonitoringCenterPage.module.scss';

export interface MonitorTrendChartProps {
  usage: UsagePayload | null;
  loading: boolean;
  isDark: boolean;
  isMobile: boolean;
  hourWindowHours?: number;
  modelPrices: Record<string, ModelPrice>;
}

export function MonitorTrendChart({
  usage,
  loading,
  isDark,
  isMobile,
  hourWindowHours,
  modelPrices
}: MonitorTrendChartProps) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<'hour' | 'day'>('day');

  const trend = useMemo(
    () => buildUsageTotalsTrend(usage, modelPrices, period, { hourWindowHours }),
    [usage, modelPrices, period, hourWindowHours]
  );

  const chartData = useMemo<ChartData<'bar' | 'line'>>(
    () => ({
      labels: trend.labels,
      datasets: [
        {
          type: 'bar' as const,
          label: t('usage_stats.total_tokens'),
          data: trend.tokenSeries,
          yAxisID: 'yTokens',
          backgroundColor: 'rgba(139, 92, 246, 0.58)',
          borderColor: 'rgba(139, 92, 246, 0.9)',
          borderWidth: 1,
          borderRadius: 6,
          maxBarThickness: period === 'hour' ? 18 : 28,
          order: 2
        },
        {
          type: 'line' as const,
          label: t('usage_stats.total_cost'),
          data: trend.costSeries,
          yAxisID: 'yCost',
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.18)',
          pointBackgroundColor: '#f59e0b',
          pointBorderColor: '#f59e0b',
          pointRadius: isMobile && period === 'hour' ? 0 : isMobile ? 2 : 3,
          pointHoverRadius: 4,
          tension: 0.35,
          fill: false,
          borderWidth: isMobile ? 1.5 : 2,
          order: 1
        }
      ]
    }),
    [isMobile, period, t, trend.costSeries, trend.labels, trend.tokenSeries]
  );

  const formatCostValue = (value: number) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return '$0.0';
    }
    return `$${numeric.toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    })}`;
  };

  const chartOptions = useMemo<ChartOptions<'bar'>>(() => {
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(17, 24, 39, 0.06)';
    const axisBorderColor = isDark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(17, 24, 39, 0.10)';
    const tickColor = isDark ? 'rgba(255, 255, 255, 0.72)' : 'rgba(17, 24, 39, 0.72)';
    const tooltipBg = isDark ? 'rgba(17, 24, 39, 0.92)' : 'rgba(255, 255, 255, 0.98)';
    const tooltipTitle = isDark ? '#ffffff' : '#111827';
    const tooltipBody = isDark ? 'rgba(255, 255, 255, 0.86)' : '#374151';
    const tooltipBorder = isDark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(17, 24, 39, 0.10)';
    const tickFontSize = isMobile ? 10 : 12;
    const maxTickLabelCount = isMobile ? (period === 'hour' ? 8 : 6) : period === 'hour' ? 12 : 10;

    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: tooltipBg,
          titleColor: tooltipTitle,
          bodyColor: tooltipBody,
          borderColor: tooltipBorder,
          borderWidth: 1,
          padding: 10,
          displayColors: true,
          usePointStyle: true,
          callbacks: {
            label: (context) => {
              const label = context.dataset.label || '';
              const value = Number(context.parsed?.y ?? 0);
              if (context.dataset.yAxisID === 'yCost') {
                return `${label}: ${formatCostValue(value)}`;
              }
              return `${label}: ${value.toLocaleString()}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: gridColor,
            drawTicks: false
          },
          border: {
            color: axisBorderColor
          },
          ticks: {
            color: tickColor,
            font: { size: tickFontSize },
            maxRotation: isMobile ? 0 : 45,
            minRotation: 0,
            autoSkip: true,
            maxTicksLimit: maxTickLabelCount,
            callback: (value) => {
              const index = typeof value === 'number' ? value : Number(value);
              const raw =
                Number.isFinite(index) && trend.labels[index]
                  ? trend.labels[index]
                  : typeof value === 'string'
                    ? value
                    : '';

              if (period === 'hour') {
                const [md, time] = raw.split(' ');
                if (!time) return raw;
                if (time.startsWith('00:')) {
                  return md ? [md, time] : time;
                }
                return time;
              }

              if (isMobile) {
                const parts = raw.split('-');
                if (parts.length === 3) {
                  return `${parts[1]}-${parts[2]}`;
                }
              }
              return raw;
            }
          }
        },
        yTokens: {
          beginAtZero: true,
          position: 'left',
          grid: {
            color: gridColor
          },
          border: {
            color: axisBorderColor
          },
          ticks: {
            color: tickColor,
            font: { size: tickFontSize }
          }
        },
        yCost: {
          beginAtZero: true,
          position: 'right',
          grid: {
            drawOnChartArea: false
          },
          border: {
            color: axisBorderColor
          },
          ticks: {
            color: tickColor,
            font: { size: tickFontSize },
            callback: (value) => formatCostValue(Number(value))
          }
        }
      }
    };
  }, [isDark, isMobile, period, trend.labels]);

  return (
    <Card
      title={t('monitoring_center.combined_trend_title')}
      extra={
        <div className={styles.periodButtons}>
          <Button
            variant={period === 'hour' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setPeriod('hour')}
          >
            {t('usage_stats.by_hour')}
          </Button>
          <Button
            variant={period === 'day' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setPeriod('day')}
          >
            {t('usage_stats.by_day')}
          </Button>
        </div>
      }
      className={styles.detailsFixedCard}
    >
      {loading ? (
        <div className={styles.hint}>{t('common.loading')}</div>
      ) : trend.labels.length > 0 ? (
        <div className={styles.chartWrapper}>
          <div className={styles.chartLegend} aria-label="Chart legend">
            {chartData.datasets.map((dataset, index) => (
              <div key={`${dataset.label}-${index}`} className={styles.legendItem} title={dataset.label}>
                <span className={styles.legendDot} style={{ backgroundColor: String(dataset.borderColor) }} />
                <span className={styles.legendLabel}>{dataset.label}</span>
              </div>
            ))}
          </div>
          <div className={styles.chartArea}>
            <div className={styles.chartScroller}>
              <div
                className={styles.chartCanvas}
                style={
                  period === 'hour'
                    ? { minWidth: getHourChartMinWidth(trend.labels.length, isMobile) }
                    : undefined
                }
              >
                <Chart
                  type="bar"
                  data={chartData as unknown as ChartData<'bar'>}
                  options={chartOptions}
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.hint}>{t('usage_stats.no_data')}</div>
      )}
    </Card>
  );
}
