import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { apiClient } from '../src/services/api/client';
import { usageApi } from '../src/services/api/usage';

const originalGet = apiClient.get.bind(apiClient);
const originalDelete = apiClient.delete.bind(apiClient);
const requests: InternalAxiosRequestConfig[] = [];
const spies: Array<{ mockRestore(): void }> = [];
const usageResponse = { apis: {} };
const deleteResponse = { deleted: 2 };

const adapter: AxiosAdapter = async (config) => {
  requests.push(config);
  return {
    data: config.method === 'delete' ? deleteResponse : usageResponse,
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  };
};

beforeEach(() => {
  requests.length = 0;
  spies.push(
    spyOn(apiClient, 'get').mockImplementation((url, config) =>
      originalGet(url, { ...config, adapter })
    ),
    spyOn(apiClient, 'delete').mockImplementation((url, config) =>
      originalDelete(url, { ...config, adapter })
    )
  );
});

afterEach(() => {
  spies.splice(0).forEach((spy) => spy.mockRestore());
  apiClient.setConfig({ apiBase: '', managementKey: '' });
});

const connections = [
  ['https://proxy.invalid', 'https://proxy.invalid'],
  ['https://proxy.invalid/gateway/v8/management/', 'https://proxy.invalid/gateway'],
  ['localhost:8317/gateway', 'http://localhost:8317/gateway'],
];

describe('usage-statistics plugin management API', () => {
  test.each(connections)('queries the v0 plugin route for %s', async (apiBase, expectedBase) => {
    apiClient.setConfig({ apiBase, managementKey: 'fixture-only' });
    const params = {
      start: '2026-09-29T17:53:27.492Z',
      end: '2026-09-30T00:53:27.492Z',
    };

    expect(await usageApi.getUsage(params)).toEqual(usageResponse);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    const url = new URL(axios.getUri(request));
    expect(url.searchParams.get('start')).toBe(params.start);
    expect(url.searchParams.get('end')).toBe(params.end);
    url.search = '';
    expect(url.href).toBe(`${expectedBase}/v0/management/plugins/usage-statistics/usage`);
    expect(request.method).toBe('get');
    expect(request.headers.Authorization).toBe('Bearer fixture-only');
    expect(request.timeout).toBe(60_000);
  });

  test.each(connections)(
    'deletes through the v0 plugin route for %s',
    async (apiBase, expectedBase) => {
      apiClient.setConfig({ apiBase, managementKey: 'fixture-only' });
      const ids = ['record-1', 'record-2'];

      expect(await usageApi.deleteUsage(ids)).toEqual(deleteResponse);
      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(axios.getUri(request)).toBe(
        `${expectedBase}/v0/management/plugins/usage-statistics/usage`
      );
      expect(request.method).toBe('delete');
      expect(JSON.parse(request.data)).toEqual({ ids });
      expect(request.headers.Authorization).toBe('Bearer fixture-only');
      expect(request.timeout).toBe(60_000);
    }
  );

  test('keeps core management and plugin administration requests on v8', async () => {
    apiClient.setConfig({
      apiBase: 'https://proxy.invalid/gateway',
      managementKey: 'fixture-only',
    });
    const paths = ['/config', '/plugins', '/plugins/usage-statistics/config'];

    for (const path of paths) {
      await apiClient.get(path);
    }

    expect(requests.map((request) => axios.getUri(request))).toEqual(
      paths.map((path) => `https://proxy.invalid/gateway/v8/management${path}`)
    );
  });

  test.each(['get', 'delete'] as const)(
    'keeps the %s plugin URL and credentials on the same connection when switching servers',
    async (method) => {
      apiClient.setConfig({ apiBase: 'https://first.invalid/gateway', managementKey: 'first-key' });
      const pending = method === 'get' ? usageApi.getUsage() : usageApi.deleteUsage(['record-1']);
      apiClient.setConfig({ apiBase: 'https://second.invalid/edge', managementKey: 'second-key' });
      await pending;

      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(axios.getUri(request)).toBe(
        'https://second.invalid/edge/v0/management/plugins/usage-statistics/usage'
      );
      expect(request.headers.Authorization).toBe('Bearer second-key');
    }
  );
});
