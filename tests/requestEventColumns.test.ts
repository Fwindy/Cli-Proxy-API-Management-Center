import { describe, expect, test } from 'bun:test';
import {
  getAvailableRequestEventColumns,
  getVisibleRequestEventColumns,
  normalizeHiddenRequestEventColumns,
  REQUEST_EVENT_COLUMNS,
} from '../src/components/usage/requestEventColumns';

describe('request event column selection', () => {
  test('places response model immediately after request model with the same width', () => {
    const columns = getVisibleRequestEventColumns([], true);
    const requestIndex = columns.findIndex((column) => column.id === 'model');
    expect(columns[requestIndex + 1].id).toBe('responseModel');
    expect(columns[requestIndex + 1].width).toBe(columns[requestIndex].width);
  });

  test('hides only selected columns while keeping the original order', () => {
    const columns = getVisibleRequestEventColumns(['source', 'responseModel', 'tps'], true);
    expect(columns.map((column) => column.id)).toEqual(
      REQUEST_EVENT_COLUMNS.filter(
        (column) => !['source', 'responseModel', 'tps'].includes(column.id)
      ).map((column) => column.id)
    );
  });

  test.each([null, 'model', { model: false }, 42])(
    'uses the default columns for malformed stored preferences: %p',
    (value) => {
      expect(getVisibleRequestEventColumns(value, true)).toEqual(REQUEST_EVENT_COLUMNS);
    }
  );

  test('ignores unknown IDs and deduplicates stored preferences', () => {
    expect(normalizeHiddenRequestEventColumns(['model', 'model', 'unknown', 42], true)).toEqual([
      'model',
    ]);
  });

  test('restores defaults when stored preferences would hide every available column', () => {
    for (const timing of [false, true]) {
      const available = getAvailableRequestEventColumns(timing);
      expect(
        getVisibleRequestEventColumns(
          available.map((column) => column.id),
          timing
        )
      ).toEqual(available);
    }
  });

  test('preserves timing preferences when timing data appears later', () => {
    expect(getVisibleRequestEventColumns(['generation'], false).some((c) => c.id === 'tps')).toBe(
      false
    );
    const columns = getVisibleRequestEventColumns(['generation'], true);
    expect(columns.some((column) => column.id === 'generation')).toBe(false);
    expect(columns.some((column) => column.id === 'tps')).toBe(true);
    expect(columns.some((column) => column.id === 'responseModel')).toBe(true);
  });
});
