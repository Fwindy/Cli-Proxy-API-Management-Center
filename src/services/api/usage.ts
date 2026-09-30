/**
 * 使用统计相关 API
 */

import { apiClient } from './client';
import { USAGE_PLUGIN_ENDPOINT } from './usagePluginRoute';
import { computeKeyStats, normalizeUsageData, type KeyStats, type UsageDeleteResponse, type UsageQueryRange } from '@/utils/usage';

const USAGE_TIMEOUT_MS = 60 * 1000;

export const usageApi = {
  /**
   * 获取使用统计原始数据
   */
  getUsage: (params?: UsageQueryRange) =>
    apiClient.get<Record<string, unknown>>(USAGE_PLUGIN_ENDPOINT, { timeout: USAGE_TIMEOUT_MS, params }),

  /**
   * 删除指定 usage 记录
   */
  deleteUsage: (ids: string[]) =>
    apiClient.delete<UsageDeleteResponse>(USAGE_PLUGIN_ENDPOINT, {
      timeout: USAGE_TIMEOUT_MS,
      data: { ids },
    }),

  /**
   * 计算密钥成功/失败统计，必要时会先获取 usage 数据
   */
  async getKeyStats(usageData?: unknown): Promise<KeyStats> {
    let payload = usageData;
    if (!payload) {
      payload = await usageApi.getUsage();
    }
    return computeKeyStats(normalizeUsageData(payload));
  }
};
