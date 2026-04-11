/**
 * Price sync utilities — fetch latest model prices from models.dev
 * and match them against CPA's current model list.
 *
 * Ported from the "CPA同步价格" Tampermonkey userscript.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRICING_URL = 'https://models.dev/api.json';
const REQUEST_TIMEOUT_MS = 15_000;
const SYNC_SETTINGS_STORAGE_KEY = 'cli-proxy-model-sync-settings-v1';

export const DEFAULT_PROVIDER_PRIORITY: readonly string[] = Object.freeze([
  'openai',
  'google',
  'anthropic',
]);

export const DEFAULT_IGNORED_SUFFIXES: readonly string[] = Object.freeze([
  '-thinking',
  '-preview',
  '-high',
  '-low',
  '(thinking)',
  '(xhigh)',
  '(high)',
  '(low)',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncSettings {
  providerPriority: string[];
  ignoredModelNameSuffixes: string[];
  modelNameMappings: NameMapping[];
}

export interface NameMapping {
  source: string;
  target: string;
}

export interface SyncedPrice {
  prompt: number;
  completion: number;
  cache: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonSafely(value: string | null | undefined): unknown {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseLinesToList(value: string): string[] {
  return value
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseLinesToMappingList(value: string): NameMapping[] {
  return parseLinesToList(value)
    .map((line) => {
      const idx = line.indexOf('=');
      if (idx === -1) return null;
      const source = line.slice(0, idx).trim();
      const target = line.slice(idx + 1).trim();
      if (!source || !target) return null;
      return { source, target };
    })
    .filter((m): m is NameMapping => m !== null);
}

export function formatMappingListForTextarea(values: NameMapping[]): string {
  return values
    .map((m) => `${m.source}=${m.target}`)
    .filter((s) => s !== '=')
    .join('\n');
}

function normalizeStringList(
  values: string[] | string,
  lowercase = true,
): string[] {
  const items = Array.isArray(values) ? values : parseLinesToList(values);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const v of items) {
    let n = v.trim();
    if (!n) continue;
    if (lowercase) n = n.toLowerCase();
    if (seen.has(n)) continue;
    seen.add(n);
    result.push(n);
  }
  return result;
}

function normalizeModelNameMappings(
  values: NameMapping[] | string,
): NameMapping[] {
  const items: NameMapping[] = Array.isArray(values)
    ? values
    : parseLinesToMappingList(values);
  const result: NameMapping[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const source = normalizeModelName(item.source);
    const target = normalizeModelName(item.target);
    if (!source || !target) continue;
    const key = `${source}=>${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ source, target });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sync settings persistence (localStorage)
// ---------------------------------------------------------------------------

export function getDefaultSyncSettings(): SyncSettings {
  return {
    providerPriority: [...DEFAULT_PROVIDER_PRIORITY],
    ignoredModelNameSuffixes: [...DEFAULT_IGNORED_SUFFIXES],
    modelNameMappings: [],
  };
}

export function sanitizeSyncSettings(
  input: Partial<SyncSettings> | null | undefined,
): SyncSettings {
  const defaults = getDefaultSyncSettings();
  const providerPriority = normalizeStringList(
    (input?.providerPriority as string[] | string) ?? [],
    true,
  );
  const ignoredModelNameSuffixes = normalizeStringList(
    (input?.ignoredModelNameSuffixes as string[] | string) ?? [],
    true,
  );
  const modelNameMappings = normalizeModelNameMappings(
    (input?.modelNameMappings as NameMapping[] | string) ?? [],
  );
  return {
    providerPriority:
      providerPriority.length > 0
        ? providerPriority
        : defaults.providerPriority,
    ignoredModelNameSuffixes:
      ignoredModelNameSuffixes.length > 0
        ? ignoredModelNameSuffixes
        : defaults.ignoredModelNameSuffixes,
    modelNameMappings,
  };
}

export function loadSyncSettings(): SyncSettings {
  try {
    const raw = localStorage.getItem(SYNC_SETTINGS_STORAGE_KEY);
    const parsed = parseJsonSafely(raw) as Partial<SyncSettings> | null;
    return sanitizeSyncSettings(parsed);
  } catch {
    return getDefaultSyncSettings();
  }
}

export function saveSyncSettings(settings: SyncSettings): SyncSettings {
  const sanitized = sanitizeSyncSettings(settings);
  localStorage.setItem(
    SYNC_SETTINGS_STORAGE_KEY,
    JSON.stringify(sanitized),
  );
  return sanitized;
}

// ---------------------------------------------------------------------------
// Model-name normalisation & matching helpers
// ---------------------------------------------------------------------------

function normalizeModelName(name: string | undefined | null): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .split('/')
    .pop()!;
}

function mapModelName(name: string, mappings: NameMapping[]): string {
  const normalised = normalizeModelName(name);
  if (!normalised || mappings.length === 0) return normalised;
  const match = mappings.find((m) => m.source === normalised);
  return match ? match.target : normalised;
}

function normalizeModelNameForMatch(
  name: string,
  ignoredSuffixes: string[],
  mappings: NameMapping[],
): string {
  let n = mapModelName(name, mappings);
  while (n) {
    const suffix = ignoredSuffixes.find((s) => n.endsWith(s));
    if (!suffix) break;
    n = n.slice(0, -suffix.length).trim();
  }
  return n;
}

function getProviderPriorityRank(
  providerName: string,
  providerPriority: string[],
): number {
  const idx = providerPriority.indexOf(
    normalizeModelName(providerName),
  );
  return idx === -1 ? providerPriority.length : idx;
}

// ---------------------------------------------------------------------------
// Build allowed-model-name lookup from a flat list (the modelNames prop)
// ---------------------------------------------------------------------------

interface AllowedModelNames {
  exactNames: Set<string>;
  normalisedNames: Set<string>;
  normalisedToExact: Map<string, Set<string>>;
  count: number;
}

function buildAllowedModelNames(
  modelNames: string[],
  settings: SyncSettings,
): AllowedModelNames {
  const exactNames = new Set<string>();
  const normalisedNames = new Set<string>();
  const normalisedToExact = new Map<string, Set<string>>();

  for (const raw of modelNames) {
    const exact = normalizeModelName(raw);
    const normalised = normalizeModelNameForMatch(
      raw,
      settings.ignoredModelNameSuffixes,
      settings.modelNameMappings,
    );
    if (exact) exactNames.add(exact);
    if (normalised) {
      normalisedNames.add(normalised);
      if (!normalisedToExact.has(normalised)) {
        normalisedToExact.set(normalised, new Set());
      }
      if (exact) normalisedToExact.get(normalised)!.add(exact);
    }
  }

  return { exactNames, normalisedNames, normalisedToExact, count: exactNames.size };
}

// ---------------------------------------------------------------------------
// Process raw pricing data from models.dev
// ---------------------------------------------------------------------------

function formatPrice(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : 0;
}

function processData(
  rawData: Record<string, unknown>,
  allowed: AllowedModelNames,
  settings: SyncSettings,
): Record<string, SyncedPrice> {
  const newPrices: Record<string, SyncedPrice> = {};
  const chosenProviders: Record<string, { name: string; rank: number }> = {};

  for (const [providerKey, providerVal] of Object.entries(rawData)) {
    const provider = providerVal as Record<string, unknown> | null;
    if (
      !provider ||
      typeof provider !== 'object' ||
      !provider.models ||
      typeof provider.models !== 'object'
    )
      continue;

    const providerName = normalizeModelName(
      (provider.id as string) ||
        (provider.name as string) ||
        (provider.label as string) ||
        providerKey,
    );
    const rank = getProviderPriorityRank(providerName, settings.providerPriority);

    const models = provider.models as Record<string, unknown>;
    for (const [modelKey, modelVal] of Object.entries(models)) {
      const exactName = normalizeModelName(modelKey);
      const normalisedName = normalizeModelNameForMatch(
        modelKey,
        settings.ignoredModelNameSuffixes,
        settings.modelNameMappings,
      );
      const matchedExacts = allowed.exactNames.has(exactName)
        ? [exactName]
        : normalisedName && allowed.normalisedNames.has(normalisedName)
          ? Array.from(allowed.normalisedToExact.get(normalisedName) ?? [])
          : [];

      if (matchedExacts.length === 0) continue;

      const model = modelVal as Record<string, unknown> | null;
      const cost =
        model && typeof model === 'object' && model.cost && typeof model.cost === 'object'
          ? (model.cost as Record<string, unknown>)
          : {};

      for (const matched of matchedExacts) {
        const existing = chosenProviders[matched];
        if (existing && existing.rank < rank) continue;

        newPrices[matched] = {
          prompt: formatPrice(cost.input),
          completion: formatPrice(cost.output),
          cache: formatPrice((cost as Record<string, unknown>).cache_read ?? (cost as Record<string, unknown>).cache_write ?? 0),
        };
        chosenProviders[matched] = { name: providerName, rank };
      }
    }
  }

  // Sort by model name
  return Object.keys(newPrices)
    .sort()
    .reduce<Record<string, SyncedPrice>>((acc, key) => {
      acc[key] = newPrices[key];
      return acc;
    }, {});
}

// ---------------------------------------------------------------------------
// Public: run the full sync pipeline
// ---------------------------------------------------------------------------

export interface SyncResult {
  prices: Record<string, SyncedPrice>;
  matchedCount: number;
  totalModels: number;
}

export async function syncPrices(
  modelNames: string[],
  settings: SyncSettings,
): Promise<SyncResult> {
  if (modelNames.length === 0) {
    throw new Error('当前没有可同步的模型，请确保已有使用数据。');
  }

  const allowed = buildAllowedModelNames(modelNames, settings);

  // Fetch pricing data from models.dev
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let rawData: Record<string, unknown>;
  try {
    const res = await fetch(PRICING_URL, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`价格源请求失败 (HTTP ${res.status})`);
    }
    rawData = (await res.json()) as Record<string, unknown>;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('价格源请求超时，请稍后重试');
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }

  const prices = processData(rawData, allowed, settings);
  const matchedCount = Object.keys(prices).length;

  return { prices, matchedCount, totalModels: allowed.count };
}
