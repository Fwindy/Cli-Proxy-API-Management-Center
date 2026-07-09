import { useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import type { ContextTierPrice, ModelPrice } from '@/utils/usage';
import {
  loadSyncSettings,
  saveSyncSettings,
  sanitizeSyncSettings,
  syncPrices,
  parseLinesToList,
  parseLinesToMappingList,
  formatMappingListForTextarea,
  type SyncSettings,
} from '@/utils/priceSync';
import {
  loadTierMultipliers,
  saveTierMultipliers,
  type TierMultiplierRule,
} from '@/utils/tierMultiplier';
import styles from '@/pages/UsagePage.module.scss';

export interface PriceSettingsCardProps {
  modelNames: string[];
  modelPrices: Record<string, ModelPrice>;
  onPricesChange: (prices: Record<string, ModelPrice>) => void;
}

type SyncStatusType = 'info' | 'success' | 'error';

/** Tier 倍率弹窗的可编辑行（倍率以字符串编辑，保存时转数字） */
interface TierMultiplierDraft {
  model: string;
  tier: string;
  multiplier: string;
}

/** 上下文阶梯价格的可编辑行（数值以字符串编辑，保存时转数字） */
interface ContextTierDraft {
  threshold: string;
  input: string;
  output: string;
  cacheCreate: string;
  cacheRead: string;
}

/** 解析非负价格/数值，非法或空串归 0 */
const parseNonNegative = (value: string): number => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** 把草稿阶梯行规范化为 ContextTierPrice[]（阈值须为正数，按阈值升序） */
const draftsToContextTiers = (drafts: ContextTierDraft[]): ContextTierPrice[] => {
  const tiers: ContextTierPrice[] = [];
  drafts.forEach((row) => {
    const threshold = Number.parseFloat(row.threshold);
    if (!Number.isFinite(threshold) || threshold <= 0) return;
    tiers.push({
      threshold,
      input: parseNonNegative(row.input),
      output: parseNonNegative(row.output),
      cacheCreate: parseNonNegative(row.cacheCreate),
      cacheRead: parseNonNegative(row.cacheRead),
    });
  });
  return tiers.sort((a, b) => a.threshold - b.threshold);
};

const contextTiersToDrafts = (tiers?: ContextTierPrice[]): ContextTierDraft[] =>
  (tiers ?? []).map((tier) => ({
    threshold: String(tier.threshold),
    input: String(tier.input),
    output: String(tier.output),
    cacheCreate: String(tier.cacheCreate),
    cacheRead: String(tier.cacheRead),
  }));

export function PriceSettingsCard({
  modelNames,
  modelPrices,
  onPricesChange
}: PriceSettingsCardProps) {
  const { t } = useTranslation();

  // Add form state
  const [selectedModel, setSelectedModel] = useState('');
  const [inputPrice, setInputPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [cacheCreatePrice, setCacheCreatePrice] = useState('');
  const [cacheReadPrice, setCacheReadPrice] = useState('');

  // Edit modal state
  const [editModel, setEditModel] = useState<string | null>(null);
  const [editInput, setEditInput] = useState('');
  const [editOutput, setEditOutput] = useState('');
  const [editCacheCreate, setEditCacheCreate] = useState('');
  const [editCacheRead, setEditCacheRead] = useState('');
  const [editTiers, setEditTiers] = useState<ContextTierDraft[]>([]);

  // Sync modal state
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncPending, setSyncPending] = useState(false);
  const [syncStatusMsg, setSyncStatusMsg] = useState('');
  const [syncStatusType, setSyncStatusType] = useState<SyncStatusType>('info');
  const [providerPriorityText, setProviderPriorityText] = useState('');
  const [ignoredSuffixesText, setIgnoredSuffixesText] = useState('');
  const [modelMappingsText, setModelMappingsText] = useState('');

  // Tier multiplier modal state
  const [tierOpen, setTierOpen] = useState(false);
  const [tierRows, setTierRows] = useState<TierMultiplierDraft[]>([]);

  const handleSavePrice = () => {
    if (!selectedModel) return;
    const existingTiers = modelPrices[selectedModel]?.contextTiers;
    const price: ModelPrice = {
      input: parseNonNegative(inputPrice),
      output: parseNonNegative(outputPrice),
      cacheCreate: parseNonNegative(cacheCreatePrice),
      cacheRead: parseNonNegative(cacheReadPrice),
      // 新增/更新基础价时保留该模型已有的上下文阶梯（阶梯在编辑弹窗中维护）。
      ...(existingTiers && existingTiers.length ? { contextTiers: existingTiers } : {}),
    };
    onPricesChange({ ...modelPrices, [selectedModel]: price });
    setSelectedModel('');
    setInputPrice('');
    setOutputPrice('');
    setCacheCreatePrice('');
    setCacheReadPrice('');
  };

  const handleDeletePrice = (model: string) => {
    const newPrices = { ...modelPrices };
    delete newPrices[model];
    onPricesChange(newPrices);
  };

  const handleOpenEdit = (model: string) => {
    const price = modelPrices[model];
    setEditModel(model);
    setEditInput(price?.input?.toString() || '');
    setEditOutput(price?.output?.toString() || '');
    setEditCacheCreate(price?.cacheCreate?.toString() || '');
    setEditCacheRead(price?.cacheRead?.toString() || '');
    setEditTiers(contextTiersToDrafts(price?.contextTiers));
  };

  const handleSaveEdit = () => {
    if (!editModel) return;
    const tiers = draftsToContextTiers(editTiers);
    const price: ModelPrice = {
      input: parseNonNegative(editInput),
      output: parseNonNegative(editOutput),
      cacheCreate: parseNonNegative(editCacheCreate),
      cacheRead: parseNonNegative(editCacheRead),
      ...(tiers.length ? { contextTiers: tiers } : {}),
    };
    onPricesChange({ ...modelPrices, [editModel]: price });
    setEditModel(null);
  };

  const handleAddTier = useCallback(() => {
    setEditTiers((rows) => [
      ...rows,
      { threshold: '', input: '', output: '', cacheCreate: '', cacheRead: '' },
    ]);
  }, []);

  const handleTierChange = useCallback(
    (index: number, field: keyof ContextTierDraft, value: string) => {
      setEditTiers((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
    },
    []
  );

  const handleDeleteTier = useCallback((index: number) => {
    setEditTiers((rows) => rows.filter((_, i) => i !== index));
  }, []);

  const handleModelSelect = (value: string) => {
    setSelectedModel(value);
    const price = modelPrices[value];
    if (price) {
      setInputPrice(price.input.toString());
      setOutputPrice(price.output.toString());
      setCacheCreatePrice(price.cacheCreate.toString());
      setCacheReadPrice(price.cacheRead.toString());
    } else {
      setInputPrice('');
      setOutputPrice('');
      setCacheCreatePrice('');
      setCacheReadPrice('');
    }
  };

  const options = useMemo(
    () => [
      { value: '', label: t('usage_stats.model_price_select_placeholder') },
      ...modelNames.map((name) => ({ value: name, label: name }))
    ],
    [modelNames, t]
  );

  // ---- Tier multiplier modal handlers ----

  const handleOpenTier = useCallback(() => {
    setTierRows(
      loadTierMultipliers().map((rule) => ({
        model: rule.model,
        tier: rule.tier,
        multiplier: String(rule.multiplier),
      }))
    );
    setTierOpen(true);
  }, []);

  const handleAddTierRow = useCallback(() => {
    setTierRows((rows) => [...rows, { model: '', tier: '', multiplier: '' }]);
  }, []);

  const handleTierRowChange = useCallback(
    (index: number, field: keyof TierMultiplierDraft, value: string) => {
      setTierRows((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
    },
    []
  );

  const handleDeleteTierRow = useCallback((index: number) => {
    setTierRows((rows) => rows.filter((_, i) => i !== index));
  }, []);

  const handleSaveTier = useCallback(() => {
    const rules: TierMultiplierRule[] = tierRows.map((row) => ({
      model: row.model,
      tier: row.tier,
      multiplier: Number.parseFloat(row.multiplier),
    }));
    saveTierMultipliers(rules);
    // 复用既有响应式链路：刷新 modelPrices 引用，触发本页所有依赖 [modelPrices]
    // 的 memo（模型统计/趋势/总花费/sparkline/API密钥统计）重新计算花费。
    // 凭证中心为独立路由，切换时会自然读取已更新的内存索引。
    onPricesChange({ ...modelPrices });
    setTierOpen(false);
  }, [tierRows, onPricesChange, modelPrices]);

  // ---- Sync modal handlers ----

  const handleOpenSync = useCallback(() => {
    const settings = loadSyncSettings();
    setProviderPriorityText(settings.providerPriority.join('\n'));
    setIgnoredSuffixesText(settings.ignoredModelNameSuffixes.join('\n'));
    setModelMappingsText(formatMappingListForTextarea(settings.modelNameMappings));
    setSyncStatusMsg('');
    setSyncStatusType('info');
    setSyncPending(false);
    setSyncOpen(true);
  }, []);

  const collectSettingsFromInputs = useCallback((): SyncSettings => {
    return sanitizeSyncSettings({
      providerPriority: parseLinesToList(providerPriorityText),
      ignoredModelNameSuffixes: parseLinesToList(ignoredSuffixesText),
      modelNameMappings: parseLinesToMappingList(modelMappingsText),
    });
  }, [providerPriorityText, ignoredSuffixesText, modelMappingsText]);

  const applySettingsToInputs = useCallback((s: SyncSettings) => {
    setProviderPriorityText(s.providerPriority.join('\n'));
    setIgnoredSuffixesText(s.ignoredModelNameSuffixes.join('\n'));
    setModelMappingsText(formatMappingListForTextarea(s.modelNameMappings));
  }, []);

  const handleSaveSettingsOnly = useCallback(async () => {
    if (syncPending) return;
    setSyncPending(true);
    setSyncStatusMsg(t('usage_stats.price_sync_status_saving'));
    setSyncStatusType('info');
    try {
      const saved = saveSyncSettings(collectSettingsFromInputs());
      applySettingsToInputs(saved);
      setSyncStatusMsg(t('usage_stats.price_sync_status_saved'));
      setSyncStatusType('success');
    } catch (err) {
      setSyncStatusMsg(err instanceof Error ? err.message : String(err));
      setSyncStatusType('error');
    } finally {
      setSyncPending(false);
    }
  }, [syncPending, t, collectSettingsFromInputs, applySettingsToInputs]);

  const handleSaveAndSync = useCallback(async () => {
    if (syncPending) return;
    setSyncPending(true);
    setSyncStatusMsg(t('usage_stats.price_sync_status_fetching'));
    setSyncStatusType('info');

    try {
      const saved = saveSyncSettings(collectSettingsFromInputs());
      applySettingsToInputs(saved);

      const result = await syncPrices(modelNames, saved);

      if (result.matchedCount === 0) {
        setSyncStatusMsg(t('usage_stats.price_sync_status_no_match'));
        setSyncStatusType('error');
        setSyncPending(false);
        return;
      }

      // Merge synced prices into current prices
      const merged = { ...modelPrices, ...result.prices };
      onPricesChange(merged);

      setSyncStatusMsg(
        t('usage_stats.price_sync_status_success', {
          matched: result.matchedCount,
          total: result.totalModels,
        }),
      );
      setSyncStatusType('success');
    } catch (err) {
      setSyncStatusMsg(err instanceof Error ? err.message : String(err));
      setSyncStatusType('error');
    } finally {
      setSyncPending(false);
    }
  }, [
    syncPending,
    t,
    collectSettingsFromInputs,
    applySettingsToInputs,
    modelNames,
    modelPrices,
    onPricesChange,
  ]);

  const syncStatusClass = syncStatusType === 'success'
    ? `${styles.syncStatus} ${styles.syncStatusSuccess}`
    : syncStatusType === 'error'
      ? `${styles.syncStatus} ${styles.syncStatusError}`
      : `${styles.syncStatus} ${styles.syncStatusInfo}`;

  const headerActions = (
    <div className={styles.priceActions}>
      <Button variant="secondary" size="sm" onClick={handleOpenTier}>
        {t('usage_stats.tier_multiplier_button')}
      </Button>
      <Button variant="secondary" size="sm" onClick={handleOpenSync}>
        {t('usage_stats.price_sync_button')}
      </Button>
    </div>
  );

  return (
    <Card title={t('usage_stats.model_price_settings')} extra={headerActions}>
      <div className={styles.pricingSection}>
        {/* Price Form */}
        <div className={styles.priceForm}>
          <div className={styles.formRow}>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_name')}</label>
              <Select
                value={selectedModel}
                options={options}
                onChange={handleModelSelect}
                placeholder={t('usage_stats.model_price_select_placeholder')}
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_input')} ($/1M)</label>
              <Input
                type="number"
                value={inputPrice}
                onChange={(e) => setInputPrice(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_output')} ($/1M)</label>
              <Input
                type="number"
                value={outputPrice}
                onChange={(e) => setOutputPrice(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_cache_create')} ($/1M)</label>
              <Input
                type="number"
                value={cacheCreatePrice}
                onChange={(e) => setCacheCreatePrice(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_cache_read')} ($/1M)</label>
              <Input
                type="number"
                value={cacheReadPrice}
                onChange={(e) => setCacheReadPrice(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <Button variant="primary" onClick={handleSavePrice} disabled={!selectedModel}>
              {t('common.save')}
            </Button>
          </div>
        </div>

        {/* Saved Prices List */}
        <div className={styles.pricesList}>
          <h4 className={styles.pricesTitle}>{t('usage_stats.saved_prices')}</h4>
          {Object.keys(modelPrices).length > 0 ? (
            <div className={styles.pricesGrid}>
              {Object.entries(modelPrices).map(([model, price]) => (
                <div key={model} className={styles.priceItem}>
                  <div className={styles.priceInfo}>
                    <span className={styles.priceModel}>{model}</span>
                    <div className={styles.priceMeta}>
                      <span>
                        {t('usage_stats.model_price_input')}: ${price.input.toFixed(4)}/1M
                      </span>
                      <span>
                        {t('usage_stats.model_price_output')}: ${price.output.toFixed(4)}/1M
                      </span>
                      <span>
                        {t('usage_stats.model_price_cache_create')}: ${price.cacheCreate.toFixed(4)}/1M
                      </span>
                      <span>
                        {t('usage_stats.model_price_cache_read')}: ${price.cacheRead.toFixed(4)}/1M
                      </span>
                      {price.contextTiers && price.contextTiers.length > 0 && (
                        <span>
                          {t('usage_stats.model_price_context_tier_badge', {
                            count: price.contextTiers.length,
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className={styles.priceActions}>
                    <Button variant="secondary" size="sm" onClick={() => handleOpenEdit(model)}>
                      {t('common.edit')}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => handleDeletePrice(model)}>
                      {t('common.delete')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.hint}>{t('usage_stats.model_price_empty')}</div>
          )}
        </div>
      </div>

      {/* Edit Modal */}
      <Modal
        open={editModel !== null}
        title={editModel ?? ''}
        onClose={() => setEditModel(null)}
        footer={
          <div className={styles.priceActions}>
            <Button variant="secondary" onClick={() => setEditModel(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleSaveEdit}>
              {t('common.save')}
            </Button>
          </div>
        }
        width={560}
      >
        <div className={styles.editModalBody}>
          <div className={styles.formRow}>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_input')} ($/1M)</label>
              <Input
                type="number"
                value={editInput}
                onChange={(e) => setEditInput(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_output')} ($/1M)</label>
              <Input
                type="number"
                value={editOutput}
                onChange={(e) => setEditOutput(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
          </div>
          <div className={styles.formRow}>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_cache_create')} ($/1M)</label>
              <Input
                type="number"
                value={editCacheCreate}
                onChange={(e) => setEditCacheCreate(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_cache_read')} ($/1M)</label>
              <Input
                type="number"
                value={editCacheRead}
                onChange={(e) => setEditCacheRead(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
          </div>

          {/* Context tier prices */}
          <div className={styles.contextTierSection}>
            <div className={styles.contextTierHeader}>
              <span className={styles.pricesTitle}>
                {t('usage_stats.model_price_context_tiers')}
              </span>
              <Button variant="secondary" size="sm" onClick={handleAddTier}>
                {t('usage_stats.model_price_context_tier_add')}
              </Button>
            </div>
            <span className={styles.syncFieldHint}>
              {t('usage_stats.model_price_context_tier_hint')}
            </span>
            {editTiers.map((tier, index) => (
              <div className={styles.formRow} key={index}>
                <div className={styles.formField}>
                  <label>{t('usage_stats.model_price_context_tier_threshold')}</label>
                  <Input
                    type="number"
                    value={tier.threshold}
                    onChange={(e) => handleTierChange(index, 'threshold', e.target.value)}
                    placeholder="200000"
                    step="1"
                    min="0"
                  />
                </div>
                <div className={styles.formField}>
                  <label>{t('usage_stats.model_price_input')}</label>
                  <Input
                    type="number"
                    value={tier.input}
                    onChange={(e) => handleTierChange(index, 'input', e.target.value)}
                    placeholder="0.00"
                    step="0.0001"
                  />
                </div>
                <div className={styles.formField}>
                  <label>{t('usage_stats.model_price_output')}</label>
                  <Input
                    type="number"
                    value={tier.output}
                    onChange={(e) => handleTierChange(index, 'output', e.target.value)}
                    placeholder="0.00"
                    step="0.0001"
                  />
                </div>
                <div className={styles.formField}>
                  <label>{t('usage_stats.model_price_cache_create')}</label>
                  <Input
                    type="number"
                    value={tier.cacheCreate}
                    onChange={(e) => handleTierChange(index, 'cacheCreate', e.target.value)}
                    placeholder="0.00"
                    step="0.0001"
                  />
                </div>
                <div className={styles.formField}>
                  <label>{t('usage_stats.model_price_cache_read')}</label>
                  <Input
                    type="number"
                    value={tier.cacheRead}
                    onChange={(e) => handleTierChange(index, 'cacheRead', e.target.value)}
                    placeholder="0.00"
                    step="0.0001"
                  />
                </div>
                <Button variant="danger" size="sm" onClick={() => handleDeleteTier(index)}>
                  {t('common.delete')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {/* Sync Modal */}
      <Modal
        open={syncOpen}
        title={t('usage_stats.price_sync_title')}
        onClose={() => !syncPending && setSyncOpen(false)}
        closeDisabled={syncPending}
        footer={
          <div className={styles.priceActions}>
            <Button
              variant="secondary"
              onClick={() => setSyncOpen(false)}
              disabled={syncPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="secondary"
              onClick={handleSaveSettingsOnly}
              disabled={syncPending}
            >
              {t('usage_stats.price_sync_save_settings')}
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveAndSync}
              disabled={syncPending}
              loading={syncPending}
            >
              {syncPending
                ? t('usage_stats.price_sync_syncing')
                : t('usage_stats.price_sync_save_and_sync')}
            </Button>
          </div>
        }
        width={540}
      >
        <div className={styles.syncModalBody}>
          <p className={styles.syncDesc}>
            {t('usage_stats.price_sync_desc')}
          </p>

          <div className={styles.syncFieldGroup}>
            <label className={styles.syncFieldLabel}>
              {t('usage_stats.price_sync_provider_priority')}
            </label>
            <span className={styles.syncFieldHint}>
              {t('usage_stats.price_sync_provider_priority_hint')}
            </span>
            <textarea
              className={styles.syncTextarea}
              value={providerPriorityText}
              onChange={(e) => setProviderPriorityText(e.target.value)}
              disabled={syncPending}
              placeholder={'openai\ngoogle\nanthropic'}
              rows={4}
            />
          </div>

          <div className={styles.syncFieldGroup}>
            <label className={styles.syncFieldLabel}>
              {t('usage_stats.price_sync_ignored_suffixes')}
            </label>
            <span className={styles.syncFieldHint}>
              {t('usage_stats.price_sync_ignored_suffixes_hint')}
            </span>
            <textarea
              className={styles.syncTextarea}
              value={ignoredSuffixesText}
              onChange={(e) => setIgnoredSuffixesText(e.target.value)}
              disabled={syncPending}
              placeholder={'-thinking\n-preview\n(thinking)'}
              rows={4}
            />
          </div>

          <div className={styles.syncFieldGroup}>
            <label className={styles.syncFieldLabel}>
              {t('usage_stats.price_sync_model_mappings')}
            </label>
            <span className={styles.syncFieldHint}>
              {t('usage_stats.price_sync_model_mappings_hint')}
            </span>
            <textarea
              className={styles.syncTextarea}
              value={modelMappingsText}
              onChange={(e) => setModelMappingsText(e.target.value)}
              disabled={syncPending}
              placeholder={'coder-model=qwen3.6-plus'}
              rows={4}
            />
          </div>

          {syncStatusMsg && (
            <div className={syncStatusClass}>
              {syncStatusMsg}
            </div>
          )}
        </div>
      </Modal>

      {/* Tier Multiplier Modal */}
      <Modal
        open={tierOpen}
        title={t('usage_stats.tier_multiplier_title')}
        onClose={() => setTierOpen(false)}
        footer={
          <div className={styles.priceActions}>
            <Button variant="secondary" onClick={() => setTierOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleSaveTier}>
              {t('common.save')}
            </Button>
          </div>
        }
        width={560}
      >
        <div className={styles.tierModalBody}>
          <p className={styles.syncDesc}>{t('usage_stats.tier_multiplier_desc')}</p>

          <div className={styles.tierRows}>
            <div className={styles.tierRowHead}>
              <span>{t('usage_stats.tier_multiplier_model')}</span>
              <span>{t('usage_stats.tier_multiplier_tier')}</span>
              <span>{t('usage_stats.tier_multiplier_rate')}</span>
              <span className={styles.tierRowActionCol} />
            </div>

            {tierRows.length === 0 ? (
              <div className={styles.hint}>{t('usage_stats.tier_multiplier_empty')}</div>
            ) : (
              tierRows.map((row, index) => (
                <div className={styles.tierRow} key={index}>
                  <input
                    className="input"
                    value={row.model}
                    onChange={(e) => handleTierRowChange(index, 'model', e.target.value)}
                    placeholder={t('usage_stats.tier_multiplier_model')}
                  />
                  <input
                    className="input"
                    value={row.tier}
                    onChange={(e) => handleTierRowChange(index, 'tier', e.target.value)}
                    placeholder={t('usage_stats.tier_multiplier_tier')}
                  />
                  <input
                    className="input"
                    type="number"
                    step="0.01"
                    min="0"
                    value={row.multiplier}
                    onChange={(e) => handleTierRowChange(index, 'multiplier', e.target.value)}
                    placeholder="1.0"
                  />
                  <Button
                    variant="danger"
                    size="sm"
                    className={styles.tierRowDelete}
                    onClick={() => handleDeleteTierRow(index)}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              ))
            )}
          </div>

          <div className={styles.tierAddRow}>
            <Button variant="secondary" size="sm" onClick={handleAddTierRow}>
              {t('usage_stats.tier_multiplier_add')}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
