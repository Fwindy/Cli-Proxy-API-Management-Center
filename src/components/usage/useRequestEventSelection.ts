import { useCallback, useEffect, useMemo, useState } from 'react';

interface SelectableRequestEvent {
  backendId: string | null;
}

export function getRequestEventSelection(
  rows: readonly SelectableRequestEvent[],
  selection: ReadonlySet<string>
) {
  const selectableIds = new Set(rows.flatMap((row) => (row.backendId ? [row.backendId] : [])));
  const selectedIds = new Set([...selection].filter((id) => selectableIds.has(id)));

  return {
    selectableIds,
    selectedIds,
    allSelected: selectableIds.size > 0 && selectedIds.size === selectableIds.size,
    indeterminate: selectedIds.size > 0 && selectedIds.size < selectableIds.size,
  };
}

export function useRequestEventSelection(rows: readonly SelectableRequestEvent[]) {
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const state = useMemo(() => getRequestEventSelection(rows, selection), [rows, selection]);

  useEffect(() => {
    setSelection((current) => {
      const { selectedIds } = getRequestEventSelection(rows, current);
      return selectedIds.size === current.size ? current : selectedIds;
    });
  }, [rows]);

  const setRowSelected = (id: string | null, checked: boolean) => {
    if (!id || !state.selectableIds.has(id)) return;
    setSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const setAllSelected = (checked: boolean) => {
    setSelection(checked ? new Set(state.selectableIds) : new Set());
  };

  const clearSelection = useCallback((ids: readonly string[]) => {
    const removed = new Set(ids);
    setSelection((current) => new Set([...current].filter((id) => !removed.has(id))));
  }, []);

  return { ...state, setRowSelected, setAllSelected, clearSelection };
}
