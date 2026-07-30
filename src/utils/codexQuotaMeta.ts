import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  CodexQuotaWindow,
  CodexRateLimitInfo,
  CodexRateLimitResetCredit,
  CodexUsagePayload,
  CodexUsageWindow,
} from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api/apiCall';
import {
  CODEX_RATE_LIMIT_RESET_CREDITS_URL,
  CODEX_REQUEST_HEADERS,
  CODEX_USAGE_URL,
  createStatusError,
  formatCodexResetLabel,
  normalizeCodexResetCreditsPayload,
  normalizeNumberValue,
  normalizePlanType,
  normalizeStringValue,
  parseCodexUsagePayload,
  resolveCodexChatgptAccountId,
  resolveCodexPlanType,
  resolveCodexSubscriptionActiveUntil,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';

const CODEX_RESET_CREDITS_REQUEST_TIMEOUT_MS = 8000;

const FIVE_HOUR_SECONDS = 18000;
const WEEK_SECONDS = 604800;
const THIRTY_DAYS_SECONDS = 2592000;

const WINDOW_META = {
  codeFiveHour: { id: 'five-hour', labelKey: 'codex_quota.primary_window' },
  codeWeekly: { id: 'weekly', labelKey: 'codex_quota.secondary_window' },
  codeMonthly: { id: 'monthly', labelKey: 'codex_quota.team_secondary_window' },
  codeReviewFiveHour: { id: 'code-review-five-hour', labelKey: 'codex_quota.code_review_primary_window' },
  codeReviewWeekly: { id: 'code-review-weekly', labelKey: 'codex_quota.code_review_secondary_window' },
  codeReviewMonthly: { id: 'code-review-monthly', labelKey: 'codex_quota.code_review_team_secondary_window' },
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
    subscriptionActiveUntil: string | number | null;
    rateLimitResetCreditsAvailableCount: number | null;
    rateLimitResetCreditsApplicableAvailableCount: number | null;
    rateLimitResetCredits: CodexRateLimitResetCredit[];
    rateLimitResetCreditsError: string;
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
} => {
  const allowOrderFallback = options?.allowOrderFallback ?? true;
  const primaryWindow = limitInfo?.primary_window ?? limitInfo?.primaryWindow ?? null;
  const secondaryWindow = limitInfo?.secondary_window ?? limitInfo?.secondaryWindow ?? null;
  const rawWindows = [primaryWindow, secondaryWindow];

  let fiveHourWindow: CodexUsageWindow | null = null;
  let weeklyWindow: CodexUsageWindow | null = null;

  for (const window of rawWindows) {
    if (!window) continue;
    const seconds = getWindowSeconds(window);
    if (seconds === FIVE_HOUR_SECONDS && !fiveHourWindow) {
      fiveHourWindow = window;
    } else if (seconds === WEEK_SECONDS && !weeklyWindow) {
      weeklyWindow = window;
    }
  }

  if (allowOrderFallback) {
    if (!fiveHourWindow) {
      fiveHourWindow = primaryWindow && primaryWindow !== weeklyWindow ? primaryWindow : null;
    }
    if (!weeklyWindow) {
      weeklyWindow =
        secondaryWindow && secondaryWindow !== fiveHourWindow ? secondaryWindow : null;
    }
  }

  return { fiveHourWindow, weeklyWindow };
};

const normalizeWindowId = (raw: string) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const buildCodexQuotaWindowsWithMeta = (
  payload: CodexUsagePayload,
  t: TFunction,
  planType?: string | null
): { windows: CodexQuotaWindow[]; meta: CodexQuotaMeta } => {
  const isTeamPlan = normalizePlanType(planType) === 'team';
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
  const codeSecondaryWindowMeta = isTeamPlan ? WINDOW_META.codeMonthly : WINDOW_META.codeWeekly;
  addWindow(
    codeSecondaryWindowMeta.id,
    t(codeSecondaryWindowMeta.labelKey),
    codeSecondaryWindowMeta.labelKey,
    undefined,
    rateWindows.weeklyWindow,
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
  const codeReviewSecondaryWindowMeta = isTeamPlan
    ? WINDOW_META.codeReviewMonthly
    : WINDOW_META.codeReviewWeekly;
  addWindow(
    codeReviewSecondaryWindowMeta.id,
    t(codeReviewSecondaryWindowMeta.labelKey),
    codeReviewSecondaryWindowMeta.labelKey,
    undefined,
    codeReviewWindows.weeklyWindow,
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
      const additionalPrimaryWindow = rateInfo.primary_window ?? rateInfo.primaryWindow ?? null;
      const additionalSecondaryWindow =
        rateInfo.secondary_window ?? rateInfo.secondaryWindow ?? null;
      const additionalLimitReached = rateInfo.limit_reached ?? rateInfo.limitReached;
      const additionalAllowed = rateInfo.allowed;

      addWindow(
        `${idPrefix}-five-hour-${index}`,
        t('codex_quota.additional_primary_window', { name: limitName }),
        'codex_quota.additional_primary_window',
        { name: limitName },
        additionalPrimaryWindow,
        additionalLimitReached,
        additionalAllowed
      );
      const additionalSecondaryLabelKey = isTeamPlan
        ? 'codex_quota.additional_team_secondary_window'
        : 'codex_quota.additional_secondary_window';
      const additionalSecondaryId = isTeamPlan ? 'monthly' : 'weekly';
      addWindow(
        `${idPrefix}-${additionalSecondaryId}-${index}`,
        t(additionalSecondaryLabelKey, { name: limitName }),
        additionalSecondaryLabelKey,
        { name: limitName },
        additionalSecondaryWindow,
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

type CodexResetCreditsData = {
  availableCount: number | null;
  applicableAvailableCount: number | null;
  credits: CodexRateLimitResetCredit[];
  error: string;
};

const fetchCodexResetCredits = async (
  authIndex: string,
  requestHeader: Record<string, string>,
  t: TFunction
): Promise<CodexResetCreditsData> => {
  try {
    const result = await apiCallApi.request(
      {
        authIndex,
        method: 'GET',
        url: CODEX_RATE_LIMIT_RESET_CREDITS_URL,
        header: {
          ...requestHeader,
          Accept: 'application/json',
          'OpenAI-Beta': 'codex-1',
          Originator: 'Codex Desktop',
        },
      },
      { timeout: CODEX_RESET_CREDITS_REQUEST_TIMEOUT_MS }
    );

    if (result.statusCode < 200 || result.statusCode >= 300) {
      return {
        availableCount: null,
        applicableAvailableCount: null,
        credits: [],
        error: getApiCallErrorMessage(result),
      };
    }

    const summary = normalizeCodexResetCreditsPayload(result.body ?? result.bodyText);
    if (summary.invalidPayload) {
      return {
        availableCount: null,
        applicableAvailableCount: null,
        credits: [],
        error: t('codex_quota.reset_credits_invalid_payload'),
      };
    }

    return {
      availableCount: summary.availableCount,
      applicableAvailableCount: summary.applicableAvailableCount,
      credits: summary.credits,
      error: '',
    };
  } catch (err: unknown) {
    return {
      availableCount: null,
      applicableAvailableCount: null,
      credits: [],
      error: err instanceof Error ? err.message : t('common.unknown_error'),
    };
  }
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
  const subscriptionActiveUntil = resolveCodexSubscriptionActiveUntil(file);
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
  const planType = planTypeFromUsage ?? planTypeFromFile;
  const resetCredits = payload.rate_limit_reset_credits ?? payload.rateLimitResetCredits ?? null;
  const usageResetCreditsData = normalizeCodexResetCreditsPayload(resetCredits);
  const resetCreditsData = await fetchCodexResetCredits(authIndex, requestHeader, t);
  const resetCreditsCountFromDetails =
    resetCreditsData.credits.length > 0 ? resetCreditsData.credits.length : null;
  const rateLimitResetCreditsAvailableCount =
    resetCreditsData.availableCount ??
    resetCreditsCountFromDetails ??
    usageResetCreditsData.availableCount;
  const rateLimitResetCreditsApplicableAvailableCount =
    usageResetCreditsData.applicableAvailableCount ??
    resetCreditsData.applicableAvailableCount ??
    rateLimitResetCreditsAvailableCount;
  const { windows, meta } = buildCodexQuotaWindowsWithMeta(payload, t, planType);
  return {
    data: {
      planType,
      subscriptionActiveUntil,
      rateLimitResetCreditsAvailableCount,
      rateLimitResetCreditsApplicableAvailableCount,
      rateLimitResetCredits: resetCreditsData.credits,
      rateLimitResetCreditsError: resetCreditsData.error,
      windows,
    },
    meta,
  };
};
