import { normalizeApiBase } from '@/utils/connection';

export const USAGE_PLUGIN_ENDPOINT = '/plugins/usage-statistics/usage';

// CPA v8 的插件自定义 HTTP 扩展仍挂载于 /v0/management。
// 在请求拦截器内解析，确保 URL 与认证密钥使用同一连接。
export const resolveUsagePluginUrl = (
  url: string | undefined,
  managementApiBase: string
): string | undefined => {
  if (url !== USAGE_PLUGIN_ENDPOINT || !managementApiBase) return url;

  return `${normalizeApiBase(managementApiBase)}/v0/management${USAGE_PLUGIN_ENDPOINT}`;
};
