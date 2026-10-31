import { describe, expect, test } from 'bun:test';
import { getRequestEventSelection } from '@/components/usage/useRequestEventSelection';

describe('request event selection', () => {
  test('selects all filtered records beyond the 500 rendered rows, excluding missing IDs', () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ backendId: `event-${index}` }));
    const available = getRequestEventSelection([...rows, { backendId: null }], new Set());
    const selected = getRequestEventSelection(rows, available.selectableIds);

    expect(selected.selectedIds.size).toBe(501);
    expect(selected.selectedIds.has('event-500')).toBe(true);
    expect(selected.allSelected).toBe(true);
    expect(selected.indeterminate).toBe(false);
  });

  test('limits deletion to the current filtered list and deduplicates backend IDs', () => {
    const selection = getRequestEventSelection(
      [{ backendId: 'visible' }, { backendId: 'visible' }, { backendId: null }],
      new Set(['visible', 'filtered-out', 'deleted'])
    );

    expect([...selection.selectedIds]).toEqual(['visible']);
    expect(selection.allSelected).toBe(true);
    expect(selection.indeterminate).toBe(false);
  });

  test('keeps stable selections across refreshes and leaves newly arrived events unselected', () => {
    const selection = getRequestEventSelection(
      [{ backendId: 'new-event' }, { backendId: 'selected-event' }],
      new Set(['selected-event', 'removed-event'])
    );

    expect([...selection.selectedIds]).toEqual(['selected-event']);
    expect(selection.allSelected).toBe(false);
    expect(selection.indeterminate).toBe(true);
  });

  test('does not mark an empty or non-deletable list as selected', () => {
    for (const rows of [[], [{ backendId: null }]]) {
      const selection = getRequestEventSelection(rows, new Set(['missing']));
      expect(selection.selectableIds.size).toBe(0);
      expect(selection.selectedIds.size).toBe(0);
      expect(selection.allSelected).toBe(false);
      expect(selection.indeterminate).toBe(false);
    }
  });
});
