import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { RequestEventsDetailsCard } from '@/components/usage/RequestEventsDetailsCard';
import { RequestEventColumnOptions } from '@/components/usage/RequestEventColumnPicker';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import {
  getAvailableRequestEventColumns,
  getVisibleRequestEventColumns,
  REQUEST_EVENT_COLUMNS_STORAGE_KEY,
} from '@/components/usage/requestEventColumns';

const translations = i18n.cloneInstance({ lng: 'en' });
const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n: translations }, element));

const renderDetails = (hidden: unknown = []) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) =>
          key === REQUEST_EVENT_COLUMNS_STORAGE_KEY ? JSON.stringify(hidden) : null,
      },
    },
  });
  try {
    return render(
      createElement(RequestEventsDetailsCard, {
        usage: {
          apis: {
            'fixture-key': {
              models: {
                'requested-model': {
                  details: [
                    {
                      id: 'fixture-event',
                      timestamp: '2026-10-27T10:00:00Z',
                      response_model: 'upstream-model-20261027',
                      tokens: { input_tokens: 5 },
                    },
                    { timestamp: '2026-10-27T09:00:00Z', tokens: {} },
                  ],
                },
              },
            },
          },
        },
        loading: false,
        geminiKeys: [],
        claudeConfigs: [],
        codexConfigs: [],
        vertexConfigs: [],
        openaiProviders: [],
        authFiles: [],
      })
    );
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
};

const tableMarkup = (html: string) => html.match(/<table\b[^>]*>[\s\S]*?<\/table>/)?.[0] ?? '';
const headers = (html: string) =>
  Array.from(tableMarkup(html).matchAll(/<th\b[^>]*>(.*?)<\/th>/g), (match) => match[1]);

describe('request event details UI', () => {
  test('renders a select-all checkbox and row checkboxes, disabling events without backend IDs', () => {
    const html = renderDetails();
    const table = tableMarkup(html);
    const header = table.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? '';
    const body = table.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';

    expect(header).toContain('type="checkbox"');
    expect(header).toContain('aria-label="Select all filtered events"');
    expect(header).not.toContain('disabled=""');
    expect(body.match(/type="checkbox"/g)).toHaveLength(2);
    expect(body.match(/aria-label="Select request event[^"\n]*"/g)).toHaveLength(2);
    expect(body.match(/disabled=""/g)).toHaveLength(1);
    expect(table).not.toContain('aria-label="Delete request event"');
    expect(html).not.toContain('Delete selected');
  });

  test('exposes a partially selected header checkbox to assistive technology', () => {
    const html = render(
      createElement(SelectionCheckbox, {
        checked: false,
        indeterminate: true,
        onChange: () => {},
        ariaLabel: 'Select all filtered events',
      })
    );
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('aria-checked="mixed"');
  });

  test('renders request and response model headers, values, and an unknown-model placeholder', () => {
    const html = renderDetails();
    expect(headers(html).slice(1, 4)).toEqual(['Timestamp', 'Request Model', 'Response Model']);
    expect(tableMarkup(html)).toContain('upstream-model-20261027');
    expect(tableMarkup(html)).toMatch(
      /title="requested-model">requested-model<\/td><td[^>]*>--<\/td>/
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('Export CSV');
    expect(html).not.toContain('Export JSON');
    expect(html).not.toContain('Clear filters');
    expect(html).not.toContain('17/17');
  });

  test('keeps colgroup, headers, and row cells aligned after selecting columns', () => {
    const html = renderDetails(['source', 'responseModel', 'inputTokens']);
    const table = tableMarkup(html);
    const columnCount = Array.from(table.matchAll(/<col\b/g)).length;
    const headerCount = headers(html).length;
    expect(headers(html)).not.toContain('Response Model');
    expect(table).not.toContain('upstream-model-20261027');
    expect(columnCount).toBe(headerCount);
    const body = table.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
    const rows = Array.from(body.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/g));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Array.from(row[1].matchAll(/<td\b/g))).toHaveLength(headerCount);
    }
  });

  test('provides named checkboxes and protects the last visible data column', () => {
    const columns = getAvailableRequestEventColumns(false);
    const hidden = columns.filter((column) => column.id !== 'model').map((column) => column.id);
    const html = render(
      createElement(RequestEventColumnOptions, {
        columns,
        visibleColumns: getVisibleRequestEventColumns(hidden, false),
        onChange: () => {},
        onReset: () => {},
      })
    );
    expect(html).toContain('role="group" aria-label="Show columns"');
    expect(html).toContain('Response Model');
    expect(
      html.match(/role="menuitemcheckbox" aria-checked="true"[^>]*disabled=""/)?.[0]
    ).toBeDefined();
    expect(html.match(/role="menuitemcheckbox"/g)).toHaveLength(columns.length);
  });
});
