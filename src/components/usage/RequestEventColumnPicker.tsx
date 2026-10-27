import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconCheck, IconChevronDown, IconSlidersHorizontal } from '@/components/ui/icons';
import type { RequestEventColumn, RequestEventColumnId } from './requestEventColumns';
import { resolveRequestEventColumnMenuPosition } from './requestEventColumnMenu';
import styles from './RequestEventColumnPicker.module.scss';

interface RequestEventColumnPickerProps {
  columns: RequestEventColumn[];
  visibleColumns: RequestEventColumn[];
  onChange: (id: RequestEventColumnId, visible: boolean) => void;
  onReset: () => void;
}

export function RequestEventColumnOptions({
  columns,
  visibleColumns,
  onChange,
  onReset,
}: RequestEventColumnPickerProps) {
  const { t } = useTranslation();
  const visible = new Set(visibleColumns.map((column) => column.id));

  return (
    <>
      <div className={styles.heading}>{t('usage_stats.request_events_columns')}</div>
      <div
        className={styles.options}
        role="group"
        aria-label={t('usage_stats.request_events_columns')}
      >
        {columns.map((column) => {
          const checked = visible.has(column.id);
          const disabled = checked && visible.size === 1;
          return (
            <button
              key={column.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={checked}
              tabIndex={-1}
              className={styles.option}
              onClick={() => onChange(column.id, !checked)}
              disabled={disabled}
              title={disabled ? t('usage_stats.request_events_columns_minimum') : undefined}
            >
              <span className={styles.check} aria-hidden="true">
                {checked && <IconCheck size={13} />}
              </span>
              {t(`usage_stats.${column.labelKey}`)}
            </button>
          );
        })}
      </div>
      <div className={styles.separator} role="separator" />
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className={styles.reset}
        onClick={onReset}
        disabled={visible.size === columns.length}
      >
        {t('usage_stats.request_events_columns_all')}
      </button>
    </>
  );
}

export function RequestEventColumnPicker(props: RequestEventColumnPickerProps) {
  const { t } = useTranslation();
  const menuId = useId();
  const triggerWrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<'first' | 'last'>('first');
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      triggerWrapRef.current?.querySelector('button')?.focus({ preventScroll: true });
    }
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerWrapRef.current;
    if (!trigger) return;
    setPosition(
      resolveRequestEventColumnMenuPosition(trigger.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      })
    );
  }, []);

  const openMenu = (edge: 'first' | 'last' = 'first') => {
    initialFocus.current = edge;
    updatePosition();
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    const item = initialFocus.current === 'last' ? items?.[items.length - 1] : items?.[0];
    (item ?? menuRef.current)?.focus({ preventScroll: true });

    const handleOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerWrapRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const handleScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      updatePosition();
    };
    const observer = new ResizeObserver(updatePosition);
    if (triggerWrapRef.current) observer.observe(triggerWrapRef.current);
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('focusin', handleOutside);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('focusin', handleOutside);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [closeMenu, open, updatePosition]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeMenu(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []
    );
    if (!items.length) return;
    const current = items.findIndex((item) => item === document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus({ preventScroll: true });
    items[next].scrollIntoView({ block: 'nearest' });
  };

  return (
    <div ref={triggerWrapRef} className={styles.wrap}>
      <Button
        variant="secondary"
        size="sm"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu(event.key === 'ArrowUp' ? 'last' : 'first');
          }
        }}
      >
        <IconSlidersHorizontal size={15} />
        {t('usage_stats.request_events_columns')}
        <IconChevronDown size={13} className={styles.chevron} />
      </Button>
      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className={styles.menu}
            style={position}
            role="menu"
            aria-label={t('usage_stats.request_events_columns')}
            tabIndex={-1}
            onKeyDown={handleMenuKeyDown}
          >
            <RequestEventColumnOptions
              {...props}
              onReset={() => {
                props.onReset();
                closeMenu(true);
              }}
            />
          </div>,
          document.body
        )}
    </div>
  );
}
