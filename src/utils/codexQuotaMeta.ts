import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  CodexQuotaWindow,
  CodexRateLimitInfo,
  CodexUsagePayload,
  CodexUsageWindow,
} from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api/apiCall';
import {
  CODEX_REQUEST_HEADERS,
  CODEX_USAGE_URL,
  createStatusError,
  formatCodexResetLabel,
  normalizeNumberValue,
  normalizePlanType,
  normalizeStringValue,
  parseCodexUsagePayload,
  resolveCodexChatgptAccountId,
  resolveCodexPlanType,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';

const FIVE_HOUR_SECONDS = 18000;
const WEEK_SECONDS = 604800;
const THIRTY_DAYS_SECONDS = 2592000;

const WINDOW_META = {
  codeFiveHour: { id: 'five-hour', labelKey: 'codex_quota.primary_window' },
  codeWeekly: { id: 'weekly', labelKey: 'codex_quota.secondary_window' },
  codeMonthly: { id: 'monthly', labelKey: 'codex_quota.monthly_window' },
  codeReviewFiveHour: { id: 'code-review-five-hour', labelKey: 'codex_quota.code_review_primary_window' },
  codeReviewWeekly: { id: 'code-review-weekly', labelKey: 'codex_quota.code_review_secondary_window' },
  codeReviewMonthly: { id: 'code-review-monthly', labelKey: 'codex_quota.code_review_monthly_window' },
} as const;

export type CodexQuotaWindowKind = 'five-hour' | 'weekly' | 'monthly' | 'other';

export interface CodexQuotaWindowMeta {
  resetAtUnix: number | null;
  windowSeconds: number | null;
  windowKind: CodexQuotaWindowKind;
}

export interface CodexQuotaMeta {
  refreshedAtMs: number;
  windows: Record<string, CodexQuotaWindowMeta>;
}

export interface CodexQuotaFetchWithMetaResult {
  data: {
    planType: string | null;
    windows: CodexQuotaWindow[];
  };
  meta: CodexQuotaMeta;
}

const getWindowSeconds = (window?: CodexUsageWindow | null): number | null => {
  if (!window) return null;
  return normalizeNumberValue(window.limit_window_seconds ?? window.limitWindowSeconds);
};

const buildWindowMeta = (window: CodexUsageWindow): CodexQuotaWindowMeta => {
  const windowSeconds = getWindowSeconds(window);
  const resetAtRaw = normalizeNumberValue(window.reset_at ?? window.resetAt);
  const resetAfterRaw = normalizeNumberValue(window.reset_after_seconds ?? window.resetAfterSeconds);
  const resetAtUnix =
    resetAtRaw !== null && resetAtRaw > 0
      ? resetAtRaw
      : resetAfterRaw !== null && resetAfterRaw > 0
        ? Math.floor(Date.now() / 1000 + resetAfterRaw)
        : null;
  const windowKind =
    windowSeconds === FIVE_HOUR_SECONDS
      ? 'five-hour'
      : windowSeconds === WEEK_SECONDS
        ? 'weekly'
        : windowSeconds === THIRTY_DAYS_SECONDS
          ? 'monthly'
          : 'other';

  return { resetAtUnix, windowSeconds, windowKind };
};

const pickClassifiedWindows = (
  limitInfo?: CodexRateLimitInfo | null,
  options?: { allowOrderFallback?: boolean }
): {
  fiveHourWindow: CodexUsageWindow | null;
  weeklyWindow: CodexUsageWindow | null;
  monthlyWindow: CodexUsageWindow | null;
} => {
  const allowOrderFallback = options?.allowOrderFallback ?? true;
  const primaryWindow = limitInfo?.primary_window ?? limitInfo?.primaryWindow ?? null;
  const secondaryWindow = limitInfo?.secondary_window ?? limitInfo?.secondaryWindow ?? null;
  const rawWindows = [primaryWindow, secondaryWindow];

  let fiveHourWindow: CodexUsageWindow | null = null;
  let weeklyWindow: CodexUsageWindow | null = null;
  let monthlyWindow: CodexUsageWindow | null = null;

  for (const window of rawWindows) {
    if (!window) continue;
    const seconds = getWindowSeconds(window);
    if (seconds === FIVE_HOUR_SECONDS && !fiveHourWindow) {
      fiveHourWindow = window;
    } else if (seconds === WEEK_SECONDS && !weeklyWindow) {
      weeklyWindow = window;
    } else if (seconds === THIRTY_DAYS_SECONDS && !monthlyWindow) {
      monthlyWindow = window;
    }
  }

  if (allowOrderFallback) {
    if (!fiveHourWindow) {
      fiveHourWindow = primaryWindow && primaryWindow !== weeklyWindow && primaryWindow !== monthlyWindow ? primaryWindow : null;
    }
    if (!weeklyWindow) {
      weeklyWindow = secondaryWindow && secondaryWindow !== fiveHourWindow && secondaryWindow !== monthlyWindow ? secondaryWindow : null;
    }
  }

  return { fiveHourWindow, weeklyWindow, monthlyWindow };
};

const normalizeWindowId = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const buildCodexQuotaWindowsWithMeta = (
  payload: CodexUsagePayload,
  t: TFunction
): { windows: CodexQuotaWindow[]; meta: CodexQuotaMeta } => {
  const rateLimit = payload.rate_limit ?? payload.rateLimit ?? undefined;
  const codeReviewLimit = payload.code_review_rate_limit ?? payload.codeReviewRateLimit ?? undefined;
  const additionalRateLimits = payload.additional_rate_limits ?? payload.additionalRateLimits ?? [];
  const windows: CodexQuotaWindow[] = [];
  const windowMeta: Record<string, CodexQuotaWindowMeta> = {};

  const addWindow = (
    id: string,
    label: string,
    labelKey: string | undefined,
    labelParams: Record<string, string | number> | undefined,
    window?: CodexUsageWindow | null,
    limitReached?: boolean,
    allowed?: boolean
  ) => {
    if (!window) return;
    const resetLabel = formatCodexResetLabel(window);
    const usedPercentRaw = normalizeNumberValue(window.used_percent ?? window.usedPercent);
    const isLimitReached = Boolean(limitReached) || allowed === false;
    const usedPercent = usedPercentRaw ?? (isLimitReached && resetLabel !== '-' ? 100 : null);

    windows.push({
      id,
      label,
      labelKey,
      labelParams,
      usedPercent,
      resetLabel,
    });
    windowMeta[id] = buildWindowMeta(window);
  };

  const rawLimitReached = rateLimit?.limit_reached ?? rateLimit?.limitReached;
  const rawAllowed = rateLimit?.allowed;
  const rateWindows = pickClassifiedWindows(rateLimit);
  addWindow(
    WINDOW_META.codeFiveHour.id,
    t(WINDOW_META.codeFiveHour.labelKey),
    WINDOW_META.codeFiveHour.labelKey,
    undefined,
    rateWindows.fiveHourWindow,
    rawLimitReached,
    rawAllowed
  );
  addWindow(
    WINDOW_META.codeWeekly.id,
    t(WINDOW_META.codeWeekly.labelKey),
    WINDOW_META.codeWeekly.labelKey,
    undefined,
    rateWindows.weeklyWindow,
    rawLimitReached,
    rawAllowed
  );
  addWindow(
    WINDOW_META.codeMonthly.id,
    t(WINDOW_META.codeMonthly.labelKey),
    WINDOW_META.codeMonthly.labelKey,
    undefined,
    rateWindows.monthlyWindow,
    rawLimitReached,
    rawAllowed
  );

  const codeReviewWindows = pickClassifiedWindows(codeReviewLimit);
  const codeReviewLimitReached = codeReviewLimit?.limit_reached ?? codeReviewLimit?.limitReached;
  const codeReviewAllowed = codeReviewLimit?.allowed;
  addWindow(
    WINDOW_META.codeReviewFiveHour.id,
    t(WINDOW_META.codeReviewFiveHour.labelKey),
    WINDOW_META.codeReviewFiveHour.labelKey,
    undefined,
    codeReviewWindows.fiveHourWindow,
    codeReviewLimitReached,
    codeReviewAllowed
  );
  addWindow(
    WINDOW_META.codeReviewWeekly.id,
    t(WINDOW_META.codeReviewWeekly.labelKey),
    WINDOW_META.codeReviewWeekly.labelKey,
    undefined,
    codeReviewWindows.weeklyWindow,
    codeReviewLimitReached,
    codeReviewAllowed
  );
  addWindow(
    WINDOW_META.codeReviewMonthly.id,
    t(WINDOW_META.codeReviewMonthly.labelKey),
    WINDOW_META.codeReviewMonthly.labelKey,
    undefined,
    codeReviewWindows.monthlyWindow,
    codeReviewLimitReached,
    codeReviewAllowed
  );

  if (Array.isArray(additionalRateLimits)) {
    additionalRateLimits.forEach((limitItem, index) => {
      const rateInfo = limitItem?.rate_limit ?? limitItem?.rateLimit ?? null;
      if (!rateInfo) return;

      const limitName =
        normalizeStringValue(limitItem?.limit_name ?? limitItem?.limitName) ??
        normalizeStringValue(limitItem?.metered_feature ?? limitItem?.meteredFeature) ??
        `additional-${index + 1}`;

      const idPrefix = normalizeWindowId(limitName) || `additional-${index + 1}`;
      const additionalWindows = pickClassifiedWindows(rateInfo, { allowOrderFallback: false });
      const additionalLimitReached = rateInfo.limit_reached ?? rateInfo.limitReached;
      const additionalAllowed = rateInfo.allowed;

      addWindow(
        `${idPrefix}-five-hour-${index}`,
        t('codex_quota.additional_primary_window', { name: limitName }),
        'codex_quota.additional_primary_window',
        { name: limitName },
        additionalWindows.fiveHourWindow,
        additionalLimitReached,
        additionalAllowed
      );
      addWindow(
        `${idPrefix}-weekly-${index}`,
        t('codex_quota.additional_secondary_window', { name: limitName }),
        'codex_quota.additional_secondary_window',
        { name: limitName },
        additionalWindows.weeklyWindow,
        additionalLimitReached,
        additionalAllowed
      );
      addWindow(
        `${idPrefix}-monthly-${index}`,
        t('codex_quota.additional_monthly_window', { name: limitName }),
        'codex_quota.additional_monthly_window',
        { name: limitName },
        additionalWindows.monthlyWindow,
        additionalLimitReached,
        additionalAllowed
      );
    });
  }

  return {
    windows,
    meta: {
      refreshedAtMs: Date.now(),
      windows: windowMeta,
    },
  };
};

export const fetchCodexQuotaWithMeta = async (
  file: AuthFileItem,
  t: TFunction
): Promise<CodexQuotaFetchWithMetaResult> => {
  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndex = normalizeAuthIndex(rawAuthIndex);
  if (!authIndex) {
    throw new Error(t('codex_quota.missing_auth_index'));
  }

  const planTypeFromFile = resolveCodexPlanType(file);
  const accountId = resolveCodexChatgptAccountId(file);
  const requestHeader: Record<string, string> = {
    ...CODEX_REQUEST_HEADERS,
  };
  if (accountId) {
    requestHeader['Chatgpt-Account-Id'] = accountId;
  }

  const result = await apiCallApi.request({
    authIndex,
    method: 'GET',
    url: CODEX_USAGE_URL,
    header: requestHeader,
  });

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
  }

  const payload = parseCodexUsagePayload(result.body ?? result.bodyText);
  if (!payload) {
    throw new Error(t('codex_quota.empty_windows'));
  }

  const planTypeFromUsage = normalizePlanType(payload.plan_type ?? payload.planType);
  const { windows, meta } = buildCodexQuotaWindowsWithMeta(payload, t);
  return {
    data: {
      planType: planTypeFromUsage ?? planTypeFromFile,
      windows,
    },
    meta,
  };
};
