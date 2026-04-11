import { useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import type { ModelPrice } from '@/utils/usage';
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
import styles from '@/pages/UsagePage.module.scss';

export interface PriceSettingsCardProps {
  modelNames: string[];
  modelPrices: Record<string, ModelPrice>;
  onPricesChange: (prices: Record<string, ModelPrice>) => void;
}

type SyncStatusType = 'info' | 'success' | 'error';

export function PriceSettingsCard({
  modelNames,
  modelPrices,
  onPricesChange
}: PriceSettingsCardProps) {
  const { t } = useTranslation();

  // Add form state
  const [selectedModel, setSelectedModel] = useState('');
  const [promptPrice, setPromptPrice] = useState('');
  const [completionPrice, setCompletionPrice] = useState('');
  const [cachePrice, setCachePrice] = useState('');

  // Edit modal state
  const [editModel, setEditModel] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [editCompletion, setEditCompletion] = useState('');
  const [editCache, setEditCache] = useState('');

  // Sync modal state
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncPending, setSyncPending] = useState(false);
  const [syncStatusMsg, setSyncStatusMsg] = useState('');
  const [syncStatusType, setSyncStatusType] = useState<SyncStatusType>('info');
  const [providerPriorityText, setProviderPriorityText] = useState('');
  const [ignoredSuffixesText, setIgnoredSuffixesText] = useState('');
  const [modelMappingsText, setModelMappingsText] = useState('');

  const handleSavePrice = () => {
    if (!selectedModel) return;
    const prompt = parseFloat(promptPrice) || 0;
    const completion = parseFloat(completionPrice) || 0;
    const cache = cachePrice.trim() === '' ? prompt : parseFloat(cachePrice) || 0;
    const newPrices = { ...modelPrices, [selectedModel]: { prompt, completion, cache } };
    onPricesChange(newPrices);
    setSelectedModel('');
    setPromptPrice('');
    setCompletionPrice('');
    setCachePrice('');
  };

  const handleDeletePrice = (model: string) => {
    const newPrices = { ...modelPrices };
    delete newPrices[model];
    onPricesChange(newPrices);
  };

  const handleOpenEdit = (model: string) => {
    const price = modelPrices[model];
    setEditModel(model);
    setEditPrompt(price?.prompt?.toString() || '');
    setEditCompletion(price?.completion?.toString() || '');
    setEditCache(price?.cache?.toString() || '');
  };

  const handleSaveEdit = () => {
    if (!editModel) return;
    const prompt = parseFloat(editPrompt) || 0;
    const completion = parseFloat(editCompletion) || 0;
    const cache = editCache.trim() === '' ? prompt : parseFloat(editCache) || 0;
    const newPrices = { ...modelPrices, [editModel]: { prompt, completion, cache } };
    onPricesChange(newPrices);
    setEditModel(null);
  };

  const handleModelSelect = (value: string) => {
    setSelectedModel(value);
    const price = modelPrices[value];
    if (price) {
      setPromptPrice(price.prompt.toString());
      setCompletionPrice(price.completion.toString());
      setCachePrice(price.cache.toString());
    } else {
      setPromptPrice('');
      setCompletionPrice('');
      setCachePrice('');
    }
  };

  const options = useMemo(
    () => [
      { value: '', label: t('usage_stats.model_price_select_placeholder') },
      ...modelNames.map((name) => ({ value: name, label: name }))
    ],
    [modelNames, t]
  );

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

  const syncButton = (
    <Button variant="secondary" size="sm" onClick={handleOpenSync}>
      {t('usage_stats.price_sync_button')}
    </Button>
  );

  return (
    <Card title={t('usage_stats.model_price_settings')} extra={syncButton}>
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
              <label>{t('usage_stats.model_price_prompt')} ($/1M)</label>
              <Input
                type="number"
                value={promptPrice}
                onChange={(e) => setPromptPrice(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_completion')} ($/1M)</label>
              <Input
                type="number"
                value={completionPrice}
                onChange={(e) => setCompletionPrice(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_cache')} ($/1M)</label>
              <Input
                type="number"
                value={cachePrice}
                onChange={(e) => setCachePrice(e.target.value)}
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
                        {t('usage_stats.model_price_prompt')}: ${price.prompt.toFixed(4)}/1M
                      </span>
                      <span>
                        {t('usage_stats.model_price_completion')}: ${price.completion.toFixed(4)}/1M
                      </span>
                      <span>
                        {t('usage_stats.model_price_cache')}: ${price.cache.toFixed(4)}/1M
                      </span>
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
        width={420}
      >
        <div className={styles.editModalBody}>
          <div className={styles.formField}>
            <label>{t('usage_stats.model_price_prompt')} ($/1M)</label>
            <Input
              type="number"
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              placeholder="0.00"
              step="0.0001"
            />
          </div>
          <div className={styles.formField}>
            <label>{t('usage_stats.model_price_completion')} ($/1M)</label>
            <Input
              type="number"
              value={editCompletion}
              onChange={(e) => setEditCompletion(e.target.value)}
              placeholder="0.00"
              step="0.0001"
            />
          </div>
          <div className={styles.formField}>
            <label>{t('usage_stats.model_price_cache')} ($/1M)</label>
            <Input
              type="number"
              value={editCache}
              onChange={(e) => setEditCache(e.target.value)}
              placeholder="0.00"
              step="0.0001"
            />
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
    </Card>
  );
}
