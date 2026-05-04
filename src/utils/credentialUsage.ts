import type { AuthFileItem } from '@/types/authFile';
import {
  calculateCost,
  collectUsageDetails,
  extractTotalTokens,
  normalizeAuthIndex,
  type ModelPrice,
  type UsageDetail
} from '@/utils/usage';

export interface CredentialUsageRow {
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
}

export const CREDENTIAL_COST_WINDOW_GRACE_MS = 60 * 1000;

export interface CredentialCostEvent {
  completedAtMs: number;
  cost: number;
}

interface CredentialUsageInput {
  usage: unknown;
  authFiles: AuthFileItem[];
  modelPrices: Record<string, ModelPrice>;
}

interface AuthFileLookup {
  authIndexToFile: Map<string, AuthFileItem>;
  authFileNameToFile: Map<string, AuthFileItem>;
}

interface CredentialMatch {
  rowKey: string;
  displayName: string;
  type: string;
  authIndex: string | null;
  authFileName: string | null;
}

export const normalizeCredentialType = (file?: AuthFileItem) => {
  const rawType =
    typeof file?.type === 'string'
      ? file.type
      : typeof file?.provider === 'string'
        ? file.provider
        : '';
  return rawType.trim().toLowerCase() || 'unknown';
};

export const getCredentialRowKeyForFile = (file: AuthFileItem): string => `file:${file.name}`;

const buildAuthFileLookup = (authFiles: AuthFileItem[]): AuthFileLookup => {
  const authIndexToFile = new Map<string, AuthFileItem>();
  const authFileNameToFile = new Map<string, AuthFileItem>();

  authFiles.forEach((file) => {
    const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
    if (authIndex) {
      authIndexToFile.set(authIndex, file);
    }
    if (file.name) {
      authFileNameToFile.set(file.name, file);
    }
  });

  return { authIndexToFile, authFileNameToFile };
};

const resolveCredentialMatch = (
  detail: UsageDetail,
  lookup: AuthFileLookup
): CredentialMatch | null => {
  const authIndex = normalizeAuthIndex(detail.auth_index);
  const sourceRaw = String(detail.source ?? '').trim();
  const sourceText = sourceRaw.startsWith('t:') ? sourceRaw.slice(2) : sourceRaw;
  const matchedFile =
    (authIndex ? lookup.authIndexToFile.get(authIndex) : undefined) ??
    (sourceRaw ? lookup.authFileNameToFile.get(sourceRaw) : undefined) ??
    (sourceText ? lookup.authFileNameToFile.get(sourceText) : undefined);

  const resolvedAuthIndex =
    (matchedFile && normalizeAuthIndex(matchedFile['auth_index'] ?? matchedFile.authIndex)) ?? authIndex;
  const authFileName = matchedFile?.name ?? null;

  if (!resolvedAuthIndex && !authFileName) {
    return null;
  }

  return {
    rowKey: authFileName ? `file:${authFileName}` : `auth:${resolvedAuthIndex}`,
    displayName: authFileName ?? resolvedAuthIndex ?? '-',
    type: normalizeCredentialType(matchedFile),
    authIndex: resolvedAuthIndex ?? null,
    authFileName
  };
};

const getRequestCompletedAtMs = (detail: UsageDetail): number => {
  const timestampMs = detail.__timestampMs ?? Date.parse(detail.timestamp);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return Number.NaN;

  const latencyMs =
    typeof detail.latency_ms === 'number' && Number.isFinite(detail.latency_ms) && detail.latency_ms > 0
      ? detail.latency_ms
      : 0;
  return timestampMs + latencyMs;
};

export function buildCredentialUsageRows({
  usage,
  authFiles,
  modelPrices
}: CredentialUsageInput): CredentialUsageRow[] {
  if (!usage) return [];

  const lookup = buildAuthFileLookup(authFiles);
  const rowMap = new Map<string, CredentialUsageRow>();

  collectUsageDetails(usage).forEach((detail) => {
    const match = resolveCredentialMatch(detail, lookup);
    if (!match) return;

    const existing = rowMap.get(match.rowKey) ?? {
      key: match.rowKey,
      displayName: match.displayName,
      type: match.type,
      authIndex: match.authIndex,
      authFileName: match.authFileName,
      requests: 0,
      successCount: 0,
      failureCount: 0,
      tokens: 0,
      cost: 0,
      successRate: 100
    };

    existing.requests += 1;
    if (detail.failed === true) {
      existing.failureCount += 1;
    } else {
      existing.successCount += 1;
    }
    existing.tokens += extractTotalTokens(detail);
    existing.cost += calculateCost(detail, modelPrices);
    existing.successRate = existing.requests > 0 ? (existing.successCount / existing.requests) * 100 : 100;
    rowMap.set(match.rowKey, existing);
  });

  return Array.from(rowMap.values());
}

export function buildCredentialCostBuckets({
  usage,
  authFiles,
  modelPrices
}: CredentialUsageInput): Map<string, CredentialCostEvent[]> {
  const buckets = new Map<string, CredentialCostEvent[]>();

  authFiles.forEach((file) => {
    if (file.name) {
      buckets.set(getCredentialRowKeyForFile(file), []);
    }
  });

  if (!usage) return buckets;

  const lookup = buildAuthFileLookup(authFiles);

  collectUsageDetails(usage).forEach((detail) => {
    const match = resolveCredentialMatch(detail, lookup);
    if (!match) return;

    const completedAtMs = getRequestCompletedAtMs(detail);
    if (!Number.isFinite(completedAtMs) || completedAtMs <= 0) return;

    const events = buckets.get(match.rowKey) ?? [];
    events.push({ completedAtMs, cost: calculateCost(detail, modelPrices) });
    buckets.set(match.rowKey, events);
  });

  return buckets;
}

export function sumCostInWindow(
  events: CredentialCostEvent[],
  startMs: number,
  endMs: number,
  graceMs: number = 0
): number {
  const normalizedGraceMs = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 0;
  const effectiveStartMs = startMs - normalizedGraceMs;
  const effectiveEndMs = endMs + normalizedGraceMs;

  return events.reduce(
    (sum, item) =>
      item.completedAtMs >= effectiveStartMs && item.completedAtMs <= effectiveEndMs
        ? sum + item.cost
        : sum,
    0
  );
}
